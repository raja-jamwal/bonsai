// Repository: all conversation/node/attachment persistence operations
// (thread reconstruction, branching, persistence).
// Wraps a single better-sqlite3 handle and exposes the typed operations the
// IPC layer and runner compose against.
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  Attachment,
  Conversation,
  ConversationSummary,
  ConversationTree,
  MessageNode,
  SearchResult,
} from '@shared/types';

/** epoch-ms timestamp helper (per project convention). */
function nowMs(): number {
  return Date.now();
}

/** Extract a ~120-char excerpt centered on the first occurrence of `query`. */
function extractSnippet(content: string, query: string, maxLen = 120): string {
  const flat = content.replace(/\n+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return flat.slice(0, maxLen);
  const start = Math.max(0, idx - 40);
  const end = Math.min(flat.length, idx + query.length + 80);
  let snippet = flat.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < flat.length) snippet += '…';
  return snippet;
}

export class Repo {
  private readonly db: Database.Database;

  // Prepared statements are built once and reused (avoid re-compiling).
  private readonly stmts: {
    insertConversation: Database.Statement;
    listConversations: Database.Statement;
    getConversation: Database.Statement;
    getConversationNodes: Database.Statement;
    getConversationAttachments: Database.Statement;
    renameConversation: Database.Statement;
    setModel: Database.Statement;
    deleteConversation: Database.Statement;
    touchConversation: Database.Statement;
    setActiveLeaf: Database.Statement;
    getNode: Database.Statement;
    insertNode: Database.Statement;
    checkpointAssistant: Database.Statement;
    completeAssistant: Database.Statement;
    failAssistant: Database.Statement;
    deleteNode: Database.Statement;
    thread: Database.Statement;
    effectiveDirs: Database.Statement;
    insertAttachment: Database.Statement;
    removeAttachment: Database.Statement;
    searchConversations: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.stmts = {
      insertConversation: db.prepare(
        `INSERT INTO conversations (id, title, active_leaf, model, created_at, updated_at)
         VALUES (@id, @title, NULL, @model, @created_at, @updated_at)`
      ),
      // Newest-updated first; node_count via correlated subquery.
      listConversations: db.prepare(
        `SELECT c.id, c.title, c.model, c.active_leaf, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM nodes n WHERE n.conversation_id = c.id) AS node_count
           FROM conversations c
          ORDER BY c.updated_at DESC`
      ),
      getConversation: db.prepare(
        `SELECT id, title, active_leaf, model, created_at, updated_at
           FROM conversations WHERE id = ?`
      ),
      getConversationNodes: db.prepare(
        `SELECT * FROM nodes WHERE conversation_id = ? ORDER BY created_at ASC`
      ),
      getConversationAttachments: db.prepare(
        `SELECT * FROM attachments WHERE conversation_id = ? ORDER BY added_at ASC`
      ),
      renameConversation: db.prepare(
        `UPDATE conversations SET title = @title, updated_at = @updated_at WHERE id = @id`
      ),
      setModel: db.prepare(
        `UPDATE conversations SET model = @model, updated_at = @updated_at WHERE id = @id`
      ),
      deleteConversation: db.prepare(`DELETE FROM conversations WHERE id = ?`),
      touchConversation: db.prepare(
        `UPDATE conversations SET updated_at = @updated_at WHERE id = @id`
      ),
      setActiveLeaf: db.prepare(
        `UPDATE conversations SET active_leaf = @leaf, updated_at = @updated_at WHERE id = @id`
      ),
      getNode: db.prepare(`SELECT * FROM nodes WHERE id = ?`),
      insertNode: db.prepare(
        `INSERT INTO nodes
           (id, conversation_id, parent_id, role, content, status, model, title,
            input_tokens, output_tokens, cost_usd, error_text, created_at, completed_at)
         VALUES
           (@id, @conversation_id, @parent_id, @role, @content, @status, @model, @title,
            @input_tokens, @output_tokens, @cost_usd, @error_text, @created_at, @completed_at)`
      ),
      // Periodic checkpoint of partial content while streaming.
      checkpointAssistant: db.prepare(
        `UPDATE nodes SET content = @content WHERE id = @id AND status = 'streaming'`
      ),
      completeAssistant: db.prepare(
        `UPDATE nodes
            SET content = @content, status = 'complete', completed_at = @completed_at,
                input_tokens = @input_tokens, output_tokens = @output_tokens, cost_usd = @cost_usd
          WHERE id = @id`
      ),
      failAssistant: db.prepare(
        `UPDATE nodes
            SET status = 'error', error_text = @error_text, content = @content,
                completed_at = @completed_at
          WHERE id = @id`
      ),
      deleteNode: db.prepare(`DELETE FROM nodes WHERE id = ?`),
      // Recursive CTE, root-first.
      thread: db.prepare(
        `WITH RECURSIVE thread(id, parent_id, role, content, depth) AS (
           SELECT id, parent_id, role, content, 0
             FROM nodes WHERE id = :leaf_id
           UNION ALL
           SELECT n.id, n.parent_id, n.role, n.content, t.depth + 1
             FROM nodes n JOIN thread t ON n.id = t.parent_id
         )
         SELECT role, content FROM thread ORDER BY depth DESC`
      ),
      // Attachments whose node_id is on the active branch path
      // (ancestor-or-self of the leaf) OR null (whole-conversation), ordered
      // by added_at. The leaf's conversation is derived from the leaf node.
      effectiveDirs: db.prepare(
        `WITH RECURSIVE path(id, parent_id) AS (
           SELECT id, parent_id FROM nodes WHERE id = :leaf_id
           UNION ALL
           SELECT n.id, n.parent_id FROM nodes n JOIN path p ON n.id = p.parent_id
         )
         SELECT a.dir_path
           FROM attachments a
          WHERE a.conversation_id = (SELECT conversation_id FROM nodes WHERE id = :leaf_id)
            AND (a.node_id IS NULL OR a.node_id IN (SELECT id FROM path))
          ORDER BY a.added_at ASC`
      ),
      insertAttachment: db.prepare(
        `INSERT INTO attachments (id, conversation_id, node_id, dir_path, added_at)
         VALUES (@id, @conversation_id, @node_id, @dir_path, @added_at)`
      ),
      removeAttachment: db.prepare(`DELETE FROM attachments WHERE id = ?`),
      searchConversations: db.prepare(
        // UNION of title hits (nodeId NULL) and content hits, newest-conversation first.
        // Two ? params: both receive the same '%pattern%' value.
        `SELECT 'title'   AS match_type,
                c.id      AS conversation_id,
                c.title   AS conversation_title,
                NULL      AS node_id,
                NULL      AS role,
                NULL      AS content
           FROM conversations c
          WHERE c.title LIKE ? ESCAPE '\\'

         UNION ALL

         SELECT 'content'  AS match_type,
                c.id       AS conversation_id,
                c.title    AS conversation_title,
                n.id       AS node_id,
                n.role     AS role,
                n.content  AS content
           FROM nodes n
           JOIN conversations c ON c.id = n.conversation_id
          WHERE n.content LIKE ? ESCAPE '\\'
            AND n.status IN ('complete', 'error')

          ORDER BY conversation_id
          LIMIT 50`
      ),
    };
  }

