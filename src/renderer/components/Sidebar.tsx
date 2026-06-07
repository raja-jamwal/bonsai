// Sidebar.tsx — handoff component 1 (Recents list) + a new-chat button +
// the smart-collapse BranchTree (component 2) nested under the active row.
//
// Search: clicking the search icon opens an input at the top of the sidebar.
// While query is non-empty the recents list is replaced by search results;
// each result shows the conversation title + a content snippet (if a message
// matched rather than the title). Clicking a result opens the conversation
// and, for content hits, navigates to the matching node's branch.
import { useState, useEffect, useRef } from 'react';
import { useStore } from '../state/store';
import { api } from '../api';
import { Icon } from './Icon';
import { BranchTree } from './BranchTree';
import type { ConversationSummary, SearchResult } from '@shared/types';

export function Sidebar() {
  const store = useStore();
  const {
    conversations,
    activeConversationId,
    branchTreeVisible,
    nodes,
  } = store;

  // Search state (local — not in the global store).
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input whenever the search panel opens.
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  // Debounced search: fires 200 ms after the query stops changing.
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      void api.searchConversations(query.trim()).then(setResults);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  function closeSearch(): void {
    setSearchOpen(false);
    setQuery('');
    setResults([]);
  }

  async function openSearchResult(result: SearchResult): Promise<void> {
    closeSearch();
    await store.openConversation(result.conversationId);
    // For content hits, navigate to the branch that contains the matched node.
    if (result.nodeId) {
      await store.switchLeaf(result.nodeId);
    }
  }

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

  function renderSearchResult(r: SearchResult, i: number) {
    const isActive = r.conversationId === activeConversationId;
    return (
      <button
        key={`${r.conversationId}-${r.nodeId ?? 'title'}-${i}`}
        type="button"
        className={['search-result-row', isActive ? 'active' : ''].filter(Boolean).join(' ')}
        onClick={() => void openSearchResult(r)}
      >
        <span className="search-result-title">
          {r.conversationTitle || 'Untitled conversation'}
        </span>
        {r.nodeId ? (
          <span className="search-result-snippet">{r.snippet}</span>
        ) : null}
      </button>
    );
  }

  return (
    <aside className="sidebar">
      {/* Section label row: Recents (or search input) + icon buttons. */}
      <div className="sidebar-section-label sidebar-header-row">
        {searchOpen ? (
          <div className="search-input-wrap">
            <Icon name="search" size={13} className="search-input-icon" />
            <input
              ref={inputRef}
              className="search-input"
              placeholder="Search conversations…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') closeSearch();
              }}
            />
            {query ? (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => setQuery('')}
                title="Clear"
              >
                <Icon name="x" size={12} />
              </button>
            ) : null}
          </div>
        ) : (
          <span>Recents</span>
        )}

        <div className="sidebar-header-actions">
          <button
            type="button"
            className={`pane-head-icon-btn${searchOpen ? ' active' : ''}`}
            title={searchOpen ? 'Close search' : 'Search conversations'}
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          >
            <Icon name="search" size={15} />
          </button>
          {!searchOpen ? (
            <button
              type="button"
              className="pane-head-icon-btn"
              title="New conversation"
              onClick={() => void onNewChat()}
            >
              <Icon name="square-pen" size={15} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Content: search results when querying, recents otherwise. */}
      {searchOpen && query.trim() ? (
        results.length > 0 ? (
          <div className="search-results">
            {results.map(renderSearchResult)}
          </div>
        ) : (
          <div className="search-empty">No results for "{query}"</div>
        )
      ) : (
        conversations.map(renderRecent)
      )}
    </aside>
  );
}
