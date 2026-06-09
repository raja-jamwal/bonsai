/// <reference lib="dom" />
// Fork end-to-end — drives the REAL renderer store (forkFrom + sendTurn + the
// turn actions) against a fake bridge backed by a real in-memory Repo. This is
// the closest thing to "use the app and fork from every message" without an
// Electron window: the store decides how a fork attaches, the repo performs the
// actual tree mutation, and we assert the resulting tree shape + reconstructed
// threads.
//
// Scenario per the user's ask: open a NEW conversation, send a couple of turns,
// then fork from each message (user AND assistant, mid-conversation AND leaf)
// and verify the branch lands where it should.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../src/main/db/database';
import { Repo } from '../src/main/db/repo';
import type { BridgeApi } from '../src/shared/types';

// ---------------------------------------------------------------------------
// Fake bridge: every turn-starting call inserts the user + a streaming
// assistant via the real Repo, then immediately COMPLETES the assistant with a
// canned reply and remembers it so onTurnEvent can replay a synchronous 'done'
// (mirroring the streaming pipeline the real preload drives).
// ---------------------------------------------------------------------------
// Records abort calls so tests can assert the Stop button reaches the bridge
// (regression: the button used to call a non-existent window.bridge.abortTurn).
const abortCalls: string[] = [];

