// Unit tests for buildPromptFromThread — the branch->prompt collapsing that
// works around the CLI's stream-json multi-message behavior (it responds to
// every user turn and ignores injected assistant content). Pure function; no
// subprocess is spawned.
import { describe, it, expect } from 'vitest';
import {
  buildPromptFromThread,
  buildClaudeArgs,
  RENDER_SYSTEM_PROMPT,
  type ThreadMessage,
  type RunOptions,
} from '../src/main/claude/runner';

describe('buildPromptFromThread', () => {
  it('sends a single root user turn verbatim (no transcript wrapper)', () => {
    const thread: ThreadMessage[] = [{ role: 'user', content: 'hello world' }];
    expect(buildPromptFromThread(thread)).toBe('hello world');
  });

  it('collapses a multi-turn branch into one transcript prompt', () => {
    const thread: ThreadMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there!' },
      { role: 'user', content: 'say PING' },
    ];
    const out = buildPromptFromThread(thread);
    // Contains every turn, labeled, in order, ending on the final user message.
    expect(out).toContain('User: hi');
    expect(out).toContain('Assistant: Hello there!');
    expect(out.trimEnd().endsWith('User: say PING')).toBe(true);
    // Instructs the model to continue as the assistant.
    expect(out.toLowerCase()).toContain('assistant');
  });

  it('handles an empty thread', () => {
    expect(buildPromptFromThread([])).toBe('');
  });
});

describe('buildClaudeArgs', () => {
  const base: RunOptions = {
    nodeId: 'n1',
    cwd: '/tmp',
    addDirs: [],
    thread: [{ role: 'user', content: 'hi' }],
  };

  it('appends the render-capabilities system prompt (so math/code/markdown render)', () => {
    const args = buildClaudeArgs(base);
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(RENDER_SYSTEM_PROMPT);
    // The prompt must actually advertise the key capabilities.
    expect(RENDER_SYSTEM_PROMPT).toContain('KaTeX');
    expect(RENDER_SYSTEM_PROMPT).toContain('$$');
    expect(RENDER_SYSTEM_PROMPT).toContain('SVG');
    expect(RENDER_SYSTEM_PROMPT).toContain('react-app');
    expect(RENDER_SYSTEM_PROMPT).toContain('html-app');
    expect(RENDER_SYSTEM_PROMPT.toLowerCase()).toContain('syntax-highlighted');
    expect(RENDER_SYSTEM_PROMPT.toLowerCase()).toContain('sanitized');
  });

  it('defaults the model to sonnet and passes an explicit model through', () => {
    const m = (args: string[]) => args[args.indexOf('--model') + 1];
    expect(m(buildClaudeArgs(base))).toBe('sonnet');
    expect(m(buildClaudeArgs({ ...base, model: 'opus' }))).toBe('opus');
  });

  it('passes each attached dir via --add-dir and adds skip-permissions only when asked', () => {
    const args = buildClaudeArgs({ ...base, addDirs: ['/a', '/b'], skipPermissions: true });
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(2);
    expect(args).toContain('/a');
    expect(args).toContain('/b');
    expect(args).toContain('--dangerously-skip-permissions');
    // Default: no skip-permissions flag.
    expect(buildClaudeArgs(base)).not.toContain('--dangerously-skip-permissions');
  });
});
