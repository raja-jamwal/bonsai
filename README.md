# Branching Claude — Desktop

A tree-structured conversation client for the Claude CLI, built in **Electron + SQLite + React**.
Fork from any message, navigate branches, and keep a recoverable tree of explorations.

Implements [`TECHNICAL_REQUIREMENTS.md`](./TECHNICAL_REQUIREMENTS.md) (the engine) and the
[design handoff](./design_handoff_branching_conversations/README.md) (the UI).

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

- Node 20+ and the `claude` CLI on `PATH` (verified against CLI `2.1.168`).

## Run

```bash
npm install        # installs deps + rebuilds better-sqlite3 for Electron
npm run dev        # launch in dev (HMR)
npm run build      # production bundle into out/
npm start          # run the built app
npm run package    # build a distributable (electron-builder)
```

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
