// -----------------------------------------------------------------------------
// Renderer state store — dependency-free, built on React's useSyncExternalStore.
//
// VOCABULARY MAPPING (design handoff "branch" model  ->  engine node-tree model)
// The design talks about "branches"; the engine models everything as a tree
// of MessageNodes with parent_id links. The map is:
//   • a "branch"      == a leaf node (the end of a root->leaf path).
//   • the "path"      == the root->leaf node chain (activePath()), used for the
//                        breadcrumb strip and to mark tree rows on-path.
//   • a "fork point"  == a node with > 1 child (forkPoints() restricts to those
//                        on the active path; the design's inline fork markers).
//   • "siblings"      == children that share the same parent_id (siblingsOf()),
//                        i.e. the alternatives at a fork.
//   • "active branch" == activeLeafId; switching branch == api.switchBranch then
//                        re-pointing activeLeafId ("Switch branch").
//
// The store owns view state (some persisted to localStorage) plus the loaded
// ConversationTree, and integrates streaming (onTurnEvent) by appending
// deltas into the in-memory node's content and re-rendering.
// -----------------------------------------------------------------------------
import { useSyncExternalStore } from 'react';
import { api } from '../api';
import type {
  Attachment,
  ConversationSummary,
  ConversationTree,
  MessageNode,
  PermissionMode,
} from '@shared/types';

// ---- localStorage keys (view prefs persisted per-user) ----------------------
const LS_EXPANDED = 'bc.expandedNodes';
const LS_TREE_VISIBLE = 'bc.branchTreeVisible';
const LS_PERMISSION = 'bc.permissionMode';

// ---- Internal store state shape ---------------------------------------------
interface StoreState {
  // view state
  activeConversationId: string | null;
  activeLeafId: string | null;
  expandedNodes: Set<string>;
  branchTreeVisible: boolean;
  openDropdownId: string | null;
  permissionMode: PermissionMode; // 'ask' (default) | 'act' (skip permissions)
  // Draft branch ("Fork from here"): a pending new branch. `mode` decides how
  // the first sent message attaches:
  //   • 'child'    — new user turn under baseId (sibling of an existing
  //                  continuation, or a re-ask). Shares history via the tree.
  //   • 'forkLeaf' — fork a leaf answer: snapshot it and start the branch under
  //                  the snapshot (sourceId = the leaf assistant), keeping the
  //                  original answer as its own branch.
  // No DB write / no Claude call until the first message is sent.
  fork: { baseId: string | null; mode: 'child' | 'forkLeaf'; sourceId?: string } | null;
  // data
  tree: ConversationTree | null;
  conversations: ConversationSummary[];
  // Transient: maps assistantNodeId -> current activity label during streaming.
  // Cleared when the activity ends or the turn finishes.
  streamActivity: Map<string, string>;
}

// ---------------------------------------------------------------------------
// localStorage helpers (best-effort; failures fall back to defaults).
// ---------------------------------------------------------------------------
function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_EXPANDED);
    if (raw) return new Set<string>(JSON.parse(raw) as string[]);
  } catch {
    /* ignore corrupt/blocked storage */
  }
  return new Set<string>();
}