function makeBridge(repo: Repo): BridgeApi {
  const pendingDone = new Map<string, string>();
  const reply = (content: string): string => `reply:${content}`;

  function finish(assistantId: string, content: string): void {
    repo.completeAssistant(assistantId, {
      content,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
    pendingDone.set(assistantId, content);
  }

  const api: Partial<BridgeApi> = {
    async getConversation(id) {
      return repo.getConversation(id);
    },
    async listConversations() {
      return repo.listConversations();
    },
    async sendTurn(args) {
      const user = repo.insertUserNode({
        conversationId: args.conversationId,
        parentId: args.parentId,
        content: args.content,
      });
      const asst = repo.insertStreamingAssistant({
        conversationId: args.conversationId,
        parentId: user.id,
        model: args.model ?? null,
      });
      finish(asst.id, reply(args.content));
      return { assistantNodeId: asst.id, userNodeId: user.id };
    },
    async forkLeaf(args) {
      const leaf = repo.getNode(args.leafAssistantId)!;
      const { userNodeId } = repo.forkLeafAssistant({
        leafAssistantId: args.leafAssistantId,
        content: args.content,
        model: null,
      });
      const asst = repo.insertStreamingAssistant({
        conversationId: leaf.conversation_id,
        parentId: userNodeId,
        model: null,
      });
      finish(asst.id, reply(args.content));
      return { assistantNodeId: asst.id, userNodeId };
    },
    async regenerate(args) {
      const old = repo.getNode(args.assistantNodeId)!;
      const asst = repo.insertStreamingAssistant({
        conversationId: old.conversation_id,
        parentId: old.parent_id!,
        model: null,
      });
      finish(asst.id, reply('regen'));
      return { assistantNodeId: asst.id };
    },
    async editUser(args) {
      const old = repo.getNode(args.userNodeId)!;
      const user = repo.insertUserNode({
        conversationId: old.conversation_id,
        parentId: old.parent_id,
        content: args.content,
      });
      const asst = repo.insertStreamingAssistant({
        conversationId: old.conversation_id,
        parentId: user.id,
        model: null,
      });
      finish(asst.id, reply(args.content));
      return { assistantNodeId: asst.id, userNodeId: user.id };
    },
    async switchBranch(args) {
      repo.setActiveLeaf(args.conversationId, args.leafId);
    },
    async abortTurn(args) {
      abortCalls.push(args.nodeId);
      // Mirror the real handler: keep partial content, mark the node complete.
      const node = repo.getNode(args.nodeId);
      if (node && node.status === 'streaming') {
        repo.completeAssistant(args.nodeId, {
          content: node.content,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        });
      }
    },
    async deleteNode(args) {
      repo.deleteNode(args.nodeId);
    },
    async generateNodeTitle() {
      return null;
    },
    onTurnEvent(assistantNodeId, handler) {
      const content = pendingDone.get(assistantNodeId);
      if (content !== undefined) {
        handler({
          type: 'done',
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          durationMs: 1,
          content,
        });
        pendingDone.delete(assistantNodeId);
      }
      return () => {};
    },
  };
  return api as BridgeApi;
}

// Let the not-awaited refreshTree/refreshConversations in the 'done' handler settle.
const tick = () => new Promise((r) => setTimeout(r, 0));

let repo: Repo;
let store: typeof import('../src/renderer/state/store')['__test'];
let cid: string;

beforeEach(async () => {
  vi.resetModules(); // fresh store module => fresh module-level state per test
  abortCalls.length = 0;
  repo = new Repo(openDatabase(':memory:'));
  (globalThis as unknown as { window: unknown }).window = { api: makeBridge(repo) };
  store = (await import('../src/renderer/state/store')).__test;
  cid = repo.createConversation({});
  await store.openConversation(cid);
});

/** Children of a node (by content), oldest first — what the UI sees as siblings. */
const kids = (parentId: string | null) =>
  repo
    .getConversation(cid)
    .nodes.filter((n) => n.parent_id === parentId)
    .sort((a, b) => a.created_at - b.created_at);
const roots = () => kids(null);
const byContent = (c: string) =>
  repo.getConversation(cid).nodes.find((n) => n.content === c)!;

/** Build a 2-turn linear conversation: A → reply:A → C → reply:C. */
async function seedTwoTurns() {
  await store.sendTurn('A');
  await tick();
  await store.sendTurn('C');
  await tick();
}

describe('Fork e2e — every message is forkable', () => {
  it('seeds a clean linear conversation (sanity)', async () => {
    await seedTwoTurns();
    // uA -> aB -> uC -> aD, single spine, one root.
    expect(roots()).toHaveLength(1);
    const uA = byContent('A');
    const aB = byContent('reply:A');
    const uC = byContent('C');
    const aD = byContent('reply:C');
    expect(aB.parent_id).toBe(uA.id);
    expect(uC.parent_id).toBe(aB.id);
    expect(aD.parent_id).toBe(uC.id);
    expect(repo.getThread(aD.id)).toEqual([
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'reply:A' },
      { role: 'user', content: 'C' },
      { role: 'assistant', content: 'reply:C' },
    ]);
  });

  it('fork from a MID-CONVERSATION ASSISTANT → sibling branch sharing the prefix', async () => {
    await seedTwoTurns();
    const aB = byContent('reply:A'); // assistant with a continuation (uC)

    store.forkFrom(aB.id);
    await store.sendTurn('C-alt');
    await tick();

    // aB now has two user children: original C and the new C-alt.
    expect(kids(aB.id).map((n) => n.content).sort()).toEqual(['C', 'C-alt']);
    // The new branch shares A → reply:A then diverges.
    expect(repo.getThread(byContent('reply:C-alt').id)).toEqual([
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'reply:A' },
      { role: 'user', content: 'C-alt' },
      { role: 'assistant', content: 'reply:C-alt' },
    ]);
    // Original branch untouched; still one root.
    expect(repo.getThread(byContent('reply:C').id)).toContainEqual({
      role: 'user',
      content: 'C',
    });
    expect(roots()).toHaveLength(1);
  });

  it('fork from a MID-CONVERSATION USER → re-ask as a sibling under the same assistant', async () => {
    await seedTwoTurns();
    const aB = byContent('reply:A');
    const uC = byContent('C');

    store.forkFrom(uC.id); // re-ask the "C" question differently
    await store.sendTurn('C-reask');
    await tick();

    // The new question is a sibling of C, both under assistant aB.
    expect(kids(aB.id).map((n) => n.content).sort()).toEqual(['C', 'C-reask']);
    expect(repo.getThread(byContent('reply:C-reask').id)).toEqual([
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'reply:A' },
      { role: 'user', content: 'C-reask' },
      { role: 'assistant', content: 'reply:C-reask' },
    ]);
    expect(roots()).toHaveLength(1);
  });

  it('fork from a LEAF ASSISTANT → snapshots it, original branch preserved, one root', async () => {
    await seedTwoTurns();
    const uC = byContent('C');
    const aD = byContent('reply:C'); // the leaf answer

    store.forkFrom(aD.id);
    await store.sendTurn('D-followup');
    await tick();

    // The question uC now forks into the original answer + a snapshot of it.
    const uCkids = kids(uC.id);
    expect(uCkids).toHaveLength(2);
    expect(uCkids.every((n) => n.role === 'assistant')).toBe(true);
    expect(uCkids.map((n) => n.content)).toEqual(['reply:C', 'reply:C']); // snapshot copies content
    // Original leaf answer stays a leaf (its own branch).
    expect(kids(aD.id)).toHaveLength(0);
    // The new branch sees the full prior history + the follow-up.
    expect(repo.getThread(byContent('reply:D-followup').id)).toEqual([
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'reply:A' },
      { role: 'user', content: 'C' },
      { role: 'assistant', content: 'reply:C' },
      { role: 'user', content: 'D-followup' },
      { role: 'assistant', content: 'reply:D-followup' },
    ]);
    expect(roots()).toHaveLength(1);
  });

  it('fork from the ROOT USER message → behavior is well-defined', async () => {
    await seedTwoTurns();
    const uA = byContent('A'); // the very first message (parent_id null)

    store.forkFrom(uA.id);
    await store.sendTurn('A-alt');
    await tick();

    // Document the actual behavior: forking the root user re-asks at the root,
    // which (a user turn's parent is its parent_id => null) produces a SECOND
    // root. This is the one case that breaks the "single shared root" invariant.
    const rootContents = roots().map((n) => n.content).sort();
    expect(rootContents).toEqual(['A', 'A-alt']);
  });

  it('branch count at a fork is view-independent (regression: showed N+1 when sitting on the fork)', async () => {
    // Build one fork with exactly two children:
    //   hello -> reply:A  (FORK)
    //              ├── "i am good" -> ...
    //              └── "hello"     -> ...
    await store.sendTurn('hello');
    await tick();
    const forkNode = byContent('reply:hello'); // the assistant that splits

    // Branch 1: continue with "i am good".
    await store.sendTurn('i am good');
    await tick();
    // Branch 2: fork the assistant answer, then continue with "hello".
    store.forkFrom(forkNode.id);
    await store.sendTurn('hello-2');
    await tick();

    expect(store.getState().tree).toBeTruthy();
    // Exactly two children at the fork.
    expect(kids(forkNode.id)).toHaveLength(2);

    // Count must be 2 from EVERY vantage point — this is the bug the UI showed:
    // (a) viewing deep inside branch 2 (active leaf at the new leaf),
    expect(store.branchesAt(forkNode.id)).toBe(2);
    // (b) sitting ON the fork node itself (active leaf == fork) — used to be 3.
    await store.switchLeaf(forkNode.id);
    await tick();
    expect(store.getState().activeLeafId).toBe(forkNode.id);
    expect(store.branchesAt(forkNode.id)).toBe(2);
    // (c) viewing the other branch.
    await store.switchLeaf(byContent('reply:i am good').id);
    await tick();
    expect(store.branchesAt(forkNode.id)).toBe(2);
  });

  it('a third branch at the same fork reads as 3 everywhere', async () => {
    await store.sendTurn('hello');
    await tick();
    const forkNode = byContent('reply:hello');
    await store.sendTurn('b1');
    await tick();
    store.forkFrom(forkNode.id);
    await store.sendTurn('b2');
    await tick();
    store.forkFrom(forkNode.id);
    await store.sendTurn('b3');
    await tick();

    expect(kids(forkNode.id)).toHaveLength(3);
    expect(store.branchesAt(forkNode.id)).toBe(3);
    await store.switchLeaf(forkNode.id);
    await tick();
    expect(store.branchesAt(forkNode.id)).toBe(3); // not 4
  });

  it('a non-fork (linear) assistant reports 0 branches', async () => {
    await seedTwoTurns();
    expect(store.branchesAt(byContent('reply:A').id)).toBe(0);
    expect(store.branchesAt(byContent('reply:C').id)).toBe(0);
  });

  it('deepestLeaf descends the first child to the branch head (breadcrumb drill target)', async () => {
    await store.sendTurn('hello');
    await tick();
    const fork = byContent('reply:hello');
    await store.sendTurn('b1'); // first child branch
    await tick();
    store.forkFrom(fork.id);
    await store.sendTurn('b2'); // second child branch
    await tick();

    // From the fork node, follow the FIRST child (b1, created first) to its leaf.
    expect(store.deepestLeaf(fork.id)).toBe(byContent('reply:b1').id);
    // From an actual leaf, it's the leaf itself.
    expect(store.deepestLeaf(byContent('reply:b2').id)).toBe(byContent('reply:b2').id);
  });

  it('Stop reaches the bridge with the streaming node id (regression: window.bridge was undefined)', async () => {
    await seedTwoTurns();
    const leaf = byContent('reply:C'); // the latest assistant (what Composer aborts)

    await store.abortTurn(leaf.id);

    // The store action must call the bridge — the old code called a missing
    // window.bridge.abortTurn and silently threw, so nothing reached main.
    expect(abortCalls).toEqual([leaf.id]);
  });

  it('switching back to a sibling leaf does not mutate the tree', async () => {
    await seedTwoTurns();
    const aB = byContent('reply:A');
    store.forkFrom(aB.id);
    await store.sendTurn('C-alt');
    await tick();

    const before = repo.getConversation(cid).nodes.length;
    await store.switchLeaf(byContent('reply:C').id); // back to original branch
    await tick();
    expect(repo.getConversation(cid).nodes.length).toBe(before);
    expect(store.getState().activeLeafId).toBe(byContent('reply:C').id);
  });
});
