// IPC handlers — the UI seam (the IPC contract).
//
// Registers one ipcMain.handle for every channel in the shared IPC const, wires
// each to the appropriate Repo / ClaudeRunner / dialog operation, and drives the
// per-turn streaming pipeline over a MessageChannelMain port (token deltas
// reach the renderer with sub-50ms added latency, avoiding per-token IPC
// serialization through webContents.send).
//
// All privileged work (DB, subprocess, filesystem, dialog) lives here in the main
// process; the renderer only invokes these channels.

import { ipcMain, dialog, MessageChannelMain, type BrowserWindow } from 'electron';
import { IPC } from '@shared/types';
import type {
  EngineStatus,
  StreamEvent,
  CreateConversationArgs,
  RenameConversationArgs,
  SendTurnArgs,
  RegenerateArgs,
  EditUserArgs,
  ForkLeafArgs,
  AbortArgs,
  SwitchBranchArgs,
  DeleteNodeArgs,
  AddAttachmentArgs,
  RemoveAttachmentArgs,
  TurnStarted,
  ConversationSummary,
  ConversationTree,
  SearchResult,
} from '@shared/types';
import type { Repo } from '../db/repo.js';
import type { ClaudeRunner } from '../claude/runner.js';
import type { TurnResult } from '../claude/parser.js';
import { validateDir, neutralTempDir } from '../paths.js';
import { generateTitle } from '../claude/title.js';
import { validateClaudePath } from '../claude/resolve.js';

/** Dependencies the IPC layer composes against (injected from index.ts). */
export interface IpcDeps {
  repo: Repo;
  runner: ClaudeRunner;
  engineStatus: () => EngineStatus;
  setEngineStatus: (status: EngineStatus) => void;
  getWindow: () => BrowserWindow | null;
}

/**
 * Register every IPC channel from the shared `IPC` const.
 *
 * Command channels (renderer -> main, awaitable) map directly to Repo methods;
 * the turn-starting channels additionally kick off generation and hand the
 * renderer a streaming MessagePort (see startTurn).
 */
