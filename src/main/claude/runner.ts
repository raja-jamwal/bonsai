// Claude subprocess runner.
//
// Each turn spawns a fresh `claude` subprocess in print mode, streams the branch
// thread to its stdin as NDJSON, parses stream-json from stdout, and reports
// deltas / completion / errors via callbacks. A single conversation may have
// multiple concurrent in-flight turns on different branches; each writes only to
// its own node (keyed by nodeId), so there is no cross-turn interference.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StreamParser, type TurnResult } from './parser.js';

export interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RunOptions {
  nodeId: string;
  cwd: string;
  addDirs: string[];
  model?: string;
  // thread = full root->leaf path INCLUDING the new user turn as the last element.
  thread: ThreadMessage[];
  // 'act without asking' -> pass --dangerously-skip-permissions so Claude can
  // use tools unattended in the attached directory.
  skipPermissions?: boolean;
}

export interface RunCallbacks {
  onDelta(text: string): void;
  onCheckpoint(content: string): void;
  onDone(r: TurnResult): void;
  onError(message: string): void;
  /** Transient activity indicator. label='thinking'|toolName; active=false clears. */
  onActivity(label: string, active: boolean): void;
}

// Persist accumulated partial content every N deltas for crash recovery.
const CHECKPOINT_EVERY_DELTAS = 20;

/**
 * Render a branch thread into a single user-message prompt.
 *
 * The thread is root->leaf and ends on the new user turn. For a brand-new root
 * turn (a single user message) we send it verbatim — natural and cheapest. For
 * any multi-turn branch we emit a transcript and instruct the model to continue
 * as the assistant, replying to the final user message. See the long note at the
 * stdin write site for *why* we collapse to one message rather than sending
 * native turns.
 */
export function buildPromptFromThread(thread: ThreadMessage[]): string {
  if (thread.length === 0) return '';
  if (thread.length === 1) return thread[0].content;

  const transcript = thread
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');

  return (
    'You are continuing an ongoing conversation. Below is the full transcript ' +
    'so far. Reply ONLY as the assistant responding to the final user message — ' +
    'no preamble, no role label, just your reply.\n\n' +
    transcript
  );
}

/**
 * Appended to Claude's default system prompt (via --append-system-prompt) so
 * replies use what the message renderer can actually display. The renderer is
 * react-markdown v9 + remark-gfm + remark-math/KaTeX + rehype-highlight, and it
 * does NOT render raw HTML (see Markdown.tsx). Keeping this in sync with that
 * component is what turns "equations shown as plain text" into real math.
 */
export const RENDER_SYSTEM_PROMPT = [
  'Your replies are shown in a desktop chat UI that renders GitHub-Flavored Markdown. Use these display capabilities:',
  '- Math renders with KaTeX. Write LaTeX inside $…$ for inline math and $$…$$ for display equations (e.g. $$E = mc^2$$). Always wrap variables, symbols, and equations in math delimiters instead of writing them as plain text or inside code spans.',
  '- Fenced code blocks are syntax-highlighted. Always tag the language (```python). Use inline `code` for identifiers, filenames, and commands.',
  '- GitHub-Flavored Markdown renders: headings, **bold**, *italic*, bullet/numbered lists, tables, blockquotes, task lists, and links.',
  '- Inline HTML and SVG render (sanitized: <script>, event handlers, <iframe>, and inline styles are stripped). Use inline <svg> for diagrams, charts, and icons, and <img src="data:..."> for raster images. Plain HTML scripts will not execute.',
].join('\n');

/** Build the canonical `claude` CLI argv for one turn. Pure, so it's testable. */
export function buildClaudeArgs(opts: RunOptions): string[] {
  const model = opts.model && opts.model.length > 0 ? opts.model : 'sonnet';
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose', // required for full stream-json output
    '--include-partial-messages', // token-level deltas
    '--no-session-persistence', // we own history; don't write session JSONL
    '--model',
    model,
    '--append-system-prompt',
    RENDER_SYSTEM_PROMPT, // advertise the renderer's display capabilities
    ...opts.addDirs.flatMap((d) => ['--add-dir', d]),
    // 'Act without asking' — let Claude use tools without pausing for approval.
    ...(opts.skipPermissions ? ['--dangerously-skip-permissions'] : []),
  ];
}

// Grace period between SIGTERM and SIGKILL on abort.
const SIGKILL_TIMEOUT_MS = 3000;

export class ClaudeRunner {
  private claudePath: string;
  // Map of nodeId -> in-flight child process.
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(claudePath: string) {
    this.claudePath = claudePath;
  }

  /** Update the resolved binary path (after the user locates it at runtime). */
  setClaudePath(claudePath: string): void {
    this.claudePath = claudePath;
  }

  /** Number of in-flight turns. */
  get active(): number {
    return this.children.size;
  }

