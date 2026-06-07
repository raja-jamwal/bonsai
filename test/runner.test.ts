// Unit tests for buildPromptFromThread — the branch->prompt collapsing that
// works around the CLI's stream-json multi-message behavior (it responds to
// every user turn and ignores injected assistant content). Pure function; no
// subprocess is spawned.
import { describe, it, expect } from 'vitest';
import { buildPromptFromThread, type ThreadMessage } from '../src/main/claude/runner';

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