export function registerIpcHandlers(deps: IpcDeps): void {
  const { repo, runner, engineStatus, getWindow } = deps;

  // -- Conversations -------------------------------------------------------

  ipcMain.handle(
    IPC.conversationCreate,
    (_e, args: CreateConversationArgs): string =>
      repo.createConversation({ title: args.title, model: args.model })
  );

  ipcMain.handle(
    IPC.conversationList,
    (): ConversationSummary[] => repo.listConversations()
  );

  ipcMain.handle(
    IPC.conversationGet,
    (_e, id: string): ConversationTree => repo.getConversation(id)
  );

  ipcMain.handle(
    IPC.conversationRename,
    (_e, args: RenameConversationArgs): void =>
      repo.renameConversation(args.id, args.title)
  );

  ipcMain.handle(IPC.conversationDelete, (_e, id: string): void =>
    repo.deleteConversation(id)
  );

  ipcMain.handle(
    IPC.conversationSetModel,
    (_e, args: { id: string; model: string | null }): void =>
      repo.setModel(args.id, args.model)
  );

  ipcMain.handle(
    IPC.conversationSearch,
    (_e, query: string): SearchResult[] => repo.searchConversations(query)
  );

  // node:generateTitle — auto-name a branch (handoff open-question 1). Summarize
  // the branch's first user message via a one-shot claude call and persist it on
  // the branch-head node. Returns the title (or null on failure; UI falls back).
  ipcMain.handle(
    IPC.nodeGenerateTitle,
    async (_e, args: { nodeId: string; text: string }): Promise<string | null> => {
      const node = repo.getNode(args.nodeId);
      if (!node) return null;
      const path = engineStatus().claudePath;
      if (!path) return null;
      const title = await generateTitle(path, args.text);
      if (title) repo.setNodeTitle(args.nodeId, title);
      return title;
    }
  );

  // -- Turns (generation) --------------------------------------------------

  // turn:send (append / branch). parentId may be null => this turn's user
  // node is the conversation root.
  ipcMain.handle(
    IPC.turnSend,
    (_e, args: SendTurnArgs): TurnStarted => {
      const userNode = repo.insertUserNode({
        conversationId: args.conversationId,
        parentId: args.parentId,
        content: args.content,
      });
      // Auto-title: the very first user turn (root) names an untitled
      // conversation from its content (handoff open-question 1). Avoids the
      // "Untitled conversation everywhere" problem; rename stays available.
      const convo = repo.getConversationRow(args.conversationId);
      if (args.parentId === null && convo && !convo.title.trim()) {
        repo.renameConversation(args.conversationId, makeTitle(args.content));
      }
      // Model precedence: explicit per-turn override, else the
      // conversation's saved default, else the runner's built-in default.
      const model = args.model ?? convo?.model ?? null;
      const assistant = repo.insertStreamingAssistant({
        conversationId: args.conversationId,
        parentId: userNode.id,
        model,
      });
      startTurn(deps, {
        userNodeId: userNode.id,
        assistantNodeId: assistant.id,
        model,
        skipPermissions: args.permissionMode === 'act',
      });
      return { assistantNodeId: assistant.id, userNodeId: userNode.id };
    }
  );

  // turn:regenerate: new assistant sibling under the same user
  // parent as an existing assistant node, generated against that parent's thread.
  ipcMain.handle(
    IPC.turnRegenerate,
    (_e, args: RegenerateArgs): TurnStarted => {
      const oldAssistant = repo.getNode(args.assistantNodeId);
      if (!oldAssistant || oldAssistant.role !== 'assistant') {
        throw new Error(`Assistant node not found: ${args.assistantNodeId}`);
      }
      if (oldAssistant.parent_id === null) {
        throw new Error('Assistant node has no user parent to regenerate from');
      }
      const userParentId = oldAssistant.parent_id;
      // Model: explicit override, else reuse the old assistant's model.
      const model = args.model ?? oldAssistant.model ?? null;
      const assistant = repo.insertStreamingAssistant({
        conversationId: oldAssistant.conversation_id,
        parentId: userParentId,
        model,
      });
      // The thread is reconstructed from the USER parent, which already
      // ends on the new user turn (no new user node for regenerate).
      startTurn(deps, {
        userNodeId: userParentId,
        assistantNodeId: assistant.id,
        model,
        skipPermissions: args.permissionMode === 'act',
      });
      return { assistantNodeId: assistant.id };
    }
  );

  // turn:forkLeaf (branch from a leaf): snapshot the leaf answer into a
  // sibling and start a new branch under it, so the original answer remains its
  // own branch and the new branch shares the full prior history (fork at the
  // question). The original subtree is retained.
  ipcMain.handle(
    IPC.turnForkLeaf,
    (_e, args: ForkLeafArgs): TurnStarted => {
      const leaf = repo.getNode(args.leafAssistantId);
      if (!leaf || leaf.role !== 'assistant') {
        throw new Error(`Leaf assistant not found: ${args.leafAssistantId}`);
      }
      const model = args.model ?? leaf.model ?? null;
      const { userNodeId } = repo.forkLeafAssistant({
        leafAssistantId: args.leafAssistantId,
        content: args.content,
        model,
      });
      const assistant = repo.insertStreamingAssistant({
        conversationId: leaf.conversation_id,
        parentId: userNodeId,
        model,
      });
      startTurn(deps, {
        userNodeId,
        assistantNodeId: assistant.id,
        model,
        skipPermissions: args.permissionMode === 'act',
      });
      return { userNodeId, assistantNodeId: assistant.id };
    }
  );

  // turn:editUser (edit user turn): new user sibling under the edited node's
  // parent with revised content; the original subtree is retained.
  ipcMain.handle(
    IPC.turnEditUser,
    (_e, args: EditUserArgs): TurnStarted => {
      const oldUser = repo.getNode(args.userNodeId);
      if (!oldUser || oldUser.role !== 'user') {
        throw new Error(`User node not found: ${args.userNodeId}`);
      }
      const newUser = repo.insertUserNode({
        conversationId: oldUser.conversation_id,
        parentId: oldUser.parent_id, // same parent => sibling branch
        content: args.content,
      });
      const convo = repo.getConversationRow(oldUser.conversation_id);
      const model = convo?.model ?? null;
      const assistant = repo.insertStreamingAssistant({
        conversationId: oldUser.conversation_id,
        parentId: newUser.id,
        model,
      });
      startTurn(deps, {
        userNodeId: newUser.id,
        assistantNodeId: assistant.id,
        model,
        skipPermissions: args.permissionMode === 'act',
      });
      return { userNodeId: newUser.id, assistantNodeId: assistant.id };
    }
  );

  // turn:abort: kill the child, persist whatever partial content the node
  // currently holds. Default policy keeps the partial and marks it complete.
  ipcMain.handle(IPC.turnAbort, (_e, args: AbortArgs): void => {
    runner.abort(args.nodeId);
    const node = repo.getNode(args.nodeId);
    if (node && node.status === 'streaming') {
      // Default abort policy: keep partial, mark complete. The checkpoint
      // mechanism has persisted recent deltas into node.content already.
      repo.completeAssistant(args.nodeId, {
        content: node.content,
        inputTokens: node.input_tokens,
        outputTokens: node.output_tokens,
        costUsd: node.cost_usd,
      });
    }
  });

  // -- Branching / structure ----------------------------------------------

  // branch:switch (switch branch): reassign active leaf, no generation.
  ipcMain.handle(IPC.branchSwitch, (_e, args: SwitchBranchArgs): void =>
    repo.setActiveLeaf(args.conversationId, args.leafId)
  );

  // node:delete: cascade-delete a node and its subtree.
  ipcMain.handle(IPC.nodeDelete, (_e, args: DeleteNodeArgs): void =>
    repo.deleteNode(args.nodeId)
  );

  // -- Attachments ---------------------------------------------------------

  ipcMain.handle(
    IPC.attachmentAdd,
    (_e, args: AddAttachmentArgs): string =>
      repo.addAttachment({
        conversationId: args.conversationId,
        nodeId: args.nodeId,
        dirPath: args.dirPath,
      })
  );

  ipcMain.handle(IPC.attachmentRemove, (_e, args: RemoveAttachmentArgs): void =>
    repo.removeAttachment(args.attachmentId)
  );

  // -- Dialog / diagnostics ------------------------------------------------

  // dialog:pickDirectory: the renderer never resolves paths itself; the
  // OS picker runs in main and returns the chosen directory (or null).
  ipcMain.handle(IPC.pickDirectory, async (): Promise<string | null> => {
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // dialog:pickFiles — OS file picker; returns the chosen absolute file paths so
  // the renderer can reference them in a prompt (the caller also attaches each
  // file's directory so the model can actually read it).
  ipcMain.handle(IPC.pickFiles, async (): Promise<string[]> => {
    const win = getWindow();
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled) return [];
    return result.filePaths;
  });

  // dialog:pickClaudeBinary — OS file picker for the claude executable; returns
  // its path (or null). On macOS, allow hidden files so ~/.claude/local is
  // reachable and don't treat .app-style bundles as opaque.
  ipcMain.handle(IPC.pickClaudeBinary, async (): Promise<string | null> => {
    const win = getWindow();
    const opts: Electron.OpenDialogOptions = {
      title: 'Locate the claude executable',
      properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // engine:status: surface the resolved binary health to the renderer.
  ipcMain.handle(IPC.engineStatus, (): EngineStatus => engineStatus());

  // engine:setClaudePath — validate a user-chosen binary; on success persist it
  // (meta table, so it survives restarts and a stripped PATH), point the runner
  // at it, and update the cached status. Invalid paths are NOT stored.
  ipcMain.handle(
    IPC.engineSetClaudePath,
    async (_e, path: string): Promise<EngineStatus> => {
      const status = await validateClaudePath(path);
      if (status.ok && status.claudePath) {
        repo.setSetting('claude_path', status.claudePath);
        runner.setClaudePath(status.claudePath);
      }
      deps.setEngineStatus(status);
      return status;
    }
  );
}

/** Derive a concise conversation title from the first user message. */
function makeTitle(content: string): string {
  const text = content.trim().replace(/\s+/g, ' ');
  if (!text) return 'New conversation';
  if (text.length <= 48) return text;
  // Truncate at a word boundary near 48 chars.
  const cut = text.slice(0, 48);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/** Internal: parameters describing a single turn to (re)generate. */
interface TurnSpec {
  /** Leaf the thread is assembled from (the new/edited user node). */
  userNodeId: string;
  /** The streaming assistant node deltas/result are written into. */
  assistantNodeId: string;
  /** Resolved model for this turn (null => runner default). */
  model: string | null;
  /** 'act without asking' -> --dangerously-skip-permissions. */
  skipPermissions?: boolean;
}

/**
 * Start one generation turn (streaming pipeline).
 *
 * 1. Assemble the root->leaf thread ending on the new user turn.
 * 2. Compute the effective directory set, validate each; the first
 *    valid dir is the process cwd, the rest are --add-dir (only granted,
 *    existing dirs are passed to the subprocess).
 * 3. Open a per-turn MessageChannelMain; the runner's callbacks persist to SQLite
 *    AND post StreamEvents down port1; port2 is handed to the renderer.
 *
 * The port is sent to the renderer BEFORE this function returns so the renderer
 * can attach its listener as soon as the awaitable command resolves.
 */
function startTurn(deps: IpcDeps, spec: TurnSpec): void {
  const { repo, runner, getWindow } = deps;
  const assistantId = spec.assistantNodeId;

  // Full root->leaf thread, already including the new user turn last.
  const thread = repo.getThread(spec.userNodeId);

  // Effective dirs on this branch path, validated to exist.
  const effective = repo.effectiveDirs(spec.userNodeId);
  const validDirs: string[] = [];
  for (const dir of effective) {
    if (validateDir(dir).ok) validDirs.push(dir); // skip nonexistent/invalid
  }
  // First valid dir is cwd; remainder are --add-dir. None => neutral temp dir.
  const cwd = validDirs.length > 0 ? validDirs[0] : neutralTempDir();
  const addDirs = validDirs.length > 0 ? validDirs.slice(1) : [];

  // Per-turn streaming channel: port1 stays in main, port2 goes to the
  // renderer via the preload, which re-exposes events through onTurnEvent.
  const { port1, port2 } = new MessageChannelMain();

  const post = (event: StreamEvent): void => {
    // Posting to a closed port can throw; swallow so a gone renderer never
    // crashes the turn (the DB write below remains authoritative).
    try {
      port1.postMessage(event);
    } catch {
      /* renderer/port gone — DB state is the source of truth */
    }
  };

  runner.start(
    {
      nodeId: assistantId,
      cwd,
      addDirs,
      ...(spec.model ? { model: spec.model } : {}),
      thread,
      skipPermissions: spec.skipPermissions ?? false,
    },
    {
      // Incremental token text -> renderer.
      onDelta: (text: string): void => {
        post({ type: 'delta', textDelta: text });
      },
      // Periodic crash-recovery checkpoint of partial content. Not sent
      // to the renderer — the renderer already has the deltas.
      onCheckpoint: (content: string): void => {
        repo.checkpointAssistant(assistantId, content);
      },
      // Terminal success: persist final content + usage,
      // advance the active leaf, then notify and close the port.
      onDone: (r: TurnResult): void => {
        repo.completeAssistant(assistantId, {
          content: r.content,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          costUsd: r.costUsd,
        });
        post({
          type: 'done',
          usage: {
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            costUsd: r.costUsd,
          },
          durationMs: r.durationMs,
          content: r.content,
        });
        port1.close();
      },
      // Failure: mark the node error with diagnostics, notify, close.
      onError: (message: string): void => {
        repo.failAssistant(assistantId, message);
        post({ type: 'error', message });
        port1.close();
      },
    }
  );

  // Begin delivering queued messages on the main side (Electron requires an
  // explicit start() on MessagePortMain).
  port1.start();

  // Hand the other end to the renderer, keyed by assistantNodeId so the preload
  // can route it to the right onTurnEvent subscriber. Done synchronously so the
  // port is in flight before the invoke() promise resolves in the renderer.
  getWindow()?.webContents.postMessage('turn:port', { assistantNodeId: assistantId }, [
    port2,
  ]);
}