  // -- Conversations -------------------------------------------------------

  /** "New conversation": insert a conversations row (no nodes yet). */
  createConversation(args: { title?: string; model?: string }): string {
    const id = uuidv4();
    const ts = nowMs();
    this.stmts.insertConversation.run({
      id,
      title: args.title ?? '',
      model: args.model ?? null,
      created_at: ts,
      updated_at: ts,
    });
    return id;
  }

  /** Newest-updated first. */
  listConversations(): ConversationSummary[] {
    return this.stmts.listConversations.all() as ConversationSummary[];
  }

  /**
   * Full-text-style search across conversation titles and message content.
   * Returns up to 50 hits (title matches + content matches) ordered by
   * conversation id. LIKE-based; case-insensitive for ASCII.
   */
  searchConversations(query: string): SearchResult[] {
    if (!query.trim()) return [];
    // Escape LIKE special chars so user input is treated as literal text.
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const pattern = `%${escaped}%`;
    const rows = this.stmts.searchConversations.all(pattern, pattern) as Array<{
      match_type: 'title' | 'content';
      conversation_id: string;
      conversation_title: string;
      node_id: string | null;
      role: 'user' | 'assistant' | null;
      content: string | null;
    }>;
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      conversationTitle: row.conversation_title || '(Untitled)',
      nodeId: row.node_id,
      snippet: row.content
        ? extractSnippet(row.content, query)
        : (row.conversation_title || '(Untitled)'),
      role: row.role,
    }));
  }

  /** Full tree: conversation + all nodes + all attachments. */
  /** Lightweight conversation row fetch (no nodes/attachments). */
  getConversationRow(id: string): Conversation | undefined {
    return this.stmts.getConversation.get(id) as Conversation | undefined;
  }

  getConversation(id: string): ConversationTree {
    const conversation = this.stmts.getConversation.get(id) as
      | Conversation
      | undefined;
    if (!conversation) {
      throw new Error(`Conversation not found: ${id}`);
    }
    const nodes = this.stmts.getConversationNodes.all(id) as MessageNode[];
    const attachments = this.stmts.getConversationAttachments.all(
      id
    ) as Attachment[];
    return { conversation, nodes, attachments };
  }

  renameConversation(id: string, title: string): void {
    this.stmts.renameConversation.run({ id, title, updated_at: nowMs() });
  }

  /** Set the conversation's default model for new turns (per-conversation). */
  setModel(id: string, model: string | null): void {
    this.stmts.setModel.run({ id, model, updated_at: nowMs() });
  }

  /** Set the auto-generated branch title on a (branch-head) node. */
  setNodeTitle(nodeId: string, title: string): void {
    this.db.prepare(`UPDATE nodes SET title = ? WHERE id = ?`).run(title, nodeId);
  }

  /** Read an app setting from the `meta` table. */
  getSetting(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Write an app setting to the `meta` table (e.g. the resolved claude path). */
  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  /** Cascades to nodes and attachments via ON DELETE CASCADE. */
  deleteConversation(id: string): void {
    this.stmts.deleteConversation.run(id);
  }

  // -- Nodes ---------------------------------------------------------------

  getNode(id: string): MessageNode | undefined {
    return this.stmts.getNode.get(id) as MessageNode | undefined;
  }

  /** Root-first thread for a leaf, as role/content pairs. */
  getThread(leafId: string): { role: 'user' | 'assistant'; content: string }[] {
    return this.stmts.thread.all({ leaf_id: leafId }) as {
      role: 'user' | 'assistant';
      content: string;
    }[];
  }

  /**
   * Effective directory set for the turn ending at `leafId`. Attachments
   * on the active branch path (ancestor-or-self) plus whole-conversation
   * attachments (node_id NULL), ordered by added_at.
   */
  effectiveDirs(leafId: string): string[] {
    const rows = this.stmts.effectiveDirs.all({ leaf_id: leafId }) as {
      dir_path: string;
    }[];
    return rows.map((r) => r.dir_path);
  }

  /**
   * Insert a user node and advance the active leaf (append/branch).
   * A user node's parent must be an assistant node or NULL (root);
   * anything else is rejected.
   */
  insertUserNode(args: {
    conversationId: string;
    parentId: string | null;
    content: string;
  }): MessageNode {
    const tx = this.db.transaction((): MessageNode => {
      // Alternation enforcement.
      if (args.parentId !== null) {
        const parent = this.getNode(args.parentId);
        if (!parent) {
          throw new Error(`Parent node not found: ${args.parentId}`);
        }
        if (parent.role !== 'assistant') {
          throw new Error(
            'a user node may only be a child of an assistant node (or root)'
          );
        }
      }

      const id = uuidv4();
      const ts = nowMs();
      // A user node is immediately "complete" (no streaming for user content).
      const node: MessageNode = {
        id,
        conversation_id: args.conversationId,
        parent_id: args.parentId,
        role: 'user',
        content: args.content,
        status: 'complete',
        model: null,
        title: null,
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        error_text: null,
        created_at: ts,
        completed_at: ts,
      };
      this.stmts.insertNode.run(node);
      // Appending/branching advances the active leaf and touches updated_at.
      this.stmts.setActiveLeaf.run({
        id: args.conversationId,
        leaf: id,
        updated_at: ts,
      });
      return node;
    });
    return tx();
  }

  /**
   * Insert a streaming assistant node. Its parent must be a user node.
   * The active leaf is advanced only on completion (completeAssistant),
   * not here, so an in-flight turn doesn't hijack the rendered path mid-stream.
   */
  insertStreamingAssistant(args: {
    conversationId: string;
    parentId: string;
    model: string | null;
  }): MessageNode {
    const tx = this.db.transaction((): MessageNode => {
      const parent = this.getNode(args.parentId);
      if (!parent) {
        throw new Error(`Parent node not found: ${args.parentId}`);
      }
      // Alternation enforcement.
      if (parent.role !== 'user') {
        throw new Error(
          'an assistant node may only be a child of a user node'
        );
      }

      const id = uuidv4();
      const ts = nowMs();
      const node: MessageNode = {
        id,
        conversation_id: args.conversationId,
        parent_id: args.parentId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        model: args.model,
        title: null,
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        error_text: null,
        created_at: ts,
        completed_at: null,
      };
      this.stmts.insertNode.run(node);
      // Touch updated_at so the conversation surfaces as active while streaming.
      this.stmts.touchConversation.run({
        id: args.conversationId,
        updated_at: ts,
      });
      return node;
    });
    return tx();
  }

  /**
   * Fork from a LEAF assistant ("Branch from node N") while keeping the
   * original answer as its own branch. The node tree can't represent "the
   * original ends here" once the node gains a child, so we snapshot the answer:
   * copy `leafAssistantId` to a sibling under the same user turn, then start the
   * new branch with `content` under that copy. The original assistant stays a
   * leaf (branch 1); the copy heads branch 2. The shared user turn becomes the
   * fork point. Returns the new user node id + the copy id.
   */
  forkLeafAssistant(args: {
    leafAssistantId: string;
    content: string;
    model: string | null;
  }): { userNodeId: string } {
    const tx = this.db.transaction((): { userNodeId: string } => {
      const leaf = this.getNode(args.leafAssistantId);
      if (!leaf || leaf.role !== 'assistant') {
        throw new Error(`Leaf assistant not found: ${args.leafAssistantId}`);
      }
      if (leaf.parent_id === null) {
        throw new Error('Cannot fork a root assistant'); // shouldn't happen (root is user)
      }
      const ts = nowMs();
      // 1) Snapshot the original answer as a sibling under the same user turn.
      const copyId = uuidv4();
      const copy: MessageNode = {
        id: copyId,
        conversation_id: leaf.conversation_id,
        parent_id: leaf.parent_id, // sibling of the original answer -> fork at the question
        role: 'assistant',
        content: leaf.content,
        status: 'complete',
        model: leaf.model,
        title: null,
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        error_text: null,
        created_at: ts,
        completed_at: ts,
      };
      this.stmts.insertNode.run(copy);
      // 2) Start the new branch with the user's message under the copied answer.
      const userId = uuidv4();
      const user: MessageNode = {
        id: userId,
        conversation_id: leaf.conversation_id,
        parent_id: copyId,
        role: 'user',
        content: args.content,
        status: 'complete',
        model: null,
        title: null,
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        error_text: null,
        created_at: ts + 1,
        completed_at: ts + 1,
      };
      this.stmts.insertNode.run(user);
      this.stmts.setActiveLeaf.run({ id: leaf.conversation_id, leaf: userId, updated_at: ts + 1 });
      return { userNodeId: userId };
    });
    return tx();
  }

  /** Periodic persist of partial content (only while still streaming). */
  checkpointAssistant(nodeId: string, content: string): void {
    this.stmts.checkpointAssistant.run({ id: nodeId, content });
  }

  /**
   * Mark an assistant node complete with final content and usage,
   * then advance the conversation's active leaf to this node.
   */
  completeAssistant(
    nodeId: string,
    args: {
      content: string;
      inputTokens: number | null;
      outputTokens: number | null;
      costUsd: number | null;
    }
  ): void {
    const tx = this.db.transaction(() => {
      const node = this.getNode(nodeId);
      if (!node) {
        throw new Error(`Assistant node not found: ${nodeId}`);
      }
      const ts = nowMs();
      this.stmts.completeAssistant.run({
        id: nodeId,
        content: args.content,
        completed_at: ts,
        input_tokens: args.inputTokens,
        output_tokens: args.outputTokens,
        cost_usd: args.costUsd,
      });
      // The freshly generated assistant node becomes the active leaf.
      this.stmts.setActiveLeaf.run({
        id: node.conversation_id,
        leaf: nodeId,
        updated_at: ts,
      });
    });
    tx();
  }

  /**
   * Mark an assistant node failed. Persists any partial content so the
   * user can see what arrived before the failure.
   */
  failAssistant(nodeId: string, errorText: string, partialContent = ''): void {
    this.stmts.failAssistant.run({
      id: nodeId,
      error_text: errorText,
      content: partialContent,
      completed_at: nowMs(),
    });
  }

  /** "Switch branch": set active leaf, no generation. */
  setActiveLeaf(conversationId: string, leafId: string): void {
    this.stmts.setActiveLeaf.run({
      id: conversationId,
      leaf: leafId,
      updated_at: nowMs(),
    });
  }

  /**
   * Delete a node and its entire subtree (DB ON DELETE CASCADE on
   * nodes.parent_id). conversations.active_leaf is auto-nulled by
   * ON DELETE SET NULL if it pointed into the removed subtree.
   */
  deleteNode(nodeId: string): void {
    this.stmts.deleteNode.run(nodeId);
  }

  // -- Attachments ---------------------------------------------------------

  /**
   * Attach a directory to a conversation, optionally scoped from a node
   * downward. node_id NULL = whole conversation.
   */
  addAttachment(args: {
    conversationId: string;
    nodeId: string | null;
    dirPath: string;
  }): string {
    const id = uuidv4();
    this.stmts.insertAttachment.run({
      id,
      conversation_id: args.conversationId,
      node_id: args.nodeId,
      dir_path: args.dirPath,
      added_at: nowMs(),
    });
    return id;
  }

  removeAttachment(attachmentId: string): void {
    this.stmts.removeAttachment.run(attachmentId);
  }
}
