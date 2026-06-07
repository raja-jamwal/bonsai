// Branching behavior — engine-level tests for the tree operations that back
// "Fork from here", regenerate, and edit-user. These lock in the invariants the
// UI relies on: forks are always descendants of one shared root (never a second
// root), the original branch is preserved, and every branch reconstructs the
// full shared prefix + its own messages (RC-2 / BR-2 / BR-3).
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../src/main/db/database';
import { Repo } from '../src/main/db/repo';
import type Database from 'better-sqlite3';

let db: Database.Database;
let repo: Repo;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new Repo(db);
});

/** Insert a completed assistant turn (helper around the streaming primitives). */
function answer(cid: string, parentId: string, content: string): string {
  const a = repo.insertStreamingAssistant({ conversationId: cid, parentId, model: null });
  repo.completeAssistant(a.id, { content, inputTokens: 1, outputTokens: 1, costUsd: 0 });
  return a.id;
}

/** Build a linear conversation: q1 → a1 → q2 → a2 ... from the given turns. */
function linear(cid: string, turns: Array<[string, string]>): {
  users: string[];
  assistants: string[];
} {
  const users: string[] = [];
  const assistants: string[] = [];
  let parent: string | null = null;
  for (const [q, a] of turns) {
    const u = repo.insertUserNode({ conversationId: cid, parentId: parent, content: q });
    users.push(u.id);
    const aid = answer(cid, u.id, a);
    assistants.push(aid);
    parent = aid;
  }
  return { users, assistants };
}

const childrenOf = (cid: string, parentId: string | null) =>
  repo.getConversation(cid).nodes.filter((n) => n.parent_id === parentId);
const roots = (cid: string) =>
  repo.getConversation(cid).nodes.filter((n) => n.parent_id === null);

describe('Branching — fork from a leaf answer (forkLeafAssistant)', () => {
  it('keeps the original answer, snapshots it for the new branch, shares history, one root', () => {
    const cid = repo.createConversation({});
    const { users, assistants } = linear(cid, [['I want to learn about torch.nn', 'torch.nn is …']]);
    const u1 = users[0];
    const a1 = assistants[0];

    const { userNodeId } = repo.forkLeafAssistant({
      leafAssistantId: a1,
      content: 'def forward(self, x): return self.linear(x)',
      model: null,
    });

    // The question now forks into the original answer + a snapshot of it.
    const qKids = childrenOf(cid, u1);
    expect(qKids).toHaveLength(2);
    expect(qKids.map((n) => n.role)).toEqual(['assistant', 'assistant']);

    // Original answer is untouched and remains a leaf (its own branch, BR-3).
    expect(childrenOf(cid, a1)).toHaveLength(0);

    // The snapshot carries the original answer's content and heads the new branch.
    const snapshot = qKids.find((n) => n.id !== a1)!;
    expect(snapshot.content).toBe('torch.nn is …');
    const newUser = repo.getNode(userNodeId)!;
    expect(newUser.parent_id).toBe(snapshot.id);

    // The new branch shows the previous conversation + the new message.
    expect(repo.getThread(userNodeId)).toEqual([
      { role: 'user', content: 'I want to learn about torch.nn' },
      { role: 'assistant', content: 'torch.nn is …' },
      { role: 'user', content: 'def forward(self, x): return self.linear(x)' },
    ]);

    // Never a second root.
    expect(roots(cid)).toHaveLength(1);
  });

  it('forking the same leaf twice yields three branches off one question', () => {
    const cid = repo.createConversation({});
    const a1 = linear(cid, [['q', 'a']]).assistants[0];
    const u1 = repo.getNode(a1)!.parent_id!;
    repo.forkLeafAssistant({ leafAssistantId: a1, content: 'branch one', model: null });
    repo.forkLeafAssistant({ leafAssistantId: a1, content: 'branch two', model: null });
    // original answer + 2 snapshots = 3 children of the question.
    expect(childrenOf(cid, u1)).toHaveLength(3);
    expect(roots(cid)).toHaveLength(1);
  });
});

