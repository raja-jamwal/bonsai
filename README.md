# Bonsai

A tree-structured, branching conversation client for the Claude CLI, built in **Electron + SQLite + React**.
Fork from any message, navigate branches, and keep a recoverable tree of explorations.

## Architecture

| Concern | Process | Where |
|---|---|---|
| Claude CLI invocation, stream-json parsing | Main | `src/main/claude/{runner,parser,resolve}.ts` |
| Persistence (`better-sqlite3`, WAL) | Main | `src/main/db/{database,repo,schema}.ts` |
| Path validation / directory scoping | Main | `src/main/paths.ts` |
| IPC + per-turn streaming | Main | `src/main/ipc/handlers.ts` |
| Bridge (`contextBridge`) | Preload | `src/preload/index.ts` |
| UI (tree, breadcrumb, stream, composer) | Renderer | `src/renderer/**` |
| Shared contract (the seam) | — | `src/shared/types.ts` |

- **Security (AR-1):** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, plus a renderer CSP.
- **Stateless replay (CL-4):** each turn spawns a fresh `claude -p` subprocess; the full branch path is reconstructed from SQLite and streamed to stdin as NDJSON. SQLite is the single source of truth — no `~/.claude` session dependency.
- **Streaming:** main pushes token deltas over a `MessageChannelMain` port; the preload holds the port (isolated world) and re-emits plain events to the page via `api.onTurnEvent` (raw `MessagePort` can't cross `contextBridge`).
- **Branching model:** a *branch* = a leaf node; the *path* = root→leaf node chain; a *fork point* = a node with >1 child; *siblings* = children of the same parent. Regenerate and edit-user are special cases of branch; nodes are immutable once `complete` (BR-3).

## Prerequisites

- Node 20+ and the `claude` CLI installed (verified against CLI `2.1.168`).
- The `claude` binary must be on your `PATH` — run `which claude` to confirm.

## Running

```bash
git clone https://github.com/raja-jamwal/bonsai.git
cd bonsai
npm install        # installs deps + rebuilds better-sqlite3 for Electron
npm run dev        # launch in dev (HMR)
npm run build      # production bundle into out/
npm start          # run the built app
npm run package    # build a distributable (electron-builder)
```

The app window opens automatically. Data is stored in
`~/Library/Application Support/Bonsai/bonsai.db`.

## Known issue — macOS 26.5.1 (Code Signature Invalid)

On macOS 26.5.1 the `claude` CLI binary (v2.1.168) is killed with
`SIGKILL (Code Signature Invalid)` every time it is spawned as a subprocess —
regardless of the parent process (Electron, Node.js, Python, shell, etc.) or
whether a PTY is used. Interactive use from the terminal prompt is unaffected.

This is a macOS 26 security-policy change, not a Bonsai bug. `npm run dev`
does **not** work around it — Electron still spawns claude as a child process.

**Fix:** update the `claude` CLI. Run `claude update` or reinstall from
`https://claude.ai/download`. A newer signed build from Anthropic should pass
the validation. Until then the app will show *"claude exited with code unknown"*
on every turn.

## Test

```bash
npm test                                        # unit tests (parser fixture + db/repo)
npm run typecheck                               # tsc for main+preload and renderer
RUN_LIVE=1 npx vitest run test/live.engine.test.ts   # opt-in: real round-trip vs the claude CLI
```

`test/fixtures/stream_capture.ndjson` is a real captured `--output-format stream-json` stream
that the parser is tested against (resolves the §7 open items in the spec).

### Native module note (dual ABI)

`better-sqlite3` is a native module; Node (tests) and Electron (app) use different ABIs.
The scripts handle this automatically: `pretest` rebuilds for Node, `predev`/`prestart`/`prepackage`
rebuild for Electron. If you ever hit a `NODE_MODULE_VERSION` error, run `npm run rebuild:electron`
(for the app) or `npm run rebuild:node` (for tests).

## Verification status

All verified on this machine:

- ✅ `npm run typecheck` — clean (main+preload and renderer)
- ✅ `npm test` — 12/12 (parser against the real fixture; db branching, alternation, cascade, `effectiveDirs`, thread CTE)
- ✅ `npm run build` — main/preload/renderer bundles built
- ✅ App boots; renderer mounts; UI renders the empty state
- ✅ Full-stack turn (driven via the live renderer): streamed tokens + persisted `complete` node with usage
- ✅ Full-stack branching: `regenerate` and `editUser` create siblings; original nodes retained; `active_leaf` tracks the newest branch
- ✅ Live engine round-trip against the real `claude` CLI
