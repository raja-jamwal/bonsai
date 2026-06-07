// ConversationPane.tsx — the right column, composing the handoff conversation
// pane: Header (component 3) + Breadcrumb (4) + BranchBanner (5) +
// MessageStream (6/7/8) + Composer (9) in the vertical grid (.pane).
//
// Header: the title is a working dropdown (Rename / Delete conversation) and a
// panel-right toggle that shows/hides the branch tree. The "Compare" placeholder
// (handoff open-question 4) is omitted in v1 rather than shown as a dead button.
//
// If there is no active conversation, render nothing (App owns the empty state).
import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useStore } from '../state/store';
import { Icon } from './Icon';
import { Breadcrumb } from './Breadcrumb';
import { BranchBanner } from './BranchBanner';
import { MessageStream } from './MessageStream';
import { Composer } from './Composer';

export function ConversationPane() {
  const store = useStore();
  const { tree, activeConversationId } = store;
  const [menuOpen, setMenuOpen] = useState(false);

  // --- Stick-to-bottom auto-scroll -----------------------------------------
  // Follow new content (including streaming deltas) ONLY when the user is
  // already at the bottom; if they've scrolled up to read, don't yank them down.
  const streamRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const path = store.activePath();
  const last = path[path.length - 1];
  // A signal that changes on every appended delta / new message / status change.
  const scrollSignal = `${path.length}:${last?.id ?? ''}:${last?.content.length ?? 0}:${last?.status ?? ''}`;

  function onStreamScroll(): void {
    const el = streamRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  // Follow growth while pinned to the bottom (useLayoutEffect to avoid flicker).
  // Re-pin once more on the next frame to catch late reflows (markdown/code
  // blocks wrapping) that change height after the synchronous layout pass.
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
    const raf = requestAnimationFrame(() => {
      const e2 = streamRef.current;
      if (e2 && stickRef.current) e2.scrollTop = e2.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollSignal]);

  // Switching branch / conversation: re-pin and jump to the latest message.
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [store.activeLeafId, store.activeConversationId]);

  // Close the title menu on outside click / ESC.
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.pane-title-menu-wrap')) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // No active conversation -> render nothing; App.tsx shows the empty state.
  if (!activeConversationId || !tree) return null;

  const title = tree.conversation.title || 'Untitled conversation';

  function rename(): void {
    setMenuOpen(false);
    const next = window.prompt('Rename conversation', title);
    if (next && next.trim() && activeConversationId) {
      void store.renameConversation(activeConversationId, next.trim());
    }
  }

  function remove(): void {
    setMenuOpen(false);
    if (!activeConversationId) return;
    if (window.confirm(`Delete "${title}"? This cannot be undone.`)) {
      void store.deleteConversation(activeConversationId);
    }
  }

  return (
    <section className="pane">
      {/* ---- Header (component 3) ---- */}
      <div className="pane-head">
        <div className="pane-title-menu-wrap">
          <button
            type="button"
            className="pane-title"
            onClick={() => setMenuOpen((v) => !v)}
          >
            {title}
            <Icon name="chevron-down" size={14} />
          </button>
          {menuOpen ? (
            <div className="crumb-menu" style={{ left: 0 }}>
              <button type="button" className="crumb-menu-item" onClick={rename}>
                <Icon name="pencil" size={14} />
                Rename conversation
              </button>
              <button type="button" className="crumb-menu-item action" onClick={remove}>
                <Icon name="more-horizontal" size={14} />
                Delete conversation
              </button>
            </div>
          ) : null}
        </div>
        <span className="spacer" />
        {/* Panel-right toggle — shows/hides the branch tree. */}
        <button
          type="button"
          className="pane-head-icon-btn"
          title="Toggle branch tree"
          onClick={() => store.toggleTree()}
        >
          <Icon name="panel-right" size={16} />
        </button>
      </div>

      {/* ---- Breadcrumb (component 4) ---- */}
      <Breadcrumb />

      {/* ---- Stream (banner + messages) ---- */}
      <div className="stream" ref={streamRef} onScroll={onStreamScroll}>
        <div className="stream-inner">
          <BranchBanner />
          <MessageStream />
        </div>
      </div>

      {/* ---- Composer (component 9) ---- */}
      <Composer />
    </section>
  );
}
