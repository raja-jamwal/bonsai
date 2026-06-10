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
// Inline fork-point marker (component 7): after any on-path node where the
// conversation diverges, a dashed marker labels how many branches split off and
// is itself a dropdown to switch to any of them (mirrors the breadcrumb fork
// chips; shares the global openDropdownId so only one menu is open at a time).
//
// A streaming caret shows while the last assistant node status === 'streaming'
// (driven by the .msg.streaming CSS rule).
import { useEffect, useState } from 'react';
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

/** Short, readable label for a branch head — its title, else a content snippet. */
function branchLabel(node: MessageNode, fallback: string): string {
  if (node.title && node.title.trim()) {
    const t = node.title.trim();
    return t.length > 32 ? `${t.slice(0, 32)}…` : t;
  }
  const text = node.content.trim().replace(/\s+/g, ' ');
  if (!text) return fallback;
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
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
  const { openDropdownId } = store;
  const path = store.activePath();

  // Close the fork-point dropdown on outside click / ESC (handoff §"Dropdowns").
  // Shares store.openDropdownId, so this also coexists with the breadcrumb menus.
  useEffect(() => {
    if (!openDropdownId) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.crumb-dropdown')) store.setOpenDropdown(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.setOpenDropdown(null);
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDropdownId]);

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
   * The branch heads diverging at an assistant answer, matching store.branchesAt's
   * two shapes (see branchesAtRaw): a continuation fork (the answer has >1 child)
   * lists those children; an answer fork (regenerate / leaf-fork) lists the answer
   * plus its siblings. `activeId` is whichever head the current path runs through.
   */
  function forkBranches(node: MessageNode): {
    heads: MessageNode[];
    activeId: string | null;
  } {
    const children = store.childrenOf(node.id);
    if (children.length > 1) {
      const active = children.find((c) => store.isOnPath(c.id));
      return { heads: children, activeId: active?.id ?? null };
    }
    const siblings = store.siblingsOf(node.id); // children of parent, incl. node
    if (siblings.length > 1) {
      const active = siblings.find((s) => store.isOnPath(s.id)) ?? node;
      return { heads: siblings, activeId: active.id };
    }
    return { heads: [], activeId: null };
  }

  /**
   * Inline fork-point marker — a dashed divider rendered AFTER an assistant answer
   * where the conversation diverges. The chip labels how many branches split off
   * (a tree property, so it reads the same from any branch) and is a dropdown to
   * switch to any of them: selecting a branch re-points the active leaf to that
   * branch's fork point (store.branchEnd -> switchLeaf), the same move as the
   * branch tree and breadcrumb fork chips. We only mark assistant nodes.
   */
  function renderForkMarker(node: MessageNode): React.ReactNode {
    if (node.role !== 'assistant') return null;
    const { heads, activeId } = forkBranches(node);
    if (heads.length < 2) return null;

    const ddId = `fork:${node.id}`;
    const open = openDropdownId === ddId;

    return (
      <div className={'fork-marker'} key={'fork-' + node.id}>
        <div className="crumb-dropdown">
          <button
            type="button"
            className="fork-chip"
            aria-expanded={open}
            title="Switch to another branch"
            onClick={() => store.setOpenDropdown(open ? null : ddId)}
          >
            🌿 Fork point · {heads.length} branches
            <span className="crumb-caret">
              <Icon name="chevron-down" size={12} />
            </span>
          </button>
          {open ? (
            <div className="crumb-menu fork-menu">
              {heads.map((h, i) => (
                <button
                  key={h.id}
                  type="button"
                  className={`crumb-menu-item${h.id === activeId ? ' active' : ''}`}
                  onClick={() => {
                    void store.switchLeaf(store.branchEnd(h.id));
                    store.setOpenDropdown(null);
                  }}
                >
                  <Icon name="git-branch" size={14} />
                  {branchLabel(h, `Branch ${i + 1}`)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
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
