// Claude binary resolution.
//
// At startup the engine must locate the `claude` executable on PATH and read
// its version. Absence or a probe failure surfaces a clear, actionable error to
// the renderer (via EngineStatus) rather than failing silently mid-turn.

import { spawn } from 'node:child_process';
import { platform } from 'node:process';
import type { EngineStatus } from '@shared/types';

/**
 * Validate a specific `claude` path by probing `<path> --version`. Used for a
 * user-selected binary (from the locate dialog) and for the stored path. Returns
 * an EngineStatus pinned to that path — ok with the version, or a path-specific
 * error. Never throws.
 */
export async function validateClaudePath(claudePath: string): Promise<EngineStatus> {
  const probe = await runCapture(claudePath, ['--version']);
  if (probe.error || probe.code !== 0) {
    return {
      claudePath,
      claudeVersion: null,
      ok: false,
      error:
        `'${claudePath}' is not a runnable claude CLI` +
        (probe.stderr.trim() ? `: ${probe.stderr.trim()}` : '.'),
    };
  }
  return {
    claudePath,
    claudeVersion: probe.stdout.trim() || probe.stderr.trim() || null,
    ok: true,
    error: null,
  };
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

  // Step 1: locate the binary on PATH. `where` on Windows, `which` elsewhere.
  const locator = platform === 'win32' ? 'where' : 'which';
  const located = await runCapture(locator, ['claude']);

  if (located.error || located.code !== 0) {
    return {
      claudePath: null,
      claudeVersion: null,
      ok: false,
      // Actionable error: tell the user how to fix it.
      error:
        "Could not find the 'claude' CLI on your PATH. Install it with " +
        "'npm install -g @anthropic-ai/claude-code', or locate the binary " +
        'manually below.',
    };
  }

  // `where` may return several lines on Windows; take the first non-empty one.
  const claudePath = located.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? 'claude';

  // Step 2: probe the version to confirm the binary is actually runnable.
  const versionProbe = await runCapture(claudePath, ['--version']);

  if (versionProbe.error || versionProbe.code !== 0) {
    return {
      claudePath,
      claudeVersion: null,
      ok: false,
      error:
        `Found 'claude' at ${claudePath} but '--version' failed` +
        (versionProbe.stderr.trim() ? `: ${versionProbe.stderr.trim()}` : '.') +
        ' The binary may be corrupt or incompatible.',
    };
  }

  // Version output is typically a single short line, e.g. "1.2.3 (Claude Code)".
  const claudeVersion = versionProbe.stdout.trim() || versionProbe.stderr.trim() || null;

  return { claudePath, claudeVersion, ok: true, error: null };
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
