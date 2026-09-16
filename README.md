# Pixora

Premium Windows-first desktop app for local AI image enhancement and upscaling.
Your images are processed on your own machine and never uploaded.

**Current status:** Stage 06 — enhancement controls. The full workflow is
live: import → choose 2×/4× and a real enhancement mode → Enhance → the
result opens in the compare slider → export as PNG/JPEG/WebP with quality
and folder choices. Everything runs on this machine: Real-ESRGAN models on
ONNX Runtime (DirectML GPU, CPU fallback). The batch queue and licensing
arrive in later stages.

## Enhancement controls (Stage 06)

```
EnhanceControls strip (src/components/EnhanceControls.tsx)
  Scale 2×/4× · Mode Standard/Natural/Detail — SegmentedFields offering
  only what the installed models genuinely deliver (from native status)
  ↓ Enhance {scale}× (primary action) — transforms to Enhancing… while a
  measured job runs (cancel; failure → retry; completion → result row +
  Compare/Export; compare mode opens automatically on completion)
  ↓ useEnhance → ipc/bridge enhanceImage(imageId, mode, scale, onEvent)
enhance_image command (commands/inference.rs) — validates mode + scale at
the boundary, reserves the single job slot, records the committed master
per image (export authority)
  ↓ services/inference/service.rs — EnhanceMode resolution: Standard →
  general model; Natural → WDN model (genuinely different weights);
  Detail → general model + the engine's real unsharp post-pass. Target
  scale is verified against the model's deliverable set (4× native; 2×
  via model 4× + exact box resample on stream), refused honestly as
  `unsupported_scale` otherwise.
  ↓ services/inference/engine.rs — per-tile PostPass (3×3 blur →
  unsharp mask with bleed context, seam-free) + target-resolution band
  resampling; geometry stays pixel-exact under tests
Export (Stage 06)
  ExportDialog (PNG/JPEG/WebP, quality slider for lossy, native folder
  picker with default `exports/`) → export_enhanced_image command →
  services/export.rs: PNG = byte-identical copy of the master, JPEG =
  alpha flattened on white + quality, WebP = libwebp lossy + alpha;
  atomic `.part` → rename, collision-safe names
```

- **No fake options.** Every visible mode is a different model or a real
  pixel pass; every scale is genuinely produced (verified in the app and
  in `stage06_qa.rs`, which asserts the three modes' outputs are
  byte-different and that q40 < q90 < lossless in file size).
- **Choices persist** (localStorage, like the theme) and self-heal when
  the engine changes under the user (a removed model drops its modes).
- Privacy unchanged: new commands follow the same boundary rules —
  webview gets no dialog/filesystem ACL; the export source is resolved
  server-side from the engine's own registry, never a client path.

## Inference pipeline (Stage 05)

```
Enhance {scale}× / mode choice (src/components/EnhanceControls.tsx)
  ↓ src/ipc/bridge.ts — enhanceImage(imageId, mode, scale, onEvent) via a Tauri Channel
enhance_image command (src-tauri/src/commands/inference.rs) — reserves the
single job slot, spawns blocking work
  ↓ services/inference/
model.rs     — registry: locate → size → SHA-256 → ONNX sniff (one place
               for "where models live"; env override, bundled resources,
               app-data drop folder)
backend.rs   — Backend trait + OnnxBackend (ort / ONNX Runtime,
               DirectML EP preferred, CPU fallback; telemetry OFF)
engine.rs    — pure pipeline: f32 CHW preprocess → tiled inference
               (256 px tiles + 8 px bleed) → row-streamed u8 composite
service.rs   — orchestration: preparing → processing (real tile counts)
               → completing → completed/failed/cancelled; atomic output
               (*.part → rename), JobRegistry cancellation, scratch cleanup
  ↓
enhanced/job-*.png (app-data) + display view for the compare slider
```

- **Progress is a measurement:** done/total completed tiles from native —
  no invented percentages. Preparing/completing phases cover the parts
  between.
