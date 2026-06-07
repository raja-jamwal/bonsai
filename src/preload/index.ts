// Preload bridge — the sole privileged surface the renderer can touch.
// Honors AR-1 (contextIsolation + sandbox: true; renderer never reaches Node,
// the CLI, the DB, or the filesystem directly) and §6 (the IPC contract).
//
// Command calls round-trip via ipcRenderer.invoke. Token streaming for a turn
// arrives over a per-turn MessagePort that is received and parked here in the
// isolated world (NF-2): only plain StreamEvents — never the raw MessagePort,
// which cannot cross contextBridge — are handed to the page via onTurnEvent.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/types';
import type {
  BridgeApi,
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
  SetModelArgs,
  GenerateTitleArgs,
  ConversationSummary,
  ConversationTree,
  TurnStarted,
  EngineStatus,
  StreamEvent,
  TurnEventHandler,
} from '@shared/types';

// ---------------------------------------------------------------------------
// Streaming subscriber registry (§6 streaming events; NF-2).
// Keyed by assistantNodeId so multiple concurrent in-flight turns (CL-7) each
// fan out to their own subscribers without cross-talk.
// ---------------------------------------------------------------------------
const handlers = new Map<string, Set<TurnEventHandler>>();

// The main process transfers one MessagePort per turn over 'turn:port'. We keep
// the port in this isolated world and forward only deserialized StreamEvents to
// the page (AR-1 / NF-2). The port is closed and the subscriber set is dropped
// once the turn reaches a terminal event ('done' or 'error').
ipcRenderer.on(
  'turn:port',
  (event: Electron.IpcRendererEvent, { assistantNodeId }: { assistantNodeId: string }) => {
    const port = event.ports[0];
    port.onmessage = (ev: MessageEvent) => {
      const data = ev.data as StreamEvent;
      const set = handlers.get(assistantNodeId);
      if (set) {
        for (const h of set) h(data);
      }
      // Terminal events auto-tear-down the port and subscriber set.
      if (data.type === 'done' || data.type === 'error') {
        handlers.delete(assistantNodeId);
        port.close();
      }
    };
    port.start();
  },
);

// ---------------------------------------------------------------------------
// The exposed API surface (fully typed against BridgeApi; §6 command table).
// ---------------------------------------------------------------------------
const api: BridgeApi = {
  // Commands (renderer -> main, awaitable) — each maps to one IPC channel.
  createConversation: (args: CreateConversationArgs): Promise<string> =>
    ipcRenderer.invoke(IPC.conversationCreate, args),

  listConversations: (): Promise<ConversationSummary[]> =>
    ipcRenderer.invoke(IPC.conversationList),

  getConversation: (id: string): Promise<ConversationTree> =>
    ipcRenderer.invoke(IPC.conversationGet, id),

  renameConversation: (args: RenameConversationArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.conversationRename, args),

  deleteConversation: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.conversationDelete, id),

  setModel: (args: SetModelArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.conversationSetModel, args),

  generateNodeTitle: (args: GenerateTitleArgs): Promise<string | null> =>
    ipcRenderer.invoke(IPC.nodeGenerateTitle, args),

  // Turn-starting commands return node ids; streaming arrives via onTurnEvent.
  sendTurn: (args: SendTurnArgs): Promise<TurnStarted> =>
    ipcRenderer.invoke(IPC.turnSend, args),

  regenerate: (args: RegenerateArgs): Promise<TurnStarted> =>
    ipcRenderer.invoke(IPC.turnRegenerate, args),

  editUser: (args: EditUserArgs): Promise<TurnStarted> =>
    ipcRenderer.invoke(IPC.turnEditUser, args),

  forkLeaf: (args: ForkLeafArgs): Promise<TurnStarted> =>
    ipcRenderer.invoke(IPC.turnForkLeaf, args),

  abortTurn: (args: AbortArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.turnAbort, args),

  switchBranch: (args: SwitchBranchArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.branchSwitch, args),

  deleteNode: (args: DeleteNodeArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.nodeDelete, args),

  addAttachment: (args: AddAttachmentArgs): Promise<string> =>
    ipcRenderer.invoke(IPC.attachmentAdd, args),

  removeAttachment: (args: RemoveAttachmentArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.attachmentRemove, args),

  // IPC-1: the OS directory picker lives in main; the renderer never resolves
  // arbitrary paths itself — it just receives the granted path back.
  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.pickDirectory),

  pickFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.pickFiles),

  // CL-10 diagnostics surface for the resolved `claude` binary.
  engineStatus: (): Promise<EngineStatus> =>
    ipcRenderer.invoke(IPC.engineStatus),

  // Subscribe to a turn's stream events. Returns an unsubscribe function that
  // removes this handler (early teardown before the auto-cleanup on terminal).
  onTurnEvent: (assistantNodeId: string, handler: TurnEventHandler): (() => void) => {
    let set = handlers.get(assistantNodeId);
    if (!set) {
      set = new Set<TurnEventHandler>();
      handlers.set(assistantNodeId, set);
    }
    set.add(handler);
    return () => {
      const current = handlers.get(assistantNodeId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) handlers.delete(assistantNodeId);
    };
  },
};

// AR-1: expose the typed bridge as `window.api`; nothing else crosses the seam.
contextBridge.exposeInMainWorld('api', api);
