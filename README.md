# Pixora

Premium Windows-first desktop app for local AI image enhancement and upscaling.
Your images are processed on your own machine and never uploaded.

**Current status:** Stage 03 — file system + image import. The Enhance
workspace now accepts real files: native drag & drop (whole-window overlay,
validated in Rust) and a native image-filtered file picker import JPG, PNG,
and WebP into an ordered, deduplicated collection with per-file error
feedback and a local preview + metadata inspector. The enhancement engine,
batch queue, and licensing arrive in later stages.

## Image import pipeline (Stage 03)

```
Drag onto window (Tauri core event — webview gets no filesystem permission)
or Choose files (dialog opens on the Rust side; the webview has no dialog ACL)
  ↓ paths
import_images command → services/import.rs validation ladder:
  extension → existence/read → size caps (200 MB file · 64 MP pixels,
  checked before decode) → content sniff must match the extension →
  decode → canonical path
  ↓ per-file outcomes (one bad file never blocks the batch)
ImportedImage { id, name, format, width, height, sizeBytes, previewDataUrl }
  ↓ reducer (dedup by canonical id)
Enhance workspace: thumbnail rail + inspector
```

- All decoding and previews happen on this machine; images and metadata are
  never uploaded or logged.
- Supported formats are declared in exactly two places: `image` crate
  features in `Cargo.toml` and `FormatHint::from_extension` in
  `services/import.rs`. Adding a format means touching those and nothing
  else.
- Error messages are user-safe (`file_missing`, `unsupported_format`,
  `invalid_image`, `file_too_large`, …); internal detail goes to the log.
- Stage 08's batch queue builds on `state.images` — the ordered imported
  collection in `appReducer`.

## Stack

- **Shell:** Tauri 2 (Rust backend, WebView2 frontend)
- **UI:** React 19 + TypeScript (strict) + Vite — no UI framework, no icon library
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

## Frontend layers

```
src/
├── ipc/          # typed bridge to native commands (sole invoke caller)
├── state/        # reducer + context, bootstrap/theme/shortcut hooks
├── ui/           # design system — buttons, fields, dialogs, menus, badges,
│                 # progress, notifications, tooltips, empty/loading/error states.
│                 # Import from here only; never re-skin these primitives.
├── styles/       # tokens.css (single source of visual truth),
│                 # base.css (reset/utilities), motion.css (shared keyframes)
├── shell/        # application chrome: TopBar, NavRail, StatusBar, dialogs
├── views/        # one file per navigation destination (Enhance/Batch/History)
├── components/   # pre-Stage-02 pieces (StatusDot) — migrate into ui/ when touched
└── types/        # IPC payload types shared across the native boundary
```

Design-system rules for future stages:

- **New visual values go into `tokens.css` only.** Components consume tokens;
  they never hard-code colors, spacing, radii, durations, or z-layers.
- **`src/ui` owns every primitive.** Views compose them; they don't define
  new button/field/badge styles inline.
- **Motion:** entries use the `pixora-*` keyframes from `motion.css` with
  `--ease-decelerate`; state changes use `--ease-standard` at
  `--duration-fast/base`. Nothing bounces; reduced motion is handled globally.
- **State:** feature stores follow `appReducer.ts` — typed actions, one pure
  reducer, context access via `useAppState`-style hooks.
- **Empty ≠ fake.** When a capability isn't wired, ship an honest empty
  state (see `ui/States.tsx`) or a disabled control with a tooltip — never a
  decorative placeholder result.

## Layout

```
├── src/                  # React frontend
│   ├── ipc/              # typed bridge to native commands (sole invoke caller)
│   ├── state/            # reducer + context, bootstrap/import/drag-drop hooks
│   ├── ui/               # design system primitives
│   ├── shell/            # desktop chrome (top bar, nav rail, status bar, dialogs,
│   │                     # drop overlay)
│   ├── views/            # Enhance / Batch / History
│   ├── lib/              # pure display helpers (formatBytes, …)
│   ├── styles/           # design tokens + base styles + motion (light/dark)
│   ├── components/       # reusable UI pieces (pre-Stage-02)
│   ├── types/            # IPC payload types shared across the boundary
│   └── test/             # integration-style component tests
├── src-tauri/            # Rust backend
│   ├── src/commands/     # thin Tauri command layer
│   ├── src/services/     # native logic (system info, image import; inference later)
│   ├── src/error.rs      # AppError — the safe boundary error type
│   ├── src/config.rs     # build-sourced app configuration
│   ├── examples/         # manual-QA fixture generators (import_fixtures)
│   ├── capabilities/     # least-privilege webview permissions
│   └── tauri.conf.json   # window, CSP, bundling
└── assets/               # source assets (app icon master SVG)
```
