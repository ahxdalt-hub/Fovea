# Local AI Image Upscaler

Premium Windows-first desktop app for local AI image enhancement and upscaling.
Your images are processed on your own machine and never uploaded.

**Current status:** Stage 01 — foundation and architecture. The app boots,
verifies the native core, and shows system status. Image processing, batch
work, licensing, and the full product UI arrive in later stages.

## Stack

- **Shell:** Tauri 2 (Rust backend, WebView2 frontend)
- **UI:** React 19 + TypeScript (strict) + Vite
- **Quality:** oxlint + Prettier (frontend), rustfmt + clippy (Rust), vitest + Testing Library

## Getting started (Windows)

Prerequisites:

- [Rust toolchain](https://rustup.rs) — `stable-x86_64-pc-windows-msvc` (pinned by `rust-toolchain.toml`)
- Visual Studio Build Tools 2022 with the _Desktop development with C++_ workload
  (Tauri docs: <https://v2.tauri.app/start/prerequisites/windows/>)
- WebView2 runtime (preinstalled on current Windows 11)
- Node.js 20+ and npm

```sh
npm install          # install frontend dependencies
npm run tauri dev    # run the desktop app (Vite dev server + native shell)
```

## Everyday commands

| Command               | What it does                                                      |
| --------------------- | ----------------------------------------------------------------- |
| `npm run dev`         | Vite dev server alone (browser, no native IPC)                    |
| `npm run tauri dev`   | Full desktop app in development                                   |
| `npm run tauri build` | Release bundle (MSI/NSIS under `src-tauri/target/release/bundle`) |
| `npm test`            | Frontend unit/integration tests (vitest)                          |
| `npm run typecheck`   | TypeScript strict type check                                      |
| `npm run lint`        | oxlint + prettier check                                           |
| `npm run lint:fix`    | Auto-fix lint and formatting                                      |
| `npm run test:rust`   | Cargo test for the native layer                                   |
| `npm run rust:lint`   | clippy + rustfmt check                                            |

## Architecture

```
React UI (src/)
  ↓  typed bridge — src/ipc/bridge.ts (only place that calls invoke)
App state (src/state/ — reducer + context, no store library)
  ↓
Tauri commands (src-tauri/src/commands/) — validate & forward only
  ↓
Rust services (src-tauri/src/services/) — all real logic lives here
  ↓
OS / filesystem / hardware … (added by later stages)
```

Key boundaries:

- **Errors:** Rust `AppError` (`src-tauri/src/error.rs`) serializes to
  `{ code, message }` with a user-safe message. Internal detail goes to the
  log, never to the UI. `src/types/ipc.ts` mirrors the codes and normalizes
  anything unexpected into the same safe shape.
- **Logging:** tauri-plugin-log writes to the app log directory (and stdout
  in dev). The frontend can relay console-level messages via
  `write_frontend_log`. Never log image content or sensitive paths.
- **Security:** capabilities (`src-tauri/capabilities/default.json`) grant the
  webview only core event/window plumbing plus the logger — no filesystem,
  shell, or network permissions. A restrictive CSP is set in
  `tauri.conf.json`.
- **Config:** product identity/version come from Rust (`get_config`), so the
  frontend never duplicates build constants.

Product rules that shape everything:

1. Image processing stays 100% local.
2. The inference engine will be a replaceable service behind its own
   interface — the UI must never depend on a specific model.
3. Licensing, website, and cloud concerns stay out of the processing path.

## Layout

```
├── src/                  # React frontend
│   ├── ipc/              # typed bridge to native commands (sole invoke caller)
│   ├── state/            # reducer + context, bootstrap hook
│   ├── components/       # reusable UI pieces
│   ├── styles/           # design tokens + base styles (light/dark)
│   ├── types/            # IPC payload types shared across the boundary
│   └── test/             # integration-style component tests
├── src-tauri/            # Rust backend
│   ├── src/commands/     # thin Tauri command layer
│   ├── src/services/     # native logic (system info today; image/inference later)
│   ├── src/error.rs      # AppError — the safe boundary error type
│   ├── src/config.rs     # build-sourced app configuration
│   ├── capabilities/     # least-privilege webview permissions
│   └── tauri.conf.json   # window, CSP, bundling
└── assets/               # source assets (app icon master SVG)
```
