// Live end-to-end engine test — exercises Repo + ClaudeRunner + StreamParser
// against the REAL `claude` CLI. Gated behind RUN_LIVE=1 so the normal suite
// never spawns the CLI or incurs cost. Run with:
//   RUN_LIVE=1 npx vitest run test/live.engine.test.ts
import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/database';
import { Repo } from '../src/main/db/repo';
import { ClaudeRunner } from '../src/main/claude/runner';
import { resolveClaude } from '../src/main/claude/resolve';
import type { TurnResult } from '../src/main/claude/parser';
import { tmpdir } from 'node:os';

const live = process.env.RUN_LIVE ? describe : describe.skip;

live('LIVE engine round-trip (real claude CLI)', () => {
  it('streams a real turn end-to-end and persists it', async () => {
    const status = await resolveClaude();
    expect(status.ok, status.error ?? 'claude not resolved').toBe(true);

    const db = openDatabase(':memory:');
    const repo = new Repo(db);
    const convId = repo.createConversation({ model: 'haiku' });

    // Root user turn, then a streaming assistant node to fill.
    const user = repo.insertUserNode({
      conversationId: convId,
      parentId: null,
      content: 'Reply with exactly the word: PONG',
    });
    const asst = repo.insertStreamingAssistant({
      conversationId: convId,
      parentId: user.id,
      model: 'haiku',
    });

    // Mirror the IPC handler: the send-thread is reconstructed from the USER
    // node id, so it ends on the new user turn and excludes the empty streaming
    // assistant node we just inserted.
    const thread = repo.getThread(user.id);
    expect(thread.map((m) => m.role)).toEqual(['user']);

    const runner = new ClaudeRunner(status.claudePath ?? 'claude');
    let streamed = '';

    const result = await new Promise<TurnResult>((resolveDone, reject) => {
      runner.start(
        {
          nodeId: asst.id,
          cwd: tmpdir(),
          addDirs: [],
          model: 'haiku',
          thread,
        },
        {
          onDelta: (t) => {
            streamed += t;
          },
          onCheckpoint: (c) => repo.checkpointAssistant(asst.id, c),
          onDone: (r) => resolveDone(r),
          onError: (m) => reject(new Error(m)),
        }
      );
    });

    repo.completeAssistant(asst.id, {
      content: result.content,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('PONG');
    expect(streamed.length).toBeGreaterThan(0);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);

    const persisted = repo.getNode(asst.id);
    expect(persisted?.status).toBe('complete');
    expect(persisted?.content).toContain('PONG');

    // Full thread now reconstructs as [user, assistant].
    const full = repo.getThread(asst.id);
    expect(full.map((m) => m.role)).toEqual(['user', 'assistant']);

    // --- FOLLOW-UP TURN (regression guard for the multi-turn input bug) -------
    // A second turn's thread is [user, assistant, user]; the prior assistant
    // message must be encoded as content blocks or the CLI throws
    // `Z is not an Object. (evaluating '"tool_use_id" in Z')`. This is exactly
    // the case that the single-turn tests never exercised.
    const user2 = repo.insertUserNode({
      conversationId: convId,
      parentId: asst.id,
      content: 'Now reply with exactly the word: PING',
    });
    const asst2 = repo.insertStreamingAssistant({
      conversationId: convId,
      parentId: user2.id,
      model: 'haiku',
    });
    const thread2 = repo.getThread(user2.id);
    expect(thread2.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

    const result2 = await new Promise<TurnResult>((resolveDone, reject) => {
      runner.start(
        { nodeId: asst2.id, cwd: tmpdir(), addDirs: [], model: 'haiku', thread: thread2 },
        {
          onDelta: () => {},
          onCheckpoint: () => {},
          onDone: (r) => resolveDone(r),
          onError: (m) => reject(new Error(m)),
        }
      );
    });

    expect(result2.isError, result2.errorText ?? '').toBe(false);
    expect(result2.content).toContain('PING');
  }, 90000);
});
