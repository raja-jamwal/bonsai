// Artifact.tsx — renders an interactive artifact (small React/HTML app) inside a
// sandboxed <iframe> that loads the isolated artifact.html host.
//
// Isolation: the iframe uses sandbox="allow-scripts" WITHOUT allow-same-origin,
// so the host runs at an opaque origin and cannot reach window.parent/window.api,
// the app DOM, cookies, or storage. The app and host communicate only via
// postMessage. Code never auto-runs: the user clicks "Run" (run-to-execute), so
// code from a conversation can't execute just by being shown.
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import type { ArtifactKind } from './artifactParse';

// Same-origin host doc; the app CSP's frame-src falls back to default-src 'self'.
const ARTIFACT_SRC = './artifact.html';
const MIN_H = 80;
const MAX_H = 2000;

interface ArtifactMsg {
  __artifact?: true;
  type?: 'ready' | 'height' | 'error';
  height?: number;
  message?: string;
}

const KIND_LABEL: Record<ArtifactKind, string> = { react: 'React app', html: 'HTML' };

export function Artifact({ kind, code }: { kind: ArtifactKind; code: string }) {
  const [running, setRunning] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [height, setHeight] = useState(240);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);

  function postRender(): void {
    iframeRef.current?.contentWindow?.postMessage(
      { __artifact: true, type: 'render', kind, code },
      '*'
    );
  }

  // While running, listen for host messages (ready -> send code; height -> resize).
  useEffect(() => {
    if (!running) return;
    ready.current = false;
    setError(null);
    function onMessage(e: MessageEvent): void {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as ArtifactMsg;
      if (!d || d.__artifact !== true) return;
      if (d.type === 'ready') {
        ready.current = true;
        postRender();
      } else if (d.type === 'height' && typeof d.height === 'number') {
        setHeight(Math.min(Math.max(d.height, MIN_H), MAX_H));
      } else if (d.type === 'error') {
        setError(String(d.message ?? 'Artifact error'));
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Re-send if the code changes after the host is ready (e.g. a re-render).
  useEffect(() => {
    if (running && ready.current) postRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  return (
    <div className="artifact">
      <div className="artifact-head">
        <span className="artifact-kind">
          <Icon name="square" size={12} />
          {KIND_LABEL[kind]}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="artifact-btn"
          onClick={() => setShowCode((v) => !v)}
        >
          <Icon name="copy" size={12} />
          {showCode ? 'Hide code' : 'Code'}
        </button>
        <button
          type="button"
          className="artifact-btn run"
          onClick={() => (running ? postRender() : setRunning(true))}
        >
          <Icon name="chevrons-right" size={12} />
          {running ? 'Re-run' : 'Run'}
        </button>
      </div>

      {showCode ? (
        <pre className="artifact-code">
          <code>{code}</code>
        </pre>
      ) : null}

      {running ? (
        <div className="artifact-frame-wrap">
          <iframe
            ref={iframeRef}
            className="artifact-frame"
            title={`${KIND_LABEL[kind]} artifact`}
            src={ARTIFACT_SRC}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            style={{ height }}
          />
          {error ? <div className="artifact-error-banner">{error}</div> : null}
        </div>
      ) : (
        <button type="button" className="artifact-run-cta" onClick={() => setRunning(true)}>
          <Icon name="chevrons-right" size={14} />
          Run this {KIND_LABEL[kind]}
        </button>
      )}
    </div>
  );
}
