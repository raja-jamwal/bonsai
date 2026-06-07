// Claude binary resolution.
//
// At startup the engine must locate the `claude` executable on PATH and read
// its version. Absence or a probe failure surfaces a clear, actionable error to
// the renderer (via EngineStatus) rather than failing silently mid-turn.

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import type { EngineStatus } from '@shared/types';

// Well-known install locations to probe when shell discovery fails.
const KNOWN_PATHS =
  platform === 'win32'
    ? []
    : [
        join(homedir(), '.local/bin/claude'),
        join(homedir(), '.claude/local/claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
      ];

/**
 * Validate a specific `claude` path by probing `<path> --version`. Used for a
 * user-selected binary (from the locate dialog) and for the stored path. Returns
 * an EngineStatus pinned to that path — ok with the version, or a path-specific
 * error. Never throws.
 */
export async function validateClaudePath(claudePath: string): Promise<EngineStatus> {
  // Check that the file exists and is executable. We can't rely on `--version`
  // because the claude CLI requires a TTY and gets SIGKILL'd when spawned
  // headlessly (i.e. from an Electron app launched via Finder / DMG).
  try {
    await access(claudePath, constants.X_OK);
  } catch {
    return {
      claudePath,
      claudeVersion: null,
      ok: false,
      error: `'${claudePath}' is not a runnable claude CLI.`,
    };
  }
  // Best-effort version probe — ignore failure (no TTY → SIGKILL).
  const probe = await runCapture(claudePath, ['--version']);
  const claudeVersion =
    probe.code === 0 ? probe.stdout.trim() || probe.stderr.trim() || null : null;
  return { claudePath, claudeVersion, ok: true, error: null };
}

/**
 * Resolve the `claude` CLI: find its path and version.
 *
 * Strategy:
 *  0. If a `preferredPath` is given (the path saved in SQLite) and it still
 *     runs, use it — survives restarts and works when PATH is stripped (e.g. a
 *     packaged app launched from Finder).
 *  1. Otherwise use the platform locator (`which` / `where`) to find it on PATH.
 *  2. Probe `--version` to confirm it is runnable and capture the version.
 *
 * Never throws: all failure modes are reported through EngineStatus.ok=false
 * with an actionable `error` message (the renderer then offers a locate dialog).
 */
export async function resolveClaude(preferredPath?: string | null): Promise<EngineStatus> {
  // Step 0: a stored/preferred path wins if it still works.
  if (preferredPath) {
    const stored = await validateClaudePath(preferredPath);
    if (stored.ok) return stored;
    // else fall through — the stored path may be stale; try PATH next.
  }

  // Step 1: locate the binary. Electron apps launched from Finder/DMG inherit a
  // stripped PATH that omits user-level dirs like ~/.local/bin. We run `which`
  // through a login shell so it picks up the full user PATH from shell profiles.
  const claudePath = await findOnPath();

  if (!claudePath) {
    return {
      claudePath: null,
      claudeVersion: null,
      ok: false,
      error:
        "Could not find the 'claude' CLI. Install it with " +
        "'npm install -g @anthropic-ai/claude-code', or locate the binary " +
        'manually below.',
    };
  }

  // Step 2: validate (executable check) and best-effort version probe.
  return validateClaudePath(claudePath);
}

/**
 * Locate the `claude` binary. Tries (in order):
 *  1. Login-shell `which` via zsh/bash — picks up user PATH from shell profiles.
 *  2. Bare `which`/`where` — works when Electron inherits a full PATH.
 *  3. Well-known install paths probed directly via fs.access.
 * Returns the path string, or null if not found.
 */
async function findOnPath(): Promise<string | null> {
  if (platform === 'win32') {
    const r = await runCapture('where', ['claude']);
    if (!r.error && r.code === 0) {
      return r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? null;
    }
    return null;
  }

  // Try login shells first so ~/.local/bin and similar dirs are on PATH.
  for (const shell of ['zsh', 'bash']) {
    const r = await runCapture(shell, ['-lc', 'which claude']);
    if (!r.error && r.code === 0) {
      const p = r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      if (p) return p;
    }
  }

  // Bare `which` as a fallback (works when Electron inherits a full PATH).
  const bare = await runCapture('which', ['claude']);
  if (!bare.error && bare.code === 0) {
    const p = bare.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (p) return p;
  }

  // Last resort: probe known install locations directly.
  for (const p of KNOWN_PATHS) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      // not there — try next
    }
  }

  return null;
}

/** Internal: spawn a command, capture stdout/stderr/exit, never throw. */
interface CaptureResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error: Error | null;
}

function runCapture(command: string, args: string[]): Promise<CaptureResult> {
  return new Promise<CaptureResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // spawn can throw synchronously (e.g. ENOENT on some platforms).
      resolve({ stdout: '', stderr: '', code: null, error: err as Error });
      return;
    }

    const finish = (code: number | null, error: Error | null) => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, code, error });
    };

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    // 'error' fires when the process could not be spawned (e.g. ENOENT).
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code, null));
  });
}
