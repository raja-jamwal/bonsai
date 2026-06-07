// Breadcrumb.tsx — handoff component 4 (path breadcrumb strip).
//
// IMPORTANT semantics fix: the breadcrumb represents the *branch* path, NOT one
// chip per message. A "branch" is a segment of the tree between fork points; a
// linear conversation (no explicit forks) is a SINGLE branch and therefore shows
// just the conversation chip. Chips are only added where the active path crosses
// an actual fork point (a node with >1 child — i.e. somewhere the user explicitly
// forked). This prevents a plain back-and-forth chat from looking like it forks
// on every message.
//
// Chips:
//   • root chip   — the conversation (message-square). Plain, unless there are
//                   no forks, in which case it is also the "current" chip.
//   • fork chips  — one per fork point on the path (crumb.fork, coral tint). Each
//                   has a caret dropdown to switch sibling branches at that fork,
//                   "Continue parent", and "Fork a new branch here".
//   • current     — the last chip (solid coral, crumb.current) gets a rename +
//                   "fork from here" menu.
//   • collapsed   — when there are > 4 forks, the middle ones collapse to a
//                   dashed "… N hidden" chip with a popover.
// Separators are the › character in --muted-2.
//
// Dropdown state is global (store.openDropdownId / setOpenDropdown): only one is
// open at a time, a single window click handler closes them, and ESC closes too.
import { useEffect } from 'react';
import { useStore } from '../state/store';
import { Icon } from './Icon';
import type { MessageNode } from '@shared/types';

