// Typed accessor for the preload bridge (IPC contract).
// The renderer touches main ONLY through this object — never Node, the CLI,
// the DB, or the filesystem directly. `window.api` is installed by the preload
// via contextBridge and typed by the global `BridgeApi` augmentation in
// @shared/types.
import type { BridgeApi } from '@shared/types';

/**
 * The single IPC surface available to the UI. Strongly typed as `BridgeApi`
 * so call sites get full autocomplete and the compiler enforces the seam.
 */
export const api: BridgeApi = window.api;

// Re-export the shared types the UI layer commonly needs, so components can
// import them from a single renderer-local module rather than reaching across
// the alias for every type.
export type {
  Role,
  NodeStatus,
  MessageNode,
  Conversation,
  Attachment,
  ConversationSummary,
  ConversationTree,
  TurnStarted,
  TurnEventHandler,
  StreamEvent,
  DeltaEvent,
  DoneEvent,
  ErrorEvent,
  EngineStatus,
  BridgeApi,
} from '@shared/types';
