// EngineSetupModal — shown when the `claude` CLI can't be resolved (CL-10).
// Lets the user locate the binary via the OS file picker or by pasting a path;
// the choice is validated and persisted (SQLite meta) by the main process, so it
// survives restarts and a stripped PATH (e.g. a packaged app launched from
// Finder). On success the app becomes usable without a restart.
import { useState } from 'react';
import { api } from '../api';
import { Icon } from './Icon';
import type { EngineStatus } from '@shared/types';

export function EngineSetupModal({
  engine,
  onResolved,
}: {
  engine: EngineStatus;
  onResolved: (status: EngineStatus) => void;
}) {
  const [pathInput, setPathInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(engine.error);

  async function apply(path: string): Promise<void> {
    const p = path.trim();
    if (!p || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await api.setClaudePath(p);
      if (status.ok) onResolved(status);
      else setError(status.error ?? 'That path is not a runnable claude CLI.');
    } finally {
      setBusy(false);
    }
  }

  async function browse(): Promise<void> {
    const picked = await api.pickClaudeBinary();
    if (picked) await apply(picked);
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <h2 className="modal-title">
          <Icon name="git-branch" size={16} /> Locate the Claude CLI
        </h2>
        <p className="modal-sub">
          {error ??
            'Select the claude executable to continue. This is saved so you only do it once.'}
        </p>

        <div className="modal-row">
          <button
            type="button"
            className="composer-pill-btn"
            onClick={() => void browse()}
            disabled={busy}
          >
            <Icon name="folder" size={14} /> Browse…
          </button>
          <span className="modal-or">or paste a path</span>
        </div>

        <div className="modal-row">
          <input
            className="modal-input"
            placeholder="/path/to/claude"
            value={pathInput}
            spellCheck={false}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void apply(pathInput);
            }}
          />
          <button
            type="button"
            className="composer-ask"
            onClick={() => void apply(pathInput)}
            disabled={busy || pathInput.trim().length === 0}
          >
            {busy ? 'Checking…' : 'Use path'}
          </button>
        </div>

        <div className="modal-hint">
          Common locations: <code>~/.claude/local/claude</code>,{' '}
          <code>/opt/homebrew/bin/claude</code>, <code>/usr/local/bin/claude</code>. In a
          terminal, <code>which claude</code> prints yours.
        </div>
      </div>
    </div>
  );
}
