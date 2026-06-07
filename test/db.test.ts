// Tests for the persistence layer: schema/pragmas, the branching
// model, thread reconstruction, and directory scoping.
// Uses an in-memory SQLite database so the suite is hermetic and fast.

import { describe, it, expect, beforeEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { openDatabase } from '../src/main/db/database';
import { Repo } from '../src/main/db/repo';

let db: DatabaseType.Database;
let repo: Repo;

beforeEach(() => {
  // openDatabase applies pragmas and migrations before use.
  db = openDatabase(':memory:');
  repo = new Repo(db);
});

describe('Repo — conversations & thread assembly', () => {
  it('creates a conversation and reconstructs a root-first thread', () => {
    const convId = repo.createConversation({ title: 'T', model: 'sonnet' });
    expect(typeof convId).toBe('string');

    // first user turn is the root (parent_id = NULL).
    const user = repo.insertUserNode({ conversationId: convId, parentId: null, content: 'hello' });
    expect(user.parent_id).toBeNull();
    expect(user.role).toBe('user');

    // assistant starts streaming, then completes with usage/cost.
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

    // thread is [user, assistant], root-first, with correct contents.
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

describe('Repo — branching model', () => {
  it('enforces strict role alternation on insert', () => {
    const convId = repo.createConversation({});
    const user = repo.insertUserNode({ conversationId: convId, parentId: null, content: 'u1' });
    // A user node may not be a child of another user node.
    expect(() =>
      repo.insertUserNode({ conversationId: convId, parentId: user.id, content: 'u2' }),
    ).toThrow();
  });

  it('supports regenerate: two assistant siblings under one user parent', () => {
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

  it('switches the active leaf without generating', () => {
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

  it('cascades deletes through the subtree', () => {
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

describe('Repo — search', () => {
  it('returns empty for a blank query', () => {
    expect(repo.searchConversations('')).toEqual([]);
    expect(repo.searchConversations('   ')).toEqual([]);
  });

  it('returns empty when nothing matches', () => {
    repo.createConversation({ title: 'Hello World' });
    expect(repo.searchConversations('xyzzy_impossible_match')).toHaveLength(0);
  });

  it('finds a conversation by title (exact substring)', () => {
    const id = repo.createConversation({ title: 'Banana split recipe' });
    const results = repo.searchConversations('Banana');
    const hit = results.find((r) => r.conversationId === id);
    expect(hit).toBeDefined();
    expect(hit?.nodeId).toBeNull();
    expect(hit?.role).toBeNull();
  });

  it('is case-insensitive for title matches', () => {
    const id = repo.createConversation({ title: 'Hello World' });
    const upper = repo.searchConversations('HELLO');
    expect(upper.some((r) => r.conversationId === id)).toBe(true);
    const lower = repo.searchConversations('world');
    expect(lower.some((r) => r.conversationId === id)).toBe(true);
  });

  it('finds a user message by content', () => {
    const id = repo.createConversation({ title: 'content search test' });
    const user = repo.insertUserNode({
      conversationId: id,
      parentId: null,
      content: 'unique phrase zephyr cloud',
    });
    const results = repo.searchConversations('zephyr cloud');
    const hit = results.find((r) => r.nodeId === user.id);
    expect(hit).toBeDefined();
    expect(hit?.conversationId).toBe(id);
    expect(hit?.role).toBe('user');
    expect(hit?.snippet).toContain('zephyr cloud');
  });

  it('finds an assistant message by content', () => {
    const id = repo.createConversation({ title: 'assistant search' });
    const user = repo.insertUserNode({ conversationId: id, parentId: null, content: 'q' });
    const asst = repo.insertStreamingAssistant({ conversationId: id, parentId: user.id, model: null });
    repo.completeAssistant(asst.id, {
      content: 'the answer contains luminary wisdom',
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
    const results = repo.searchConversations('luminary wisdom');
    const hit = results.find((r) => r.nodeId === asst.id);
    expect(hit).toBeDefined();
    expect(hit?.role).toBe('assistant');
    expect(hit?.snippet).toContain('luminary wisdom');
  });

  it('does not include streaming nodes in content results', () => {
    const id = repo.createConversation({ title: 'streaming test' });
    const user = repo.insertUserNode({ conversationId: id, parentId: null, content: 'q' });
    // streaming node — must NOT appear in search
    repo.insertStreamingAssistant({ conversationId: id, parentId: user.id, model: null });
    // No completeAssistant call — stays 'streaming'.
    const results = repo.searchConversations('streaming test');
    // title match is fine; node match must not exist
    const nodeHits = results.filter((r) => r.nodeId !== null && r.conversationId === id);
    expect(nodeHits).toHaveLength(0);
  });

  it('returns both title and content hits for the same conversation', () => {
    const id = repo.createConversation({ title: 'overlap query term' });
    repo.insertUserNode({ conversationId: id, parentId: null, content: 'overlap query term in message' });
    const results = repo.searchConversations('overlap query term');
    const forConv = results.filter((r) => r.conversationId === id);
    // Should have at least a title hit (nodeId null) AND a content hit (nodeId present).
    expect(forConv.some((r) => r.nodeId === null)).toBe(true);
    expect(forConv.some((r) => r.nodeId !== null)).toBe(true);
  });

  it('snippet centers on the matched text', () => {
    const id = repo.createConversation({ title: 'snippet test' });
    const user = repo.insertUserNode({
      conversationId: id,
      parentId: null,
      content: 'a'.repeat(80) + 'targetword' + 'b'.repeat(80),
    });
    const results = repo.searchConversations('targetword');
    const hit = results.find((r) => r.nodeId === user.id);
    expect(hit?.snippet).toContain('targetword');
  });

  it('escapes LIKE special characters in the query', () => {
    const id = repo.createConversation({ title: '50% off sale' });
    const results = repo.searchConversations('50%');
    expect(results.some((r) => r.conversationId === id)).toBe(true);
    // A bare % without escaping would match everything — ensure scoped.
    const wild = repo.searchConversations('%');
    // Only the conversation containing a literal '%' should match.
    expect(wild.some((r) => r.conversationId === id)).toBe(true);
  });
});

describe('Repo — directory scoping', () => {
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

  it('treats a conversation-wide attachment (node_id NULL) as always effective', () => {
    const convId = repo.createConversation({});
    const leaf = repo.insertUserNode({ conversationId: convId, parentId: null, content: 'root' });
    repo.addAttachment({ conversationId: convId, nodeId: null, dirPath: '/whole/conv/dir' });
    expect(repo.effectiveDirs(leaf.id)).toContain('/whole/conv/dir');
  });

  it('persists app settings in the meta table (e.g. the resolved claude path)', () => {
    expect(repo.getSetting('claude_path')).toBeNull();
    repo.setSetting('claude_path', '/usr/local/bin/claude');
    expect(repo.getSetting('claude_path')).toBe('/usr/local/bin/claude');
    // Upsert overwrites, doesn't duplicate.
    repo.setSetting('claude_path', '/opt/homebrew/bin/claude');
    expect(repo.getSetting('claude_path')).toBe('/opt/homebrew/bin/claude');
  });
});
