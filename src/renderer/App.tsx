// App.tsx — the two-column app shell (handoff "Layout": 280px sidebar + 1fr
// conversation pane).
//
// On mount: loadConversations() (store action) and probe api.engineStatus()
// (CL-10). If the engine is not ok, an actionable banner is surfaced above the
// shell rather than failing silently mid-turn.
//
// If there is no active conversation, the pane area shows an empty state with a
// "New conversation" button (creates a conversation via the bridge, then opens
// it through the store).
import { useEffect, useState } from 'react';
import { useStore } from './state/store';
import { api } from './api';
import { Sidebar } from './components/Sidebar';
import { ConversationPane } from './components/ConversationPane';
import { EngineSetupModal } from './components/EngineSetupModal';
import { Icon } from './components/Icon';
import type { EngineStatus } from '@shared/types';

export function App() {
  const store = useStore();
  const [engine, setEngine] = useState<EngineStatus | null>(null);

  // Load conversations + probe the engine once on mount. Auto-open the most
  // recently updated conversation so the app opens where you left off (and the
  // pane isn't an empty state when history exists).
  useEffect(() => {
    void store.loadConversations().then(() => store.openMostRecent());
    // api.engineStatus() is the one direct bridge call the UI is allowed to make.
    void api
      .engineStatus()
      .then(setEngine)
      .catch((err: unknown) =>
        setEngine({
          claudePath: null,
          claudeVersion: null,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    // Mount-only effect; store identity is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function newConversation(): Promise<void> {
    const id = await api.createConversation({});
    await store.loadConversations();
    await store.openConversation(id);
  }

  const hasActive = Boolean(store.activeConversationId && store.tree);

  return (
    <>
      {/* Engine setup modal (CL-10): blocks until the claude binary is located. */}
      {engine && !engine.ok ? (
        <EngineSetupModal engine={engine} onResolved={setEngine} />
      ) : null}

      <main className="app-shell">
        <Sidebar />

        {hasActive ? (
          <ConversationPane />
        ) : (
          // Empty state when no conversation is active (handoff: provide a
          // clear entry point to start a conversation).
          <section className="pane">
            <div className="empty-state" style={{ gridRow: '1 / -1' }}>
              <Icon name="message-square" size={28} />
              <div>No conversation selected</div>
              <button
                type="button"
                className="composer-ask"
                onClick={() => void newConversation()}
              >
                <Icon name="plus" size={14} />
                New conversation
              </button>
            </div>
          </section>
        )}
      </main>
    </>
  );
}
