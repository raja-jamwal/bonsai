// Composer.tsx — handoff component 9 (the reply composer).
//
// A 760px-centered card: a textarea (placeholder "Reply on this branch…"), then
// a bottom row with a + button, the "Ask" pill (submit -> store.sendTurn), a
// right-aligned model selector, and a mic icon; a disclaimer sits below.
//
// Enter submits, Shift+Enter inserts a newline. The composer is disabled while
// a turn on the current leaf is streaming (the active leaf node, or its last
// assistant child, is in status === 'streaming').
import { useState, useRef, useEffect } from 'react';
import { useStore } from '../state/store';
import { Icon } from './Icon';
import { MODEL_OPTIONS } from '@shared/types';

export function Composer() {
  const store = useStore();
  const [text, setText] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const currentModelId = store.tree?.conversation.model ?? null;
  const currentModelLabel =
    MODEL_OPTIONS.find((m) => m.id === currentModelId)?.label ??
    currentModelId ??
    'Default model';

  // Close the model menu on outside click / ESC.
  useEffect(() => {
    if (!modelOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.composer-model-wrap')) setModelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setModelOpen(false);
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [modelOpen]);

  // Close the Ask permission-mode menu on outside click / ESC.
  useEffect(() => {
    if (!askOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.composer-ask-wrap')) setAskOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAskOpen(false);
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [askOpen]);

  // Attach files: open the OS picker, then append the chosen paths into the
  // composer so the model gets them (their directories are attached for read
  // access in the store). The user can add a note around the paths before send.
  async function attach(): Promise<void> {
    const files = await store.attachFiles();
    if (files.length === 0) return;
    setText((prev) => {
      const block = files.map((f) => `Attached file: ${f}`).join('\n');
      return prev.trim() ? `${prev.trim()}\n${block}\n` : `${block}\n`;
    });
    requestAnimationFrame(() => {
      taRef.current?.focus();
      autosize();
    });
  }

  // Streaming guard: only the *submit* is blocked while the active leaf is a
  // streaming assistant node. The textarea stays enabled so the user keeps focus
  // and can type ahead — disabling it dropped focus after every send.
  const path = store.activePath();
  const leaf = path[path.length - 1];
  const isStreaming = leaf?.status === 'streaming';

  // Keep the composer focused: on mount, when the active branch / conversation
  // changes, and when entering draft-fork mode (so typing is always ready).
  useEffect(() => {
    taRef.current?.focus();
  }, [store.activeLeafId, store.activeConversationId, store.fork]);

  function autosize(): void {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }

  async function submit(): Promise<void> {
    const value = text.trim();
    if (!value || isStreaming) return;
    setText('');
    if (taRef.current) {
      taRef.current.style.height = 'auto';
      taRef.current.focus(); // retain focus across the send + re-render
    }
    await store.sendTurn(value);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
    // Shift+Enter falls through to insert a newline.
  }

  const mode = store.permissionMode;
  const folders = store.branchFolders();

  return (
    <div className="composer">
      <div className="composer-inner">
        {/* Attached folders (Claude's working dirs for this branch). */}
        {folders.length > 0 ? (
          <div className="folder-chips">
            {folders.map((f) => (
              <span
                key={f.id}
                className={`folder-chip${f.node_id ? ' branch' : ''}`}
                title={`${f.dir_path}${f.node_id ? ' (this branch)' : ' (whole conversation)'}`}
              >
                <Icon name="folder" size={12} />
                {f.dir_path.replace(/.*[/\\]/, '') || f.dir_path}
                <button
                  type="button"
                  className="folder-chip-x"
                  title="Remove folder"
                  onClick={() => void store.removeFolder(f.id)}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="composer-card">
          <textarea
            ref={taRef}
            className="composer-textarea"
            placeholder={store.fork ? 'Start a new branch — type your first message…' : 'Reply on this branch…'}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autosize();
            }}
            onKeyDown={onKeyDown}
            rows={1}
          />
          <div className="composer-row">
            <button
              type="button"
              className="composer-icon-btn"
              title="Attach file(s)"
              onClick={() => void attach()}
            >
              <Icon name="plus" size={16} />
            </button>

            {/* Add folder — the directory Claude is spawned in for this branch. */}
            <button
              type="button"
              className="composer-pill-btn"
              title="Attach a working folder for Claude"
              onClick={() => void store.addFolder()}
            >
              <Icon name="folder-plus" size={14} />
              Add folder
            </button>

            {/* Ask split-button: primary action sends; the caret picks the mode. */}
            <div className="composer-ask-wrap">
              <button
                type="button"
                className={`composer-ask${mode === 'act' ? ' act' : ''}`}
                onClick={() => void submit()}
                disabled={isStreaming || text.trim().length === 0}
              >
                <Icon name={mode === 'act' ? 'chevrons-right' : 'hand'} size={13} />
                {mode === 'act' ? 'Act' : 'Ask'}
              </button>
              <button
                type="button"
                className={`composer-ask-caret${mode === 'act' ? ' act' : ''}`}
                title="Permission mode"
                onClick={() => setAskOpen((v) => !v)}
              >
                <Icon name="chevron-down" size={12} />
              </button>
              {askOpen ? (
                <div className="crumb-menu ask-menu">
                  <button
                    type="button"
                    className="mode-item"
                    onClick={() => {
                      setAskOpen(false);
                      store.setPermissionMode('ask');
                    }}
                  >
                    <Icon name="hand" size={16} />
                    <span className="mode-text">
                      <span className="mode-title">Ask before acting</span>
                      <span className="mode-desc">Claude pauses so you can approve each action.</span>
                    </span>
                    {mode === 'ask' ? <Icon name="chevron-right" size={14} /> : null}
                  </button>
                  <button
                    type="button"
                    className="mode-item"
                    onClick={() => {
                      setAskOpen(false);
                      store.setPermissionMode('act');
                    }}
                  >
                    <Icon name="chevrons-right" size={16} />
                    <span className="mode-text">
                      <span className="mode-title">Act without asking</span>
                      <span className="mode-desc">Claude works without pausing for approval.</span>
                    </span>
                    {mode === 'act' ? <Icon name="chevron-right" size={14} /> : null}
                  </button>
                </div>
              ) : null}
            </div>

            <span className="spacer" />
            <div className="composer-model-wrap">
              <button
                type="button"
                className="composer-model"
                title="Model"
                onClick={() => setModelOpen((v) => !v)}
              >
                {currentModelLabel}
                <Icon name="chevron-down" size={12} />
              </button>
              {modelOpen ? (
                <div className="crumb-menu model-menu">
                  {MODEL_OPTIONS.map((m) => (
                    <button
                      key={m.label}
                      type="button"
                      className={`crumb-menu-item${m.id === currentModelId ? ' active' : ''}`}
                      onClick={() => {
                        setModelOpen(false);
                        void store.setModel(m.id);
                      }}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="composer-disclaimer">
          Claude is AI and can make mistakes. Please double-check responses.
        </div>
      </div>
    </div>
  );
}