describe('Branching — fork a mid-conversation answer (sibling continuation)', () => {
  it('creates a 2-way fork at the answer; both branches share the prefix', () => {
    const cid = repo.createConversation({});
    const { users, assistants } = linear(cid, [['q1', 'a1'], ['q2', 'a2']]);
    const [a1, a2] = assistants;

    // Fork from a1 (which already has the q2 continuation): a sibling user turn.
    const alt = repo.insertUserNode({ conversationId: cid, parentId: a1, content: 'q2-alt' });
    const altA = answer(cid, alt.id, 'a2-alt');

    // a1 now has two children (the original q2 and the new q2-alt).
    expect(childrenOf(cid, a1).map((n) => n.role)).toEqual(['user', 'user']);
    expect(childrenOf(cid, a1)).toHaveLength(2);

    // Both branches reconstruct the shared prefix q1→a1, then diverge.
    expect(repo.getThread(a2)).toEqual([
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
    ]);
    expect(repo.getThread(altA)).toEqual([
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2-alt' }, { role: 'assistant', content: 'a2-alt' },
    ]);
    expect(roots(cid)).toHaveLength(1);
    void users;
  });
});

describe('Branching — regenerate (sibling answer to the same question)', () => {
  it('adds a second assistant child under the same user turn; original retained', () => {
    const cid = repo.createConversation({});
    const { users, assistants } = linear(cid, [['q1', 'a1']]);
    const u1 = users[0];
    const a1 = assistants[0];

    const a1b = answer(cid, u1, 'a1-regenerated');

    expect(childrenOf(cid, u1).map((n) => n.role)).toEqual(['assistant', 'assistant']);
    expect(repo.getNode(a1)!.content).toBe('a1'); // original immutable (BR-3)
    expect(repo.getThread(a1b)).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1-regenerated' },
    ]);
  });
});

describe('Branching — edit a user turn (sibling question, original subtree kept)', () => {
  it('creates a sibling user turn under the same parent; both subtrees survive', () => {
    const cid = repo.createConversation({});
    const { users, assistants } = linear(cid, [['q1', 'a1'], ['q2', 'a2']]);
    const a1 = assistants[0];
    const u2 = users[1];

    // Edit u2 = new sibling user under u2's parent (a1).
    const edited = repo.insertUserNode({ conversationId: cid, parentId: repo.getNode(u2)!.parent_id, content: 'q2-edited' });
    const editedA = answer(cid, edited.id, 'a2-edited');

    expect(childrenOf(cid, a1)).toHaveLength(2); // q2 and q2-edited
    // Original q2 subtree retained.
    expect(repo.getThread(repo.getConversation(cid).nodes.find((n) => n.parent_id === u2)!.id)).toEqual([
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
    ]);
    expect(repo.getThread(editedA)).toEqual([
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2-edited' }, { role: 'assistant', content: 'a2-edited' },
    ]);
  });
});

describe('Branching — invariants', () => {
  it('BR-1: alternation is enforced (no user under user, no assistant under assistant)', () => {
    const cid = repo.createConversation({});
    const u1 = repo.insertUserNode({ conversationId: cid, parentId: null, content: 'q1' });
    expect(() =>
      repo.insertUserNode({ conversationId: cid, parentId: u1.id, content: 'bad' })
    ).toThrow();
  });

  it('BR-4: deleting one branch cascades only that subtree; siblings + prefix survive', () => {
    const cid = repo.createConversation({});
    const a1 = linear(cid, [['q', 'a']]).assistants[0];
    const u1 = repo.getNode(a1)!.parent_id!;
    const f1 = repo.forkLeafAssistant({ leafAssistantId: a1, content: 'branch one', model: null });
    repo.forkLeafAssistant({ leafAssistantId: a1, content: 'branch two', model: null });
    expect(childrenOf(cid, u1)).toHaveLength(3);

    // Delete the snapshot heading "branch one" -> removes that branch only.
    const snapshotOne = repo.getNode(f1.userNodeId)!.parent_id!;
    repo.deleteNode(snapshotOne);

    expect(childrenOf(cid, u1)).toHaveLength(2); // original + branch two remain
    expect(repo.getNode(f1.userNodeId)).toBeUndefined(); // branch one's user gone
    expect(repo.getNode(a1)).toBeDefined(); // original answer survives
    expect(roots(cid)).toHaveLength(1);
  });

  it('switching the active leaf does not mutate the tree (BR-3)', () => {
    const cid = repo.createConversation({});
    const a1 = linear(cid, [['q', 'a']]).assistants[0];
    repo.forkLeafAssistant({ leafAssistantId: a1, content: 'other', model: null });
    const before = repo.getConversation(cid).nodes.length;
    repo.setActiveLeaf(cid, a1); // switch to the original branch
    expect(repo.getConversation(cid).conversation.active_leaf).toBe(a1);
    expect(repo.getConversation(cid).nodes.length).toBe(before); // no nodes added/removed
  });
});
