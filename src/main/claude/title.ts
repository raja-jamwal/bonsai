// Branch/conversation title generation — a lightweight, one-shot `claude` text
// call (no streaming) that summarizes a message into a short title, mirroring
// how Claude auto-names conversations. Used to label branches in the tree /
// breadcrumb (handoff open-question 1).
import { spawn } from 'node:child_process';

const PROMPT =
  'Summarize the following message as a very short branch title of 2 to 5 ' +
  'words. Output ONLY the title text — no quotes, no punctuation at the end, ' +
  'no preamble.\n\nMessage:\n';

/** Clean a model title: strip quotes/whitespace and clamp length. */
function clean(raw: string): string {
  let t = raw.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  // Guard against a chatty model that ignored the instruction.
  if (t.length > 48) t = t.slice(0, 48).trim();
  return t;
}

/**
 * Generate a concise title for `sourceText`. Resolves to the title, or null on
 * any failure/timeout (callers fall back to a derived label). Uses haiku for
 * speed/cost and `--no-session-persistence` so nothing is written to disk.
 */
export function generateTitle(
  claudePath: string,
  sourceText: string,
  timeoutMs = 15000
): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        claudePath,
        ['-p', '--model', 'haiku', '--no-session-persistence'],
        { stdio: ['pipe', 'pipe', 'ignore'] }
      );
    } catch {
      resolve(null);
      return;
    }

    let out = '';
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(v);
    };

    const timer = setTimeout(() => done(null), timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code === 0) {
        const t = clean(out);
        done(t.length > 0 ? t : null);
      } else {
        done(null);
      }
    });

    try {
      child.stdin.on('error', () => {});
      child.stdin.write(PROMPT + sourceText.slice(0, 2000));
      child.stdin.end();
    } catch {
      done(null);
    }
  });
}
