// Artifact runtime — runs INSIDE the sandboxed, opaque-origin artifact.html
// iframe (no parent/window.api/network access; see artifact.html). It receives
// code from the app via postMessage, transpiles JSX/TS with sucrase, mounts a
// React component or injects an HTML fragment, and reports rendered height +
// errors back. It is intentionally the only place untrusted code executes.
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { transform } from 'sucrase';

// Message protocol (mirrored in components/artifactMessages.ts).
interface RenderMessage {
  __artifact: true;
  type: 'render';
  kind: 'react' | 'html';
  code: string;
}

const rootEl = document.getElementById('root') as HTMLElement;
let reactRoot: ReactDOMClient.Root | null = null;

function post(message: Record<string, unknown>): void {
  parent.postMessage({ __artifact: true, ...message }, '*');
}

function postHeight(): void {
  // Full content height including padding/overflow.
  const h = Math.ceil(document.documentElement.scrollHeight);
  post({ type: 'height', height: h });
}

function showError(message: string): void {
  if (reactRoot) {
    reactRoot.unmount();
    reactRoot = null;
  }
  const pre = document.createElement('pre');
  pre.className = 'artifact-error';
  pre.textContent = message;
  rootEl.replaceChildren(pre);
  post({ type: 'error', message });
}

/** CommonJS-style require shim — only React is available to artifacts. */
function makeRequire(): (name: string) => unknown {
  return (name: string) => {
    if (name === 'react') return React;
    if (name === 'react-dom') return ReactDOMClient;
    if (name === 'react-dom/client') return ReactDOMClient;
    throw new Error(`Module "${name}" is not available in artifacts (only "react" / "react-dom").`);
  };
}

function renderReact(code: string): void {
  // classic runtime -> React.createElement (React is provided in scope below).
  const out = transform(code, {
    transforms: ['jsx', 'typescript', 'imports'],
    jsxRuntime: 'classic',
  }).code;

  const module: { exports: Record<string, unknown> } = { exports: {} };
  // `React` is passed in scope so JSX (classic runtime -> React.createElement)
  // works even when the snippet doesn't `import React`.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('require', 'module', 'exports', 'React', out);
  fn(makeRequire(), module, module.exports, React);

  const Comp =
    (module.exports.default as React.ComponentType | undefined) ??
    (module.exports.App as React.ComponentType | undefined);
  if (typeof Comp !== 'function') {
    throw new Error(
      'No component found. `export default` your component (e.g. `export default function App() { … }`).'
    );
  }
  if (!reactRoot) reactRoot = ReactDOMClient.createRoot(rootEl);
  reactRoot.render(React.createElement(Comp));
}

function renderHtml(code: string): void {
  if (reactRoot) {
    reactRoot.unmount();
    reactRoot = null;
  }
  rootEl.innerHTML = code; // styles apply; <script> elements do NOT auto-run here
  // Re-execute inline scripts (innerHTML never runs them). External src is
  // blocked by CSP anyway, so only inline bodies run.
  rootEl.querySelectorAll('script').forEach((s) => {
    if (s.src) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function(s.textContent ?? '')();
    } catch (err) {
      post({ type: 'error', message: `Script error: ${(err as Error).message}` });
    }
  });
}

window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as Partial<RenderMessage> | null;
  if (!data || data.__artifact !== true || data.type !== 'render') return;
  try {
    if (data.kind === 'react') renderReact(data.code ?? '');
    else renderHtml(data.code ?? '');
  } catch (err) {
    showError((err as Error).stack ?? String(err));
    return;
  }
  // Measure after the browser has laid out the new content.
  requestAnimationFrame(() => requestAnimationFrame(postHeight));
});

// Keep the host sized to the content as it changes (images load, layout shifts).
new ResizeObserver(() => postHeight()).observe(document.documentElement);

post({ type: 'ready' });