- **Cancellation:** `cancel_enhancement(jobId)` flips the token; the
  in-flight ONNX run is terminated via `RunOptions::terminate()`, the
  `.part` file is deleted, the job slot releases.
- **Privacy:** image bytes, model bytes, and output bytes never leave the
  process or the disk. `ureq`/TLS crates in the tree are **build-script
  only** (ORT binary download); the app's runtime capability list is
  unchanged (`core:default` + `log:default` — no network). ONNX Runtime's
  Windows telemetry is explicitly disabled at init.
- **Model:** `realesr-general-x4v3.onnx` (Standard/Detail) and
  `realesr-general-wdn-x4v3.onnx` (Natural) — Real-ESRGAN general 4× and
  its WDN denoising variant, BSD-3-Clause (see `src-tauri/models/README.md`).
  The engine layer is trait-based: swapping the runtime/model never touches
  UI, commands, or pipeline geometry.
- Engine errors reach the UI as new user-safe codes: `model_missing`,
  `model_corrupt`, `engine_unavailable`, `unsupported_scale`, `cancelled`.

## Image workspace (Stage 04)

```
Selected image (app state: selectedImageId, survives navigation)
  ↓ src/lib/viewer.ts — pure fit/zoom/pan math (clamped, centered)
One CSS transform on a natural-size layer → GPU-composited, no per-pixel work
  ↓ source tiers (src/state/imageSources.ts — cache, in-flight dedup)
previewDataUrl (small, from import) → paint instantly
load_image_view 2600 px longest edge (or pristine bytes when smaller)
load_image full resolution — fetched ONLY when zoom exceeds the view
  ↓ comparison (src/components/CompareSplit.tsx)
Original vs Enhanced share one transformed frame → same region, same scale
Enhanced side: honest pending panel until Stage 05 produces ImageEnhancementDto
```

- Viewer keys (stage focus): `+`/`−` zoom · `0` fit · `1` actual size ·
  `C` compare · `F` fullscreen · double-click toggles fit/actual.
- Fit never magnifies past 1:1 — small images stay sharp, never blurry.
- The 2,400 px–7,000 px fixture set was inspected visually across
  portrait/landscape/square/huge aspect ratios, both themes, light and
  dark chrome.
- Browser dev QA: `npm run dev` → `?demo=images` (+ `&theme=dark`,
  `&demo=enhanced` for the compare-result layout). Dev-only, stripped
  from release; the desktop app never shows synthetic images.
- Stage 05 contract: dispatch `enhancements/set` with an
  `ImageEnhancementDto` and the compare slider, info chip, and mode
  affordances light up — no UI work required for the result path.

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
├── state/        # reducer + context, bootstrap/theme/shortcut/import hooks,
│                 # imageSources cache (preview/view/full tiers)
├── hooks/        # DOM helpers (useElementSize — ResizeObserver)
├── ui/           # design system — buttons, fields, dialogs, menus, badges,
│                 # progress, notifications, tooltips, empty/loading/error states.
│                 # Import from here only; never re-skin these primitives.
├── styles/       # tokens.css (single source of visual truth),
│                 # base.css (reset/utilities), motion.css (shared keyframes)
├── shell/        # application chrome: TopBar, NavRail, StatusBar, dialogs
├── views/        # one file per navigation destination (Enhance/Batch/History)
├── components/   # workspace pieces: ImageWorkspace, CompareSplit,
│                 # CrossfadeImage, EnhanceControls, ExportDialog
│                 # (+ pre-Stage-02 StatusDot)
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
│   ├── state/            # reducer + context, bootstrap/import/drag-drop hooks,
│   │                     # imageSources cache
│   ├── hooks/            # DOM helpers (useElementSize)
│   ├── ui/               # design system primitives
│   ├── shell/            # desktop chrome (top bar, nav rail, status bar, dialogs,
│   │                     # drop overlay)
│   ├── views/            # Enhance / Batch / History
│   ├── lib/              # pure helpers — display formatting, viewer math
│   ├── styles/           # design tokens + base styles + motion (light/dark)
│   ├── components/       # workspace pieces (ImageWorkspace, CompareSplit, …)
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
