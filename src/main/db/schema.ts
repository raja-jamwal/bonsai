// Persistence schema.
// This module is pure data: the canonical DDL and the current schema
// version. database.ts is responsible for applying it.

/**
 * Current schema version. Stored in the `meta` table under key
 * 'schema_version'. Bump this and add a migration branch in
 * database.ts when the DDL changes.
 */
export const SCHEMA_VERSION = 2;

/**
 * Full DDL for the persistence layer.
 *
 * Notes on the constraints that must be preserved exactly:
 * - `conversations.active_leaf` -> `nodes(id) ON DELETE SET NULL` so deleting
 *   the active leaf node simply clears the pointer rather than orphaning the row.
 * - `nodes.conversation_id` -> `conversations(id) ON DELETE CASCADE`.
 * - `nodes.parent_id` -> `nodes(id) ON DELETE CASCADE` implements the subtree
 *   cascade delete; NULL parent denotes the root.
 * - `nodes.role` / `nodes.status` CHECK constraints mirror the shared types.
 * - `attachments.node_id` -> `nodes(id) ON DELETE CASCADE`; NULL means the
 *   attachment applies to the whole conversation.
 *
 * All tables use CREATE TABLE IF NOT EXISTS so the DDL is idempotent and safe
 * to exec on every open. There is deliberately no `session_id` column.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,                 -- uuid v4
  title       TEXT NOT NULL DEFAULT '',
  active_leaf TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  model       TEXT,                             -- default model for new turns
  created_at  INTEGER NOT NULL,                 -- epoch ms
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,              -- uuid v4
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id       TEXT REFERENCES nodes(id) ON DELETE CASCADE,  -- NULL = root
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'complete'
                    CHECK (status IN ('streaming','complete','error')),
  model           TEXT,                          -- model used (assistant turns)
  title           TEXT,                          -- v2: auto-generated branch title (branch-head nodes)
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        REAL,
  error_text      TEXT,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent       ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_conversation ON nodes(conversation_id);

CREATE TABLE IF NOT EXISTS attachments (
  id              TEXT PRIMARY KEY,              -- uuid v4
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  node_id         TEXT REFERENCES nodes(id) ON DELETE CASCADE,  -- applies from here down
  dir_path        TEXT NOT NULL,
  added_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);

CREATE TABLE IF NOT EXISTS meta (                -- schema version, app settings
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;