function persistExpanded(set: Set<string>): void {
  try {
    localStorage.setItem(LS_EXPANDED, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

function loadTreeVisible(): boolean {
  try {
    const raw = localStorage.getItem(LS_TREE_VISIBLE);
    if (raw !== null) return raw === 'true';
  } catch {
    /* ignore */
  }
  return true; // default: tree shown
}

function persistTreeVisible(v: boolean): void {
  try {
    localStorage.setItem(LS_TREE_VISIBLE, String(v));
  } catch {
    /* ignore */
  }
}

function loadPermission(): PermissionMode {
  try {
    return localStorage.getItem(LS_PERMISSION) === 'act' ? 'act' : 'ask';
  } catch {
    return 'ask';
  }
}

// ---------------------------------------------------------------------------
// The store singleton: state + subscriber set for useSyncExternalStore.
// We keep state immutable-by-reference: every mutation produces a NEW `state`
// object (and new Set when needed) so React re-renders reliably.
// ---------------------------------------------------------------------------
let state: StoreState = {
  activeConversationId: null,
  activeLeafId: null,
  expandedNodes: loadExpanded(),
  branchTreeVisible: loadTreeVisible(),
  openDropdownId: null,
  permissionMode: loadPermission(),
  fork: null,
  tree: null,
  conversations: [],
  streamActivity: new Map(),
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Shallow-merge a partial into state and notify subscribers. */
function setState(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): StoreState {
  return state;
}

/** Debug: returns the current raw store state. Exposed as window.__store() in dev. */
export function getState(): StoreState {
  return state;
}

// ---------------------------------------------------------------------------
// Tree helpers (operate on a node array). Pure functions so selectors below and
// streaming integration can reuse them.
// ---------------------------------------------------------------------------
function nodeMap(nodes: MessageNode[]): Map<string, MessageNode> {
  const m = new Map<string, MessageNode>();
  for (const n of nodes) m.set(n.id, n);
  return m;
}

/** Walk parent_id from `leafId` up to the root; return root->leaf order. */
function pathToLeaf(nodes: MessageNode[], leafId: string | null): MessageNode[] {
  if (!leafId) return [];
  const m = nodeMap(nodes);
  const chain: MessageNode[] = [];
  let cur = m.get(leafId) ?? null;
  // Guard against cycles (shouldn't happen) with a visited set.
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parent_id ? m.get(cur.parent_id) ?? null : null;
  }
  return chain.reverse(); // root first
}

function childrenOfRaw(nodes: MessageNode[], parentId: string | null): MessageNode[] {
  return nodes
    .filter((n) => n.parent_id === parentId)
    .sort((a, b) => a.created_at - b.created_at);
}

/**
 * How many branches diverge AT an assistant answer — a property of the tree, not
 * of the current view (so it never changes just because you switched branches or
 * stepped back onto the fork itself). Two divergence shapes:
 *   • continuation fork: the answer has >1 follow-up child  -> that child count.
 *   • answer fork (regenerate / leaf-fork): the answer has sibling answers under
 *     the same question -> this answer + its siblings.
 * Returns 0 when the node isn't a divergence point. The two shapes don't co-occur
 * in normal flows; continuation takes precedence.
 */
function branchesAtRaw(nodes: MessageNode[], nodeId: string): number {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return 0;
  const children = childrenOfRaw(nodes, nodeId);
  if (children.length > 1) return children.length;
  const siblings = childrenOfRaw(nodes, node.parent_id).filter((s) => s.id !== nodeId);
  if (siblings.length > 0) return siblings.length + 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Streaming integration: append deltas into the in-memory node, re-render, and
// finalize on done/error. Implements onTurnEvent consumption (latency
// is handled in preload; here we just merge deltas into the tree).
// ---------------------------------------------------------------------------
function patchNode(nodeId: string, mutate: (n: MessageNode) => MessageNode): void {
  if (!state.tree) return;
  const nodes = state.tree.nodes;
  const idx = nodes.findIndex((n) => n.id === nodeId);
  if (idx === -1) return;
  const nextNodes = nodes.slice();
  nextNodes[idx] = mutate(nextNodes[idx]);
  setState({ tree: { ...state.tree, nodes: nextNodes } });
}

function subscribeToTurn(assistantNodeId: string): void {
  // The handler auto-unsubscribes after done/error (per BridgeApi contract).
  api.onTurnEvent(assistantNodeId, (event) => {
    switch (event.type) {
      case 'delta':
        patchNode(assistantNodeId, (n) => ({
          ...n,
          status: 'streaming',
          content: n.content + event.textDelta,
        }));
        break;
      case 'activity': {
        const next = new Map(state.streamActivity);
        if (event.active && event.label) {
          next.set(assistantNodeId, event.label);
        } else {
          next.delete(assistantNodeId);
        }
        setState({ streamActivity: next });
        break;
      }
      case 'done': {
        patchNode(assistantNodeId, (n) => ({
          ...n,
          status: 'complete',
          content: event.content, // authoritative final text
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
          cost_usd: event.usage.costUsd,
          completed_at: Date.now(),
        }));
        // Clear any lingering activity indicator.
        if (state.streamActivity.has(assistantNodeId)) {
          const next = new Map(state.streamActivity);
          next.delete(assistantNodeId);
          setState({ streamActivity: next });
        }
        // Refresh authoritative tree + summaries from the DB after completion.
        void refreshTree();
        void refreshConversations();
        break;
      }
      case 'error': {
        patchNode(assistantNodeId, (n) => ({
          ...n,
          status: 'error',
          error_text: event.message,
          completed_at: Date.now(),
        }));
        // Clear any lingering activity indicator.
        if (state.streamActivity.has(assistantNodeId)) {
          const next = new Map(state.streamActivity);
          next.delete(assistantNodeId);
          setState({ streamActivity: next });
        }
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Data loading / refresh.
// ---------------------------------------------------------------------------
async function refreshConversations(): Promise<void> {
  const list = await api.listConversations();
  setState({ conversations: list });
}

async function refreshTree(): Promise<void> {
  if (!state.activeConversationId) return;
  const tree = await api.getConversation(state.activeConversationId);
  // Keep the current active leaf if still valid, else fall back to DB's value.
  const stillValid =
    state.activeLeafId && tree.nodes.some((n) => n.id === state.activeLeafId);
  setState({
    tree,
    activeLeafId: stillValid ? state.activeLeafId : tree.conversation.active_leaf,
  });
  void backfillBranchTitles();
}

// --- Branch auto-titling -----------------------------------------------------
// Branch-head nodes (children of a fork) get a short, LLM-generated title so the
// tree/breadcrumb read like the design ("Cosine schedule alt") instead of the
// raw first message. We only title heads whose first message is long enough to
// warrant summarizing; short heads (e.g. "β scaling") already read well.
const titleRequested = new Set<string>();

function firstUserContent(head: MessageNode, nodes: MessageNode[]): string {
  let cur: MessageNode | undefined = head;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    if (cur.role === 'user' && cur.content.trim()) return cur.content;
    seen.add(cur.id);
    const kids = childrenOfRaw(nodes, cur.id);
    cur = kids.length === 1 ? kids[0] : undefined;
  }
  return head.content;
}

async function backfillBranchTitles(): Promise<void> {
  const tree = state.tree;
  if (!tree) return;
  const nodes = tree.nodes;
  const heads = nodes.filter((n) => {
    if (!n.parent_id) return false; // root isn't shown as a branch row
    const siblings = nodes.filter((x) => x.parent_id === n.parent_id);
    const head = firstUserContent(n, nodes);
    return (
      siblings.length > 1 && // an actual fork
      !(n.title && n.title.trim()) &&
      !titleRequested.has(n.id) &&
      head.trim().length > 30 // long enough to be worth summarizing
    );
  });
  if (heads.length === 0) return;
  await Promise.all(
    heads.map(async (h) => {
      titleRequested.add(h.id);
      try {
        await api.generateNodeTitle({ nodeId: h.id, text: firstUserContent(h, nodes) });
      } catch {
        /* leave untitled; UI falls back to the derived label */
      }
    })
  );
  // Pull the freshly-written titles back into the view.
  if (state.activeConversationId) {
    const fresh = await api.getConversation(state.activeConversationId);
    const stillValid =
      state.activeLeafId && fresh.nodes.some((n) => n.id === state.activeLeafId);
    setState({
      tree: fresh,
      activeLeafId: stillValid ? state.activeLeafId : fresh.conversation.active_leaf,
    });
  }
}

// ---------------------------------------------------------------------------
// Actions (exported via the hook). Each mutating turn action returns the
// assistant node id (or null) so callers can drive focus/scroll if desired.
// ---------------------------------------------------------------------------
async function loadConversations(): Promise<void> {
  await refreshConversations();
}

/** Open the most-recently-updated conversation if none is active (startup). */
async function openMostRecent(): Promise<void> {
  if (state.activeConversationId) return;
  const first = state.conversations[0];
  if (first) await openConversation(first.id);
}

async function openConversation(id: string): Promise<void> {
  const tree = await api.getConversation(id);
  setState({
    activeConversationId: id,
    activeLeafId: tree.conversation.active_leaf,
    tree,
    openDropdownId: null,
    fork: null,
  });
  void backfillBranchTitles();
}

/** Switch the active branch ("Switch branch"): persist then re-point. */
async function switchLeaf(leafId: string): Promise<void> {
  if (!state.activeConversationId) return;
  await api.switchBranch({ conversationId: state.activeConversationId, leafId });
  setState({ activeLeafId: leafId, openDropdownId: null, fork: null });
}

function toggleExpand(nodeId: string): void {
  const next = new Set(state.expandedNodes);
  if (next.has(nodeId)) next.delete(nodeId);
  else next.add(nodeId);
  persistExpanded(next);
  setState({ expandedNodes: next });
}

function toggleTree(): void {
  const next = !state.branchTreeVisible;
  persistTreeVisible(next);
  setState({ branchTreeVisible: next });
}

function setOpenDropdown(id: string | null): void {
  setState({ openDropdownId: id });
}

/**
 * Append a new turn under the active leaf ("Append turn"). The main process
 * inserts the user node and a streaming assistant node; we subscribe to the
 * assistant stream, then advance the active leaf to it.
 */
async function sendTurn(content: string): Promise<string | null> {
  if (!state.activeConversationId) return null;
  const f = state.fork;
  let res;
  if (f && f.mode === 'forkLeaf' && f.sourceId) {
    // Leaf fork: snapshot the answer + start the new branch under the snapshot
    // (keeps the original answer as its own branch; shares full history).
    res = await api.forkLeaf({
      leafAssistantId: f.sourceId,
      content,
      permissionMode: state.permissionMode,
    });
  } else {
    res = await api.sendTurn({
      conversationId: state.activeConversationId,
      parentId: state.activeLeafId, // null => new root user node
      content,
      permissionMode: state.permissionMode,
    });
  }
  await refreshTree(); // pick up the newly-inserted user + streaming nodes
  setState({ activeLeafId: res.assistantNodeId, fork: null }); // draft committed
  subscribeToTurn(res.assistantNodeId);
  return res.assistantNodeId;
}

/**
 * Regenerate an assistant turn ("Regenerate"): a new assistant sibling
 * under the same user parent. The new assistant node becomes the active leaf.
 */
async function regenerate(assistantNodeId: string): Promise<string | null> {
  const res = await api.regenerate({ assistantNodeId, permissionMode: state.permissionMode });
  await refreshTree();
  setState({ activeLeafId: res.assistantNodeId });
  subscribeToTurn(res.assistantNodeId);
  return res.assistantNodeId;
}

/**
 * Edit a user turn ("Edit user turn"): a new user sibling under the edited
 * node's parent with revised content, then generate. The original subtree is
 * retained. Active leaf advances to the freshly generated assistant node.
 */
async function editUser(userNodeId: string, content: string): Promise<string | null> {
  const res = await api.editUser({ userNodeId, content, permissionMode: state.permissionMode });
  await refreshTree();
  setState({ activeLeafId: res.assistantNodeId });
  subscribeToTurn(res.assistantNodeId);
  return res.assistantNodeId;
}

/**
 * Fork from a node (design "Fork from here"; engine "Branch from node N").
 *
 * Forking does NOT generate anything — it just repositions you to this point so
 * your NEXT message starts a new branch (a sibling of whatever currently follows
 * this node). The new branch materializes when you send. We never re-prompt.
 *
 *   • Fork from an ASSISTANT message: set the active leaf to that assistant
 *     node, so the next reply continues from this answer in a new direction
 *     (a sibling of the existing follow-up user turn, if any).
 *   • Fork from a USER message: set the active leaf to its PARENT (assistant, or
 *     null at the root), so the next message is a sibling user turn — i.e. you
 *     re-ask differently at this point (a user node's parent must be an
 *     assistant or null).
 *
 * The composer auto-focuses on activeLeafId change, so it's ready to type into.
 */
function forkFrom(nodeId: string): void {
  const tree = state.tree;
  if (!tree) return;
  const nodes = tree.nodes;
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return;

  // The new branch is a sibling user turn attached under `base`. The next send
  // creates it (a user turn's parent is an assistant or null). We choose
  // `base` so a REAL fork (≥2 children at that point) is always created:
  //
  //   • Assistant WITH a continuation (mid-conversation): base = that assistant,
  //     so the new turn is a sibling of the existing follow-up — diverge AFTER
  //     this answer, keeping it.
  //   • Assistant with NO continuation (the leaf) OR a user message: branch at
  //     the prompting question instead — base = the user turn's parent — so the
  //     new turn is a sibling of that question. This is the key fix: forking the
  //     last message used to just append (no sibling => no branch).
  //
  // No DB write / no Claude call happens here; this only arms the draft.
  if (node.role === 'assistant') {
    if (childrenOfRaw(nodes, node.id).length > 0) {
      // Mid-conversation answer: the new turn is a child of it (a sibling of the
      // existing follow-up) -> a real fork sharing root->this answer.
      setState({
        activeLeafId: node.id,
        fork: { baseId: node.id, mode: 'child' },
        openDropdownId: null,
      });
    } else {
      // Leaf answer: snapshot it so the original stays its own branch; the new
      // branch starts under the snapshot. View shows up to this answer.
      setState({
        activeLeafId: node.id,
        fork: { baseId: node.id, mode: 'forkLeaf', sourceId: node.id },
        openDropdownId: null,
      });
    }
  } else {
    // User turn: the new turn is a sibling (re-ask differently at this point).
    setState({
      activeLeafId: node.parent_id,
      fork: { baseId: node.parent_id, mode: 'child' },
      openDropdownId: null,
    });
  }
}

/** Deepest descendant of `id` by always following the first child. */
/**
 * Descend from `id` to the leaf of its branch by always following the first
 * child — the canonical "head of this branch" leaf. Pure so the breadcrumb /
 * tree navigators and cancelFork can all share one definition.
 */
function deepestLeafRaw(nodes: MessageNode[], id: string | null): string | null {
  if (!id) return id;
  let cur = id;
  const seen = new Set<string>([cur]);
  let kids = childrenOfRaw(nodes, cur);
  while (kids.length > 0 && !seen.has(kids[0].id)) {
    cur = kids[0].id;
    seen.add(cur);
    kids = childrenOfRaw(nodes, cur);
  }
  return cur;
}

function deepestDescendant(id: string | null): string | null {
  if (!id || !state.tree) return id;
  return deepestLeafRaw(state.tree.nodes, id);
}

/** Abandon a draft branch and return to the branch we forked from. */
function cancelFork(): void {
  if (!state.fork) return;
  const restore = deepestDescendant(state.fork.baseId) ?? state.tree?.conversation.active_leaf ?? null;
  setState({ fork: null, activeLeafId: restore });
}

/**
 * Abort the in-flight turn for a streaming node ("Stop"). The main process kills
 * the child (SIGTERM→SIGKILL) and keeps whatever partial content was produced,
 * marking the node complete; we refresh to pick up that final state.
 */
async function abortTurn(nodeId: string): Promise<void> {
  await api.abortTurn({ nodeId });
  await refreshTree();
}

/** Delete a node and its subtree (cascade). Confirmation is the UI's job. */
async function deleteNode(nodeId: string): Promise<void> {
  await api.deleteNode({ nodeId });
  await refreshTree();
  await refreshConversations();
}

/** Delete the whole active conversation; clears the view if it was open. */
async function deleteConversation(id: string): Promise<void> {
  await api.deleteConversation(id);
  if (state.activeConversationId === id) {
    setState({ activeConversationId: null, activeLeafId: null, tree: null });
  }
  await refreshConversations();
}

/** Rename the active conversation and refresh title surfaces. */
async function renameConversation(id: string, title: string): Promise<void> {
  await api.renameConversation({ id, title });
  await refreshTree();
  await refreshConversations();
}

/** Set the conversation's default model (persisted) and refresh the tree. */
async function setModel(model: string | null): Promise<void> {
  if (!state.activeConversationId) return;
  await api.setModel({ id: state.activeConversationId, model });
  await refreshTree();
}

/**
 * Open the OS file picker, attach each chosen file's directory to the
 * conversation (so the model can actually read it), and return the
 * selected absolute paths for the composer to reference in the prompt.
 */
async function attachFiles(): Promise<string[]> {
  if (!state.activeConversationId) return [];
  const files = await api.pickFiles();
  for (const f of files) {
    const dir = f.replace(/[/\\][^/\\]*$/, '') || '/';
    try {
      await api.addAttachment({
        conversationId: state.activeConversationId,
        nodeId: null, // applies to the whole conversation
        dirPath: dir,
      });
    } catch {
      /* ignore a dir that fails validation; the path still goes in the prompt */
    }
  }
  return files;
}

/** Persist the permission posture (Ask vs Act-without-asking) for new turns. */
function setPermissionMode(mode: PermissionMode): void {
  try {
    localStorage.setItem(LS_PERMISSION, mode);
  } catch {
    /* ignore */
  }
  setState({ permissionMode: mode });
}

/**
 * The node a folder should be scoped to (the working dir for Claude's spawn):
 *  - null  => save at the CONVERSATION level (linear / main line; applies to all
 *             turns) — node_id NULL.
 *  - <id>  => save at the BRANCH level (the head of the current forked branch),
 *             so sibling branches can use different folders.
 */
function currentBranchHeadId(): string | null {
  if (!state.tree) return null;
  const path = pathToLeaf(state.tree.nodes, state.activeLeafId);
  if (path.length === 0) return null;
  // The last fork point on the path (a node with >1 child).
  let lastForkIndex = -1;
  for (let i = 0; i < path.length; i++) {
    if (childrenOfRaw(state.tree.nodes, path[i].id).length > 1) lastForkIndex = i;
  }
  if (lastForkIndex === -1) return null; // linear -> conversation level
  // The branch head is the on-path child of that fork (next node on the path).
  return path[lastForkIndex + 1]?.id ?? null;
}

/**
 * Attach a folder (the directory Claude is spawned in) to the current
 * conversation or branch. Saved at the conversation level on the main line, or at
 * the branch head when on a forked branch.
 */
async function addFolder(): Promise<void> {
  if (!state.activeConversationId) return;
  const dir = await api.pickDirectory();
  if (!dir) return;
  await api.addAttachment({
    conversationId: state.activeConversationId,
    nodeId: currentBranchHeadId(),
    dirPath: dir,
  });
  await refreshTree();
}

/** Remove a previously-attached folder. */
async function removeFolder(attachmentId: string): Promise<void> {
  await api.removeAttachment({ attachmentId });
  await refreshTree();
}

// ---------------------------------------------------------------------------
// The public hook. Returns the live state snapshot, derived selectors, and
// actions. Selectors are computed from the current `nodes` + `activeLeafId`.
// ---------------------------------------------------------------------------
export function useStore() {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  const nodes = snap.tree?.nodes ?? [];

  // --- selectors (recomputed per render against the live snapshot) ---
  const activePath = (): MessageNode[] => pathToLeaf(nodes, snap.activeLeafId);

  const childrenOf = (nodeId: string | null): MessageNode[] =>
    childrenOfRaw(nodes, nodeId);

  const siblingsOf = (nodeId: string): MessageNode[] => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return [];
    return childrenOfRaw(nodes, node.parent_id);
  };

  const onPathIds = new Set(activePath().map((n) => n.id));
  const isOnPath = (nodeId: string): boolean => onPathIds.has(nodeId);

  // Fork points: nodes on the active path that have > 1 child.
  const forkPoints = (): MessageNode[] =>
    activePath().filter((n) => childrenOfRaw(nodes, n.id).length > 1);

  // Total branches diverging at a node (tree property, view-independent).
  const branchesAt = (nodeId: string): number => branchesAtRaw(nodes, nodeId);

  // Leaf at the head of the branch rooted at a node (follow first child down).
  const deepestLeaf = (nodeId: string): string => deepestLeafRaw(nodes, nodeId) ?? nodeId;

  // Folders effective on the current branch: conversation-level (node_id null)
  // plus any attached to a node on the active path (ancestor-or-self).
  const branchFolders = (): Attachment[] => {
    const atts = snap.tree?.attachments ?? [];
    return atts.filter((a) => a.node_id === null || onPathIds.has(a.node_id));
  };

  return {
    // --- state ---
    activeConversationId: snap.activeConversationId,
    activeLeafId: snap.activeLeafId,
    expandedNodes: snap.expandedNodes,
    branchTreeVisible: snap.branchTreeVisible,
    openDropdownId: snap.openDropdownId,
    permissionMode: snap.permissionMode,
    fork: snap.fork,
    tree: snap.tree,
    nodes,
    conversations: snap.conversations,
    streamActivity: snap.streamActivity,

    // --- selectors ---
    activePath,
    childrenOf,
    siblingsOf,
    isOnPath,
    forkPoints,
    branchesAt,
    deepestLeaf,
    branchFolders,

    // --- actions ---
    loadConversations,
    openConversation,
    openMostRecent,
    switchLeaf,
    toggleExpand,
    toggleTree,
    setOpenDropdown,
    sendTurn,
    regenerate,
    editUser,
    forkFrom,
    cancelFork,
    abortTurn,
    deleteNode,
    deleteConversation,
    renameConversation,
    setModel,
    attachFiles,
    addFolder,
    removeFolder,
    setPermissionMode,
  };
}

// ---------------------------------------------------------------------------
// Test-only handle: lets tests drive the real store actions without a React
// render (the actions are otherwise reachable only through useStore()). Not
// imported by any production code path. See test/fork-e2e.test.ts.
// ---------------------------------------------------------------------------
export const __test = {
  getState,
  openConversation,
  sendTurn,
  regenerate,
  editUser,
  forkFrom,
  cancelFork,
  switchLeaf,
  deleteNode,
  abortTurn,
  branchesAt: (nodeId: string): number => branchesAtRaw(state.tree?.nodes ?? [], nodeId),
  deepestLeaf: (nodeId: string): string =>
    deepestLeafRaw(state.tree?.nodes ?? [], nodeId) ?? nodeId,
};
