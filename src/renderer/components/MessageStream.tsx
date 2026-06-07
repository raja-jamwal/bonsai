// MessageStream.tsx — handoff components 6 (message stream), 7 (inline
// fork-point marker), and 8 (hover actions).
//
// Renders the active root->leaf path (store.activePath()) as alternating
// user/assistant messages:
//   • User: right-aligned bubble on --secondary with a letter avatar.
//   • Assistant: coral sparkle avatar (inline 4-point star SVG, matching the
//     handoff mock) + body in Source Serif 4 15.5px/1.62.
//
// Rich rendering (Security): message bodies render through <Markdown>
// (react-markdown + KaTeX + syntax highlighting). react-markdown does not emit
// raw HTML from model text, so nothing is injected; math/code markup is built by
// the trusted rehype plugins. No dangerouslySetInnerHTML of model output.
//
// Hover actions (component 8): Copy; trash (all messages); coral
// "Fork from here" -> store.forkFrom(node.id), on both roles.
//
// Inline fork-point marker (component 7): after any on-path node with >1 child,
// a dashed marker offers switching to a sibling branch.
//
// A streaming caret shows while the last assistant node status === 'streaming'
// (driven by the .msg.streaming CSS rule).
import { useState } from 'react';
import { useStore } from '../state/store';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import type { MessageNode } from '@shared/types';

/** Inline 4-point coral sparkle (the Claude mark), matching the handoff SVG. */
function Sparkle() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3 L13.6 9.4 L20 11 L13.6 12.6 L12 19 L10.4 12.6 L4 11 L10.4 9.4 Z" />
    </svg>
  );
}

/** Map a raw activity label to a human-readable string. */
function formatActivityLabel(label: string): string {
  if (label === 'thinking') return 'Thinking…';
  if (label === 'EnterPlanMode') return 'Entering plan mode';
  if (label === 'ExitPlanMode') return 'Exiting plan mode';
  return `Using ${label}`;
}

export function MessageStream() {
  const store = useStore();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const path = store.activePath();
  if (path.length === 0) return null;

  function copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }

  function confirmDelete(id: string): void {
    setConfirmDeleteId(id);
  }

  function cancelDelete(): void {
    setConfirmDeleteId(null);
  }

  function executeDelete(id: string): void {
    setConfirmDeleteId(null);
    void store.deleteNode(id);
  }

  /**
   * Inline fork-point marker — rendered AFTER the assistant ANSWER the fork
   * happened at (where the user clicked), not after the question. Two cases of
   * "an alternative exists at this answer":
   *   • off-path CHILDREN of this answer — other continuations after it
   *     (forking a mid-conversation answer).
   *   • off-path SIBLINGS of this answer — other answers to the same question
   *     (a leaf fork keeps the original answer as a sibling, or a regenerate).
   * We only mark assistant nodes so the marker sits under the answer.
   */
  function renderForkMarker(node: MessageNode): React.ReactNode {
    if (node.role !== 'assistant') return null;
    const offChildren = store.childrenOf(node.id).filter((c) => !store.isOnPath(c.id));
    const offSiblings = store
      .siblingsOf(node.id)
      .filter((s) => s.id !== node.id && !store.isOnPath(s.id));
    const alts = [...offChildren, ...offSiblings];
    if (alts.length === 0) return null;
    const target = alts[0];

    // Descend the alternative to its first-child leaf, then switch to it.
    function switchToAlt(): void {
      let cur = target;
      const seen = new Set<string>([cur.id]);
      let kids = store.childrenOf(cur.id);
      while (kids.length > 0 && !seen.has(kids[0].id)) {
        cur = kids[0];
        seen.add(cur.id);
        kids = store.childrenOf(cur.id);
      }
      void store.switchLeaf(cur.id);
    }

    // Label the alternative branch (prefer its first user message / title).
    const labelNode =
      target.role === 'user'
        ? target
        : store.childrenOf(target.id).find((c) => c.role === 'user') ?? target;
    const label =
      (labelNode.title && labelNode.title.trim()) ||
      labelNode.content.trim().replace(/\s+/g, ' ').slice(0, 28) ||
      'branch';

    return (
      <div className="fork-marker" key={`fork-${node.id}`}>
        <span className="fork-chip">
          🌿 Fork point · {alts.length}{' '}
          {alts.length === 1 ? 'sibling' : 'siblings'}
        </span>
        <button type="button" className="fork-switch" onClick={switchToAlt}>
          Switch → “{label}”
        </button>
      </div>
    );
  }

  function renderMessage(node: MessageNode): React.ReactNode {
    const isUser = node.role === 'user';
    const isStreaming = node.status === 'streaming';
    const isError = node.status === 'error';
    const activityLabel = isStreaming ? (store.streamActivity.get(node.id) ?? '') : '';

    return (
      <div
        key={node.id}
        className={[
          'msg',
          isUser ? 'user' : 'assistant',
          isStreaming ? 'streaming' : '',
          isError ? 'error' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {/* Mock: assistant messages get the coral sparkle avatar; user messages
            have NO avatar (the bubble sits flush left). */}
        {!isUser ? (
          <div className="avatar assistant">
            <Sparkle />
          </div>
        ) : null}

        <div className="bubble-wrap" style={{ minWidth: 0 }}>
          {/* Rich body: markdown + KaTeX math + highlighted code (no raw
              HTML from model text — see Markdown.tsx). */}
          <div className="bubble">
            <Markdown text={node.content} />
          </div>

          {isError && node.error_text ? (
            <div className="error-text">{node.error_text}</div>
          ) : null}

          {/* Transient activity indicator: thinking / tool use. */}
          {activityLabel ? (
            <div className="stream-activity">
              <span className="activity-dot" />
              {formatActivityLabel(activityLabel)}
            </div>
          ) : null}

          {/* Hover actions (component 8). */}
          <div className="msg-actions">
            <button
              type="button"
              className="action-btn"
              onClick={() => copy(node.content)}
            >
              <Icon name="copy" size={13} />
              Copy
            </button>
            <button
              type="button"
              className="action-btn delete-btn"
              title="Delete message"
              onClick={() => confirmDelete(node.id)}
            >
              <Icon name="trash-2" size={13} />
            </button>
            <button
              type="button"
              className="action-btn fork-btn"
              onClick={() => void store.forkFrom(node.id)}
            >
              <Icon name="git-branch" size={13} />
              Fork from here
            </button>
          </div>
          {confirmDeleteId === node.id ? (
            <div className="delete-confirm">
              <span className="delete-confirm-text">Delete this message?</span>
              <button
                type="button"
                className="delete-confirm-yes"
                onClick={() => executeDelete(node.id)}
              >
                Delete
              </button>
              <button
                type="button"
                className="delete-confirm-cancel"
                onClick={cancelDelete}
              >
                Cancel
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      {path.map((node) => (
        <div key={node.id}>
          {renderMessage(node)}
          {renderForkMarker(node)}
        </div>
      ))}

      {/* Draft-branch affordance (component 7 / "Fork from here"): a new branch
          is being started here; it commits when the first message is sent. No
          Claude call happens until then. */}
      {store.fork ? (
        <div className="draft-fork">
          <span className="draft-fork-label">
            <Icon name="git-branch" size={12} /> New branch
          </span>
          <span className="draft-fork-text">
            Type your first message below to create it.
          </span>
          <button
            type="button"
            className="draft-fork-cancel"
            onClick={() => store.cancelFork()}
          >
            <Icon name="x" size={12} /> Cancel
          </button>
        </div>
      ) : null}
    </>
  );
}