function chipLabel(node: MessageNode, fallback: string): string {
  // Prefer the auto-generated branch title when present.
  if (node.title && node.title.trim()) {
    const t = node.title.trim();
    return t.length > 24 ? `${t.slice(0, 24)}…` : t;
  }
  const text = node.content.trim().replace(/\s+/g, ' ');
  if (!text) return fallback;
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

export function Breadcrumb() {
  const store = useStore();
  const { openDropdownId, activeConversationId } = store;
  const path = store.activePath();

  // Global click + ESC close any open dropdown (handoff §"Dropdowns").
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

  const root = path[0];
  const leaf = path[path.length - 1];
  // Fork points actually crossed by the active path (excluding the leaf itself).
  const forks = path
    .slice(0, -1)
    .filter((n) => store.childrenOf(n.id).length > 1);
  const convoTitle =
    store.tree?.conversation.title?.trim() || 'New conversation';

  function toggle(id: string): void {
    store.setOpenDropdown(openDropdownId === id ? null : id);
  }

  // Switch to the deepest-first-child leaf rooted at `node`.
  function switchToBranch(node: MessageNode): void {
    let cur = node;
    const seen = new Set<string>([cur.id]);
    let kids = store.childrenOf(cur.id);
    while (kids.length > 0 && !seen.has(kids[0].id)) {
      cur = kids[0];
      seen.add(cur.id);
      kids = store.childrenOf(cur.id);
    }
    void store.switchLeaf(cur.id);
  }

  function renameCurrent(): void {
    const next = window.prompt('Rename this conversation', convoTitle);
    if (next && activeConversationId) {
      void window.api
        .renameConversation({ id: activeConversationId, title: next })
        .then(() => store.loadConversations());
    }
    store.setOpenDropdown(null);
  }

  // ----- Root / conversation chip -------------------------------------------
  function rootChip(isCurrent: boolean): React.ReactNode {
    const ddId = 'crumb:root';
    const open = openDropdownId === ddId;
    if (!isCurrent) {
      return (
        <button
          type="button"
          className="crumb root"
          onClick={() => switchToBranch(root)}
          title="Root conversation"
        >
          <Icon name="message-square" size={13} />
          {convoTitle}
        </button>
      );
    }
    // Linear conversation: the root chip IS the current branch.
    return (
      <div className="crumb-dropdown" key="root">
        <button
          type="button"
          className="crumb current"
          onClick={() => toggle(ddId)}
        >
          <Icon name="message-square" size={13} />
          {convoTitle}
          <span className="crumb-caret">
            <Icon name="chevron-down" size={12} />
          </span>
        </button>
        {open ? (
          <div className="crumb-menu">
            <button type="button" className="crumb-menu-item" onClick={renameCurrent}>
              <Icon name="pencil" size={14} />
              Rename conversation
            </button>
            <button
              type="button"
              className="crumb-menu-item action"
              onClick={() => {
                void store.forkFrom(leaf.id);
                store.setOpenDropdown(null);
              }}
            >
              <Icon name="plus" size={14} />
              Fork a new branch from here
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  // ----- A fork chip with sibling dropdown -----------------------------------
  function forkChip(node: MessageNode, isCurrent: boolean): React.ReactNode {
    const ddId = `crumb:${node.id}`;
    const open = openDropdownId === ddId;
    const childForks = store.childrenOf(node.id);
    const onPathChild = childForks.find((c) => store.isOnPath(c.id)) ?? null;
    const label = onPathChild ? chipLabel(onPathChild, 'Branch') : chipLabel(node, 'Fork');

    return (
      <div className="crumb-dropdown" key={node.id}>
        <button
          type="button"
          className={`crumb ${isCurrent ? 'current' : 'fork'}`}
          onClick={() => toggle(ddId)}
        >
          <Icon name="git-branch" size={13} />
          {label}
          <span className="crumb-caret">
            <Icon name="chevron-down" size={12} />
          </span>
        </button>
        {open ? (
          <div className="crumb-menu">
            <button
              type="button"
              className="crumb-menu-item"
              onClick={() => {
                void store.switchLeaf(node.id);
                store.setOpenDropdown(null);
              }}
            >
              <Icon name="corner-down-right" size={14} />
              Continue parent
            </button>
            <div className="crumb-menu-sep" />
            {childForks.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`crumb-menu-item${c.id === onPathChild?.id ? ' active' : ''}`}
                onClick={() => {
                  switchToBranch(c);
                  store.setOpenDropdown(null);
                }}
              >
                <Icon name="git-branch" size={14} />
                {chipLabel(c, 'Branch')}
              </button>
            ))}
            <div className="crumb-menu-sep" />
            {isCurrent ? (
              <button type="button" className="crumb-menu-item" onClick={renameCurrent}>
                <Icon name="pencil" size={14} />
                Rename conversation
              </button>
            ) : null}
            <button
              type="button"
              className="crumb-menu-item action"
              onClick={() => {
                void store.forkFrom(isCurrent ? leaf.id : node.id);
                store.setOpenDropdown(null);
              }}
            >
              <Icon name="plus" size={14} />
              Fork a new branch here
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  // ----- Collapsed-middle chip (when many forks) -----------------------------
  function middleChip(hidden: MessageNode[]): React.ReactNode {
    const ddId = 'crumb:middle';
    const open = openDropdownId === ddId;
    return (
      <div className="crumb-dropdown" key="middle">
        <button
          type="button"
          className="crumb collapsed-middle"
          onClick={() => toggle(ddId)}
          title={`${hidden.length} forks hidden`}
        >
          <Icon name="more-horizontal" size={13} />
          {`${hidden.length} hidden`}
          <span className="crumb-caret">
            <Icon name="chevron-down" size={12} />
          </span>
        </button>
        {open ? (
          <div className="crumb-menu">
            {hidden.map((n) => (
              <button
                key={n.id}
                type="button"
                className="crumb-menu-item"
                onClick={() => {
                  switchToBranch(n);
                  store.setOpenDropdown(null);
                }}
              >
                <Icon name="git-branch" size={12} />
                {chipLabel(n, 'Fork')}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const sep = <span className="crumb-sep">›</span>;

  // No forks → single conversation chip (current). This is the linear case and
  // the key fix: a plain chat shows ONE chip, not one per message.
  if (forks.length === 0) {
    return <div className="crumbs">{rootChip(true)}</div>;
  }

  // With forks: root › fork › … › fork(current). Collapse middle when > 4.
  const COLLAPSE_AT = 4;
  let forkChips: React.ReactNode[];
  if (forks.length > COLLAPSE_AT) {
    const first = forks[0];
    const hidden = forks.slice(1, forks.length - 1);
    const last = forks[forks.length - 1];
    forkChips = [
      <span key="f0" className="crumb-wrap">{sep}{forkChip(first, false)}</span>,
      <span key="fmid" className="crumb-wrap">{sep}{middleChip(hidden)}</span>,
      <span key="flast" className="crumb-wrap">{sep}{forkChip(last, true)}</span>,
    ];
  } else {
    forkChips = forks.map((f, i) => (
      <span key={f.id} className="crumb-wrap">
        {sep}
        {forkChip(f, i === forks.length - 1)}
      </span>
    ));
  }

  return (
    <div className="crumbs">
      {rootChip(false)}
      {forkChips}
    </div>
  );
}
