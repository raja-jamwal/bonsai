// Renderer bootstrap. Mounts the React tree into #root.
// App.tsx and the components under ./components are authored by other agents;
// this module only wires React + the global stylesheets.
import React from 'react';
import ReactDOM from 'react-dom/client';

// Design tokens first (defines :root custom properties + reset), then layout.
import './styles/tokens.css';
import './styles/app.css';

import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
