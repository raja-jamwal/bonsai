// Shared types — the IPC seam between main and renderer.
// This file is the single source of truth for the IPC contract.
// Both processes import from here.

export type Role = 'user' | 'assistant';
export type NodeStatus = 'streaming' | 'complete' | 'error';

/** A single message node in the conversation tree (DB row shape). */
export interface MessageNode {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: Role;
  content: string;
  status: NodeStatus;
  model: string | null;
  /** v2: auto-generated short branch title, on branch-head nodes. */
  title: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  error_text: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface Conversation {
  id: string;
  title: string;
  active_leaf: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
}

export interface Attachment {
  id: string;
  conversation_id: string;
  node_id: string | null;
  dir_path: string;
  added_at: number;
}

/** Lightweight summary returned by conversation:list. */
export interface ConversationSummary {
  id: string;
  title: string;
  model: string | null;
  active_leaf: string | null;
  created_at: number;
  updated_at: number;
  node_count: number;
}

/** Full conversation payload returned by conversation:get. */
export interface ConversationTree {
  conversation: Conversation;
  nodes: MessageNode[];
  attachments: Attachment[];
}

// ---------------------------------------------------------------------------
// Command channel argument / return shapes (renderer -> main, awaitable).
// ---------------------------------------------------------------------------

export interface CreateConversationArgs {
  title?: string;
  model?: string;
}

export interface RenameConversationArgs {
  id: string;
  title: string;
}

/**
 * Permission posture for a turn:
 *  - 'ask' : regular `claude` (tools needing approval don't run unattended).
 *  - 'act' : pass `--dangerously-skip-permissions` so Claude acts without pausing.
 */
export type PermissionMode = 'ask' | 'act';

export interface SendTurnArgs {
  conversationId: string;
  parentId: string | null; // null = this turn's user node is the root
  content: string;
  model?: string;
  permissionMode?: PermissionMode;
}

export interface RegenerateArgs {
  assistantNodeId: string;
  model?: string;
  permissionMode?: PermissionMode;
}

export interface EditUserArgs {
  userNodeId: string;
  content: string;
  permissionMode?: PermissionMode;
}

/**
 * Fork from a leaf assistant while preserving it as its own branch: snapshot the
 * answer to a sibling and start a new branch with `content` under the snapshot.
 */
export interface ForkLeafArgs {
  leafAssistantId: string;
  content: string;
  model?: string;
  permissionMode?: PermissionMode;
}

export interface AbortArgs {
  nodeId: string;
}

export interface SwitchBranchArgs {
  conversationId: string;
  leafId: string;
}

export interface DeleteNodeArgs {
  nodeId: string;
}

export interface AddAttachmentArgs {
  conversationId: string;
  nodeId: string | null;
  dirPath: string;
}

export interface RemoveAttachmentArgs {
  attachmentId: string;
}

export interface SetModelArgs {
  id: string; // conversation id
  model: string | null;
}

export interface GenerateTitleArgs {
  nodeId: string; // the branch-head node to title
  text: string; // source text to summarize (the branch's first user message)
}

/** Selectable models for the composer model picker (CLI aliases). */
export interface ModelOption {
  id: string | null; // null = CLI default
  label: string;
}
export const MODEL_OPTIONS: ModelOption[] = [
  { id: null, label: 'Default model' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

/**
 * Result of a turn-starting command. `assistantNodeId` is the streaming node
 * the renderer should render deltas into. `userNodeId` is included for the
 * editUser case (a new user node is created).
 *
 * Streaming itself is delivered over a per-turn MessageChannelMain port that
 * lives inside the preload (isolated world) for sub-50ms latency; the
 * renderer subscribes to plain StreamEvents via `onTurnEvent` rather than
 * receiving the raw MessagePort (which cannot cross contextBridge).
 */
export interface TurnStarted {
  assistantNodeId: string;
  userNodeId?: string;
}

export type TurnEventHandler = (event: StreamEvent) => void;

// ---------------------------------------------------------------------------
// Streaming events (main -> renderer, over the per-turn MessagePort).
// ---------------------------------------------------------------------------

export interface DeltaEvent {
  type: 'delta';
  textDelta: string;
}

export interface DoneEvent {
  type: 'done';
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
  };
  durationMs: number | null;
  content: string; // authoritative final text
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export type StreamEvent = DeltaEvent | DoneEvent | ErrorEvent;

// ---------------------------------------------------------------------------
// IPC channel names — referenced by both processes to avoid string drift.
// ---------------------------------------------------------------------------

export const IPC = {
  conversationCreate: 'conversation:create',
  conversationList: 'conversation:list',
  conversationGet: 'conversation:get',
  conversationRename: 'conversation:rename',
  conversationDelete: 'conversation:delete',
  conversationSetModel: 'conversation:setModel',
  nodeGenerateTitle: 'node:generateTitle',
  turnSend: 'turn:send',
  turnRegenerate: 'turn:regenerate',
  turnEditUser: 'turn:editUser',
  turnForkLeaf: 'turn:forkLeaf',
  turnAbort: 'turn:abort',
  branchSwitch: 'branch:switch',
  nodeDelete: 'node:delete',
  attachmentAdd: 'attachment:add',
  attachmentRemove: 'attachment:remove',
  pickDirectory: 'dialog:pickDirectory',
  pickFiles: 'dialog:pickFiles',
  pickClaudeBinary: 'dialog:pickClaudeBinary',
  engineStatus: 'engine:status',
  engineSetClaudePath: 'engine:setClaudePath',
} as const;

/**
 * Health/diagnostics surface for the resolved `claude` binary.
 */
export interface EngineStatus {
  claudePath: string | null;
  claudeVersion: string | null;
  ok: boolean;
  error: string | null;
}

/**
 * The API surface exposed on `window.api` by the preload bridge.
 * Turn-starting calls return node ids; streaming arrives via `onTurnEvent`,
 * which the renderer should subscribe to (keyed by assistantNodeId) before or
 * immediately after the call resolves. The handler fires for `delta`, `done`,
 * and `error` events; it auto-unsubscribes after `done`/`error`, and the
 * returned function unsubscribes early.
 */
export interface BridgeApi {
  createConversation(args: CreateConversationArgs): Promise<string>;
  listConversations(): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<ConversationTree>;
  renameConversation(args: RenameConversationArgs): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  setModel(args: SetModelArgs): Promise<void>;
  generateNodeTitle(args: GenerateTitleArgs): Promise<string | null>;
  sendTurn(args: SendTurnArgs): Promise<TurnStarted>;
  regenerate(args: RegenerateArgs): Promise<TurnStarted>;
  editUser(args: EditUserArgs): Promise<TurnStarted>;
  forkLeaf(args: ForkLeafArgs): Promise<TurnStarted>;
  abortTurn(args: AbortArgs): Promise<void>;
  switchBranch(args: SwitchBranchArgs): Promise<void>;
  deleteNode(args: DeleteNodeArgs): Promise<void>;
  addAttachment(args: AddAttachmentArgs): Promise<string>;
  removeAttachment(args: RemoveAttachmentArgs): Promise<void>;
  pickDirectory(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  /** Open an OS file picker for the claude executable; returns its path or null. */
  pickClaudeBinary(): Promise<string | null>;
  engineStatus(): Promise<EngineStatus>;
  /** Validate + persist a user-chosen claude path; returns the new EngineStatus. */
  setClaudePath(path: string): Promise<EngineStatus>;
  onTurnEvent(assistantNodeId: string, handler: TurnEventHandler): () => void;
}

declare global {
  interface Window {
    api: BridgeApi;
  }
}
