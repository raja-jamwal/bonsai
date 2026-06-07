// Main process entry point — app lifecycle and engine wiring.
//
// On ready: open the SQLite DB in userData, recover orphaned streaming
// nodes from a prior crash, resolve the `claude` binary, build the
// Repo and ClaudeRunner, create the sandboxed window, register the IPC
// handlers, and load the renderer (electron-vite dev URL or built file).

import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase, recoverOrphans } from './db/database.js';
import { Repo } from './db/repo.js';
import { ClaudeRunner } from './claude/runner.js';
import { resolveClaude } from './claude/resolve.js';
import { registerIpcHandlers } from './ipc/handlers.js';
import type { EngineStatus } from '@shared/types';

// ESM ("type":"module"): derive __dirname from import.meta.url.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Pin the app name so userData (the SQLite location) is the SAME regardless of
// how the app is launched. Without this, an unpackaged launch can resolve to the
// default "Electron" name and write to a *different* userData dir than
// `npm run dev`, silently splitting the database across two files.
app.setName('branching-claude');

// The single application window. Kept module-scoped so getWindow() can hand it to
// the IPC layer for per-turn streaming ports.
let win: BrowserWindow | null = null;

/**
 * Create the main window with the locked-down web preferences:
 * context isolation on, Node integration off, sandbox on. The renderer can
 * only reach privileged work through the preload bridge.
 */
function createWindow(): void {
  win = new BrowserWindow({
    title: 'Bonsai',
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      // Built preload sits next to the built main bundle: out/main -> out/preload.
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });

  // electron-vite convention: in dev the renderer is served from a vite URL; in
  // production load the built HTML from disk.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// All engine setup happens after the app is ready (privileged APIs available).
void app.whenReady().then(async () => {
  // Single SQLite file in the app's userData directory.
  const dbPath = join(app.getPath('userData'), 'branching-claude.db');
  const db = openDatabase(dbPath); // pragmas + migrations

  // Mark any nodes left mid-stream by a crash as errored before serving UI.
  recoverOrphans(db);

  const repo = new Repo(db);

  // Resolve the claude binary up front. Prefer the path the user saved in
  // SQLite (survives restarts and a stripped PATH in a packaged app), else fall
  // back to PATH detection. Status is surfaced to the renderer via engine:status;
  // if unresolved, the renderer offers a locate dialog (engine:setClaudePath).
  let status: EngineStatus = await resolveClaude(repo.getSetting('claude_path'));
  const runner = new ClaudeRunner(status.claudePath ?? 'claude');

  createWindow();

  registerIpcHandlers({
    repo,
    runner,
    engineStatus: () => status,
    setEngineStatus: (s) => {
      status = s;
    },
    getWindow: () => win,
  });

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Standard lifecycle: quit when all windows close, except on macOS where apps
// conventionally stay active until the user explicitly quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
