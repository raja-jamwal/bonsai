// Sidebar.tsx — handoff component 1 (Recents list) + a new-chat button +
// the smart-collapse BranchTree (component 2) nested under the active row.
//
// The active conversation's recents row differs (handoff §"Left sidebar —
// Recents list"): tinted --brand-tint bg + --fork-ink text, a fork-count badge
// "🌿 N" (white pill, coral border), and a chevron twist that toggles the tree
// (store.toggleTree / store.branchTreeVisible — persisted per-user).
import { useStore } from '../state/store';
import { api } from '../api';
import { Icon } from './Icon';
import { BranchTree } from './BranchTree';
import type { ConversationSummary } from '@shared/types';

export function Sidebar() {
  const store = useStore();
  const {
    conversations,
    activeConversationId,
    branchTreeVisible,
    nodes,
  } = store;

  // Fork count for the active conversation = number of leaves (distinct
  // branches incl. root continuation). A leaf is a node with no children.
  const activeForkCount =
    activeConversationId && nodes.length > 0
      ? nodes.filter((n) => !nodes.some((c) => c.parent_id === n.id)).length
      : 0;

  async function onNewChat(): Promise<void> {
    const id = await api.createConversation({});
    await store.loadConversations();
    await store.openConversation(id);
  }

  function renderRecent(c: ConversationSummary) {
    const isActive = c.id === activeConversationId;

    return (
      <div key={c.id}>
        <button
          type="button"
          className={[
            'recent-row',
            isActive ? 'active' : '',
            isActive && !branchTreeVisible ? 'collapsed' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => {
            // Clicking the active row toggles its tree (handoff "Recent
            // expand"); clicking an inactive row opens that conversation.
            if (isActive) store.toggleTree();
            else void store.openConversation(c.id);
          }}
        >
          <span className="recent-dot" />
          <span className="recent-title">{c.title || 'Untitled conversation'}</span>

          {isActive ? (
            <>
              {/* Fork-count badge "🌿 N" (handoff: leaf glyph + count). */}
              <span className="fork-badge">
                <Icon name="git-branch" size={10} /> {activeForkCount}
              </span>
              {/* Chevron twist toggles the tree visibility. */}
              <span
                className="twist"
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  store.toggleTree();
                }}
              >
                <Icon name="chevron-down" size={13} />
              </span>
            </>
          ) : null}
        </button>

        {/* Smart-collapse branch tree, only under the active+expanded row. */}
        {isActive && branchTreeVisible ? <BranchTree /> : null}
      </div>
    );
  }

  return (
    <aside className="sidebar">
      {/* Section label row + new-chat button (handoff sidebar top). */}
      <div
        className="sidebar-section-label"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        Recents
        <button
          type="button"
          className="pane-head-icon-btn"
          title="New conversation"
          onClick={() => void onNewChat()}
        >
          <Icon name="square-pen" size={15} />
        </button>
      </div>

      {conversations.map(renderRecent)}
    </aside>
  );
}