  /**
   * Spawn a fresh `claude` subprocess for one turn.
   *
   * Each callback set is bound to exactly this nodeId; failures here never touch
   * another turn's node.
   */
  start(opts: RunOptions, cb: RunCallbacks): void {
    // Canonical invocation. The PRIMARY dir is the process cwd; only the
    // REMAINDER are passed via --add-dir (the IPC layer pre-splits cwd/addDirs).
    const args = buildClaudeArgs(opts);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.claudePath, args, {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Spawn failed synchronously — report and bail without registering.
      cb.onError(`Failed to spawn claude: ${(err as Error).message}`);
      return;
    }

    this.children.set(opts.nodeId, child);

    // --- per-turn state ---
    const parser = new StreamParser();
    let accumulated = ''; // running assistant text from deltas
    let deltaCount = 0; // deltas since last checkpoint
    let resultEmitted = false; // did we see a terminal result event?
    let doneSent = false; // did we already invoke onDone?
    let stderrBuf = '';
    // Track whether an activity indicator is currently showing so we only send
    // the "clear" signal once per transition (not on every text delta).
    let activityActive = false;

    // Guard so a turn reports a failure at most once.
    const fail = (message: string): void => {
      if (doneSent) return;
      doneSent = true;
      cb.onError(message);
    };

    // Process the events produced by feeding a stdout chunk to the parser.
    const handleEmits = (emits: ReturnType<StreamParser['feed']>): void => {
      for (const e of emits) {
        switch (e.kind) {
          case 'delta': {
            // Clear any active indicator (thinking/tool) once text starts flowing.
            if (activityActive) {
              activityActive = false;
              cb.onActivity('', false);
            }
            accumulated += e.text;
            cb.onDelta(e.text);
            // Periodic checkpoint of partial content for crash recovery.
            if (++deltaCount >= CHECKPOINT_EVERY_DELTAS) {
              deltaCount = 0;
              cb.onCheckpoint(accumulated);
            }
            break;
          }
          case 'tool_start': {
            activityActive = true;
            cb.onActivity(e.toolName, true);
            break;
          }
          case 'thinking_start': {
            activityActive = true;
            cb.onActivity('thinking', true);
            break;
          }
          case 'result': {
            resultEmitted = true;
            if (doneSent) break;
            const r = e.result;
            if (r.isError) {
              // Terminal result flagged an error.
              fail(r.errorText ?? 'Claude reported an error');
            } else {
              doneSent = true;
              // Prefer the authoritative result content; fall back to the
              // accumulated deltas if the result text is empty.
              const content = r.content && r.content.length > 0 ? r.content : accumulated;
              cb.onDone({ ...r, content });
            }
            break;
          }
          case 'init':
          case 'ignored':
            // Diagnostics only — nothing to forward.
            break;
        }
      }
    };

    child.stdout.on('data', (d: Buffer) => {
      handleEmits(parser.feed(d.toString('utf8')));
    });

    // Capture stderr for diagnostics / error_text.
    child.stderr.on('data', (d: Buffer) => {
      stderrBuf += d.toString('utf8');
    });

    // If the child process itself errors (e.g. died unexpectedly), report it.
    child.on('error', (err) => {
      this.children.delete(opts.nodeId);
      fail(`claude process error: ${err.message}`);
    });

    child.on('close', (code) => {
      this.children.delete(opts.nodeId);
      // Flush any buffered trailing line through the parser.
      handleEmits(parser.end());

      if (doneSent) return;

      // No terminal result produced before exit -> failure.
      if (!resultEmitted) {
        const detail = stderrBuf.trim();
        fail(detail.length > 0 ? detail : `no result (claude exited with code ${code ?? 'unknown'})`);
        return;
      }

      // Result was seen but we somehow haven't reported done (defensive): if the
      // exit code is non-zero, treat as failure.
      if (code !== 0 && code !== null) {
        const detail = stderrBuf.trim();
        fail(detail.length > 0 ? detail : `claude exited with code ${code}`);
      }
    });

    // --- write the branch to stdin as a SINGLE user message, then close ------
    // DEVIATION FROM SPEC (forced by verified CLI 2.1.168 behavior):
    // `--input-format stream-json` is a *streaming input* mode — it responds to
    // EVERY user message in the stream and IGNORES any assistant messages we
    // inject (it regenerates them). Feeding the native [user, assistant, user]
    // history therefore (a) produces one billed response per user turn and
    // (b) discards our stored/edited/regenerated assistant content, destroying
    // branching fidelity. Verified directly: an injected assistant "Aardvark"
    // is ignored and replaced by the model's own "Elephant".
    //
    // Fix: collapse the branch into ONE user message containing the transcript
    // and ask the model to continue. This yields exactly one response and gives
    // us full control over the history the model sees (our exact stored turns),
    // which is what makes edit/regenerate/branch faithful. Token streaming on
    // stdout is unaffected.
    try {
      const text = buildPromptFromThread(opts.thread);
      const payload =
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
        }) + '\n';
      // Guard against EPIPE if the child already exited.
      child.stdin.on('error', () => {
        /* swallow: handled via 'close'/'error' on the child */
      });
      child.stdin.write(payload);
      child.stdin.end(); // close stdin to signal end of input
    } catch (err) {
      fail(`Failed to write input to claude: ${(err as Error).message}`);
      this.abort(opts.nodeId);
    }
  }

  /**
   * Cancel an in-flight turn: SIGTERM, then SIGKILL after a timeout if
   * the process is still alive. No-op if the nodeId has no active child.
   */
  abort(nodeId: string): void {
    const child = this.children.get(nodeId);
    if (!child) return;

    child.kill('SIGTERM');

    // Escalate to SIGKILL if the process hasn't exited within the grace period.
    const timer = setTimeout(() => {
      // Still tracked => 'close' hasn't fired yet, so force-kill.
      if (this.children.get(nodeId) === child) {
        child.kill('SIGKILL');
      }
    }, SIGKILL_TIMEOUT_MS);
    // Don't let the timer keep the event loop / process alive.
    timer.unref?.();

    // Clear the timer once the child closes to avoid a dangling SIGKILL.
    child.once('close', () => clearTimeout(timer));
  }
}
