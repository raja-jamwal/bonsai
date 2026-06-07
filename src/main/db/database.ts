// Database open / migration / recovery.
// better-sqlite3 is a synchronous native module; default import.
import Database from 'better-sqlite3';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

/**
 * Open (or create) the SQLite database at `filePath`, apply pragmas,
 * ensure the schema exists, run forward migrations, and record the
 * schema version in `meta`. Returns the live, synchronous DB handle.
 */
export function openDatabase(filePath: string): Database.Database {
  const db = new Database(filePath);

  // Pragmas at open. WAL for concurrent reads during streaming writes;
  // foreign_keys ON so the cascade / set-null relations are enforced;
  // synchronous NORMAL is WAL-safe and faster.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  // Create tables/indexes if absent (idempotent DDL). Migrations are
  // applied transactionally via direct DDL.
  const migrate = db.transaction(() => {
    db.exec(SCHEMA_SQL);

    // v2 migration: existing DBs created at v1 won't get `nodes.title` from the
    // IF NOT EXISTS DDL above, so add it explicitly when missing (idempotent).
    const cols = db.prepare(`PRAGMA table_info(nodes)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'title')) {
      db.exec(`ALTER TABLE nodes ADD COLUMN title TEXT`);
    }

    // Read the recorded schema version, defaulting to the current
    // version on a brand-new database (the schema we just exec'd is vN).
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    if (row === undefined) {
      // Fresh DB: stamp the current version.
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?)"
      ).run(String(SCHEMA_VERSION));
    } else {
      // Forward migrations would run here per version step. Currently only
      // SCHEMA_VERSION = 1 exists, so there is nothing to migrate; we simply
      // keep the stored version aligned.
      const stored = Number(row.value);
      if (stored < SCHEMA_VERSION) {
        // (No intermediate migrations to apply at version 1.)
        db.prepare(
          "UPDATE meta SET value = ? WHERE key = 'schema_version'"
        ).run(String(SCHEMA_VERSION));
      }
    }
  });
  migrate();

  return db;
}

/**
 * A crash mid-stream leaves at most one node per in-flight turn in
 * `status = 'streaming'`. On startup, mark every such orphaned node as
 * `error` so the UI never shows a permanently "streaming" node. Returns the
 * number of rows recovered.
 */
export function recoverOrphans(db: Database.Database): number {
  const result = db
    .prepare(
      `UPDATE nodes
          SET status = 'error',
              error_text = 'Interrupted: process exited while streaming'
        WHERE status = 'streaming'`
    )
    .run();
  return result.changes;
}
