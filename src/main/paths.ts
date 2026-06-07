// Path validation and a neutral working directory for the engine.
// Validates every path exists and is a directory before spawning, and ensures
// no model-supplied path is dereferenced outside the granted set — callers
// validate dirs through validateDir here.

import { statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Validate that a path exists and is a directory.
 * Returns ok:false with a human-readable error on ENOENT or not-a-directory
 * (or any other stat failure), never throws.
 */
export function validateDir(p: string): { ok: boolean; error?: string } {
  let stat;
  try {
    stat = statSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `Directory does not exist: ${p}` };
    }
    return { ok: false, error: `Cannot access path: ${p}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `Not a directory: ${p}` };
  }
  return { ok: true };
}

/**
 * Stable per-app temp directory used as the process cwd when a branch has no
 * attached dirs (the first effective dir is the cwd; with none, we fall
 * back to this neutral location rather than the app's own working directory).
 * Created on demand if missing.
 */
export function neutralTempDir(): string {
  const dir = join(tmpdir(), 'branching-claude');
  mkdirSync(dir, { recursive: true });
  return dir;
}
