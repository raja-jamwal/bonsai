// Claude binary resolution (CL-10).
//
// At startup the engine must locate the `claude` executable on PATH and read
// its version. Absence or a probe failure surfaces a clear, actionable error to
// the renderer (via EngineStatus) rather than failing silently mid-turn.

import { spawn } from 'node:child_process';
import { platform } from 'node:process';
import type { EngineStatus } from '@shared/types';

/**
 * Resolve the `claude` CLI: find its path and version (CL-10).
 *
 * Strategy:
 *  1. Use the platform locator (`which` / `where`) to find the binary on PATH.
 *  2. Probe `claude --version` to confirm it is runnable and capture the version
 *     string.
 *
 * Never throws: all failure modes are reported through EngineStatus.ok=false
 * with an actionable `error` message.
 */
export async function resolveClaude(): Promise<EngineStatus> {
  // Step 1: locate the binary on PATH. `where` on Windows, `which` elsewhere.
  const locator = platform === 'win32' ? 'where' : 'which';
  const located = await runCapture(locator, ['claude']);

  if (located.error || located.code !== 0) {
    return {
      claudePath: null,
      claudeVersion: null,
      ok: false,
      // Actionable error (CL-10): tell the user how to fix it.
      error:
        "Could not find the 'claude' CLI on your PATH. Install it with " +
        "'npm install -g @anthropic-ai/claude-code' (or ensure it is on PATH), " +
        'then restart the app.',
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
