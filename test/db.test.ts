// Tests for the persistence layer: schema/pragmas (DB-2, DB-3), the branching
// model (BR-1..BR-4), thread reconstruction (RC-2), and directory scoping (RC-3).
// Uses an in-memory SQLite database so the suite is hermetic and fast.

import { describe, it, expect, beforeEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { openDatabase } from '../src/main/db/database';
import { Repo } from '../src/main/db/repo';

let db: DatabaseType.Database;
let repo: Repo;

beforeEach(() => {
  // openDatabase applies pragmas (DB-2) and migrations (DB-6) before use.
  db = openDatabase(':memory:');
  repo = new Repo(db);
});

describe('Repo — conversations & thread assembly (RC-2)', () => {
  it('creates a conversation and reconstructs a root-first thread', () => {
    const convId = repo.createConversation({ title: 'T', model: 'sonnet' });
    expect(typeof convId).toBe('string');

    // BR-2: first user turn is the root (parent_id = NULL).
    const user = repo.insertUserNode({ conversationId: convId, parentId: null, content: 'hello' });
    expect(user.parent_id).toBeNull();
    expect(user.role).toBe('user');

    // DB-4: assistant starts streaming, then completes with usage/cost.
    const asst = repo.insertStreamingAssistant({
      conversationId: convId,
      parentId: user.id,
      model: 'sonnet',
    });
    expect(asst.status).toBe('streaming');
    repo.completeAssistant(asst.id, {
      content: 'hi there',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    });

    const completed = repo.getNode(asst.id);
    expect(completed?.status).toBe('complete');
    expect(completed?.completed_at).toBeTypeOf('number');

    // RC-2: thread is [user, assistant], root-first, with correct contents.
    const thread = repo.getThread(asst.id);
    expect(thread).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('lists conversations and exposes them via getConversation', () => {
    const convId = repo.createConversation({ title: 'L' });
    const user = repo.insertUserNode({ conversationId: convId, parentId: null, content: 'q' });

    const list = repo.listConversations();
    expect(list.some((c) => c.id === convId)).toBe(true);

    const tree = repo.getConversation(convId);
    expect(tree.conversation.id).toBe(convId);
    expect(tree.nodes.some((n) => n.id === user.id)).toBe(true);
  });
});

describe('Repo — branching model (BR-1..BR-4)', () => {
  it('enforces strict role alternation on insert (BR-1)', () => {
    const convId = repo.createConversation({});
    const user = repo.insertUserNode({ conversationId: convId, parentId: null, content: 'u1' });
    // A user node may not be a child of another user node.
    expect(() =>
      repo.insertUserNode({ conversationId: convId, parentId: user.id, content: 'u2' }),
    ).toThrow();
  });

  it('supports regenerate: two assistant siblings under one user parent (BR-2)', () => {
    const convId = repo.createConversation({});
    const user = repo.insertUserNode({ conversationId: convId, parentId: null, content: 'u' });

    const a1 = repo.insertStreamingAssistant({ conversationId: convId, parentId: user.id, model: null });
    repo.completeAssistant(a1.id, { content: 'first', inputTokens: null, outputTokens: null, costUsd: null });

    const a2 = repo.insertStreamingAssistant({ conversationId: convId, parentId: user.id, model: null });
    repo.completeAssistant(a2.id, { content: 'second', inputTokens: null, outputTokens: null, costUsd: null });

    const children = repo
      .getConversation(convId)
      .nodes.filter((n) => n.parent_id === user.id);
    expect(children).toHaveLength(2);
  });

  it('switches the active leaf without generating (BR-2)', () => {
    const convId = repo.createConversation({});
    const user = repo.insertUserNode({ conversationId: convId, parentId: null, content: 'u' });
    const a1 = repo.insertStreamingAssistant({ conversationId: convId, parentId: user.id, model: null });
    repo.completeAssistant(a1.id, { content: 'one', inputTokens: null, outputTokens: null, costUsd: null });
    const a2 = repo.insertStreamingAssistant({ conversationId: convId, parentId: user.id, model: null });
    repo.completeAssistant(a2.id, { content: 'two', inputTokens: null, outputTokens: null, costUsd: null });

    repo.setActiveLeaf(convId, a1.id);
    expect(repo.getConversation(convId).conversation.active_leaf).toBe(a1.id);
    repo.setActiveLeaf(convId, a2.id);
    expect(repo.getConversation(convId).conversation.active_leaf).toBe(a2.id);
  });

  it('cascades deletes through the subtree (BR-4)', () => {
    const convId = repo.createConversation({});
    const user = repo.insertUserNode({ conversationId: convId, parentId: null, content: 'u' });
    const asst = repo.insertStreamingAssistant({ conversationId: convId, parentId: user.id, model: null });
    repo.completeAssistant(asst.id, { content: 'a', inputTokens: null, outputTokens: null, costUsd: null });

    // Deleting the root removes the entire subtree (ON DELETE CASCADE).
    repo.deleteNode(user.id);
    expect(repo.getNode(user.id)).toBeUndefined();
    expect(repo.getNode(asst.id)).toBeUndefined();
    expect(repo.getConversation(convId).nodes).toHaveLength(0);
  });
});

describe('Repo — directory scoping (RC-3)', () => {
  it('includes on-path attachments and excludes off-path ones', () => {
    const convId = repo.createConversation({});

    // Build two branches off a shared root user node:
    //   userRoot -> asst -> userBranchA   (on the active path / leaf)
    //   userRoot -> asstOff               (off-path sibling)
    const userRoot = repo.insertUserNode({ conversationId: convId, parentId: null, content: 'root' });
    const asst = repo.insertStreamingAssistant({ conversationId: convId, parentId: userRoot.id, model: null });
    repo.completeAssistant(asst.id, { content: 'a', inputTokens: null, outputTokens: null, costUsd: null });
    const leaf = repo.insertUserNode({ conversationId: convId, parentId: asst.id, content: 'followup' });

    const asstOff = repo.insertStreamingAssistant({ conversationId: convId, parentId: userRoot.id, model: null });
    repo.completeAssistant(asstOff.id, { content: 'off', inputTokens: null, outputTokens: null, costUsd: null });

    // Attach a dir to a node on the leaf's path (the root) -> should be effective.
    repo.addAttachment({ conversationId: convId, nodeId: userRoot.id, dirPath: '/on/path/dir' });
    // Attach a dir to an off-path node -> must be excluded for this leaf.
    repo.addAttachment({ conversationId: convId, nodeId: asstOff.id, dirPath: '/off/path/dir' });

    const dirs = repo.effectiveDirs(leaf.id);
    expect(dirs).toContain('/on/path/dir');
    expect(dirs).not.toContain('/off/path/dir');
  });

  it('treats a conversation-wide attachment (node_id NULL) as always effective (RC-3)', () => {
    const convId = repo.createConversation({});
    const leaf = repo.insertUserNode({ conversationId: convId, parentId: null, content: 'root' });
    repo.addAttachment({ conversationId: convId, nodeId: null, dirPath: '/whole/conv/dir' });
    expect(repo.effectiveDirs(leaf.id)).toContain('/whole/conv/dir');
  });
});
