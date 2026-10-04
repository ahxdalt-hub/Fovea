# Fovea

Premium Windows-first desktop app for local AI image enhancement and upscaling.
Your images are processed on your own machine and never uploaded.

**Current status:** Stage 16 — website ↔ product integration. The commercial
journey is connected without moving image processing to the cloud: a
website visitor understands the product, starts checkout, reaches a download

- activation page, and arrives at a working licensed desktop app that runs
  the full workflow locally — import → choose 2×/4× and a real enhancement
  mode → Enhance → compare slider → export PNG/JPEG/WebP — plus batch,
  history, settings, and hardware-adaptive processing that degrades gracefully
  (GPU when available, CPU when not — never a crash). Payment stays behind a
  provider seam (no hard-coded APIs, no secret in the site), the license maps
  straight into the offline activation flow, and every trust claim is backed by
  the real application. Everything still runs on this machine: Real-ESRGAN
  models on ONNX Runtime (DirectML GPU, CPU fallback). Your images are
  processed locally and never uploaded.

## Website ↔ product integration (Stage 16)

The purchase path is wired to the desktop app **without a cloud detour for
image data**. Journey: website → understand → checkout → delivery/download →
install → activate → enhance → export, all verified end-to-end.

- **Payment behind a seam, not an API.** `website/lib/commerce.ts` defines a
  `PaymentProvider` interface and `resolveProvider()` reads
  `FOVEA_PAYMENT_PROVIDER` at request time. The default `ManualProvider`
  needs no secret and no network — it redirects to
  `/download?tier=…&source=checkout`. A real provider plugs in as its own
  file under `lib/providers/`; nothing else changes. No provider assumptions
  are hard-coded.
- **Checkout route.** `website/app/api/checkout/route.ts` (GET + POST)
  validates the tier against `{pro, studio, evaluate}` (anything else →
  400), calls the provider, and issues a 303 redirect. Route is dynamic
  (`ƒ`) so env is read per request.
- **Delivery + activation.** `website/app/download/page.tsx` shows what was
  purchased, the exact in-app activation steps (gear or `Ctrl+,` → Settings →
  License → paste the `FOVEA1.` key → Activate — offline), real system
  requirements, and help. When `FOVEA_DOWNLOAD_URL` is unset it shows an
  honest pre-launch note rather than a broken button.
- **Concise docs.** `website/app/docs/page.tsx` covers install, activation,
  import, enhancement, batch, export, troubleshooting — deliberately short,
  not an enormous manual.
- **No secrets anywhere.** The site never holds a signing key; the desktop
  app embeds only public keys. Purchase tier maps to license edition
  (`pro`→Pro, `studio`→Studio) and into the existing offline Ed25519
  activation from Stage 13.
- **Licensing still never gates the engine.** The integration is a
  commercial record, not a capability switch — no paid feature is fabricated
  for the site.
- **End-to-end proof.** `src-tauri/examples/website_journey.rs` runs the
  whole flow against the real code with **no network**: issue a signed key →
  paste it (whitespace-tolerant) → verify the signature offline → confirm
  every feature stays allowed → enhance a synthetic image locally (DirectML
  GPU or CPU) → export PNG + JPEG. It stops at signature verification rather
  than calling `activate()`, so the test never touches the live Windows
  Credential Manager store.

## Commercial licensing (Stage 13)

An activation architecture that respects the app's core promise — a fully
offline, signed-license model. No payment provider is assumed; the
provider/online-check concern lives behind a trait seam, not the hot path.

```
Purchase → License issued (vendor Ed25519 signature) → Activation
  → Local license state → Feature access
```

- **Signed keys, not a server.** A license is
  `FOVEA1.<base64url(payload)>.<base64url(ed25519-sig)>`. The payload
  carries product, edition (Pro/Studio), holder, id, issued/expiry, and an
  optional machine binding. The desktop app embeds only the **public**
  keys and re-verifies the signature over the exact embedded payload bytes
  on every read — stored data is never trusted for its claims.
- **Keys stay out of the repo.** Production verification keys are injected
  at build time via `FOVEA_LICENSE_PUBKEYS` (comma-separated hex, written
  to `OUT_DIR` by `build.rs`); a development keypair is compiled in **only**
  under `cfg(debug_assertions)`. No secret ever ships inside the app.
  `examples/issue_license.rs` is the vendor-side issuance tool (`--generate`
  a keypair, then sign a key), so real keys are minted off-machine.
- **Secure storage where appropriate.** The signed key text is stored in
  Windows Credential Manager (a generic credential, `fovea/license`) and
  falls back to an atomic `license.key` file when the store isn't
  answering. Non-secret bookkeeping (`license-state.json`) records when the
  key was activated and the highest clock ever seen. The credential path is
  proven by a real round-trip test (`#[ignore]`, run explicitly).
- **Graceful offline + honest revocation.** `LicenseProvider` today is an
  `OfflineProvider` that reports revocation as _unknown_ — "absence of an
  answer must never look like a revocation." Activation, status, and expiry
  all work with no network. A future online check plugs into the same
  trait without touching the engine.
- **Anti-tamper that fails closed, not cranky.** A clock-rollback watermark
  (with a one-hour grace) stops an expired key being revived by winding the
  clock back; a machine-bound key only activates on the same machine
  (machine id = hashed Windows `MachineGuid`, never sent anywhere); a
  damaged local record reports `tampered` and invites a re-paste rather
  than unlocking access.
- **Licensing never gates the local engine.** The feature-access seam
  (`Feature` / `minimum_edition`) exists but returns "all allowed" in this
  build — no paid feature is fabricated. Nothing in import/inference/export
  reads license state, so enhancement cannot be broken by a licensing
  problem.
- **UX.** Settings → License: where the key comes from, a plain textarea to
  paste it, an Activate button that waits for input, and clear success /
  "already active" / human-readable failure copy (no codes, no stack).
  Every state (active, expired, wrong-machine, tampered, revoked,
  clock-suspect, unactivated) says what happened and what to do, and
  repeats the promise that enhancement will not wait on a license check.
- **Error vocabulary.** New user-safe codes: `license_invalid`,
  `license_expired`, `license_revoked`, `license_wrong_machine`,
  `license_clock_suspect`, `license_unsupported_version`,
  `license_store_unavailable` — calm messages at the boundary, detail in
  the log.
- **Verification.** 21 Rust license/store tests cover the scenario matrix
  (valid, invalid/garbage, expired, wrong-machine, tampered/truncated,
  clock-rollback, already-activated idempotency, corrupt bookkeeping,
  store-unavailable, restart round-trip); the ignored credential test
  proves the real Windows path; 190 frontend tests (11 on the license UI +
  boundary guards in `ipc.ts`) pass. clippy `-D warnings`, `cargo fmt`,
  `tsc`, oxlint, and Prettier are all clean.

## Reliability + security (Stage 12)

A production pass over resilience and the trust boundary — no new features,
no arbitrary shell execution, no widened permissions. Findings and fixes:

- **Least-privilege capabilities.** The main window was reduced from
  `core:default` + `log:default` to exactly `core:event:default`. The
  webview needs only the event system (Tauri `Channel` progress streams +
  drag-and-drop listeners); custom app commands live outside the ACL and
  need no grant, verified by running `tauri dev` with the trimmed
  capability and confirming `frontend connected to native core`. No
  filesystem, dialog, shell, window-management, path, menu, or log-plugin
  permission is reachable from the webview — every path and picker is
  still resolved Rust-side.
- **Display-path bomb gate.** `load_image_view` accepted any path the
  webview named and decoded it _before_ checking pixel count, unlike the
  import ladder. A tiny PNG declaring enormous dimensions would allocate
  before refusing. It now runs the same header pixel gate as import
  (`file_too_large` on the declared dimensions, never a blind decode),
  tested with a real crafted-bomb fixture.
- **Disk-full is its own condition.** A full volume during output encode
  previously collapsed into the memory-ladder's `insufficient_resources`
  and wasted two more shrinking retries on a disk problem that cannot be
  fixed by smaller tiles. It now surfaces as `insufficient_disk`, reported
  terminal so the ladder stops immediately. Export and journal writes map
  `StorageFull` through the same error vocabulary.
- **No orphaned live jobs.** Starting a batch cleared the single-image
  panel _before_ the engine accepted the queue; a busy-engine rejection
  then left a running enhancement with every event silently dropped. The
  panel is now parked only after the queue genuinely takes over, and a
  rejected start re-syncs the snapshot instead of repainting stale beliefs.
- **Crash containment.** A root React error boundary turns any render
  exception (previously a blank window) into a recoverable surface; the
  crash text and component stack are relayed to the native log (length-
  capped, control-stripped, never image bytes or paths).
- **Guarded progress streams.** The enhance and batch `Channel` events are
  validated at the boundary (the guards existed but were only tested, never
  wired). A malformed event is dropped and logged rather than reaching the
  reducer, where a string tile-count would have compared lexicographically.
- **Honest loading states.** A failed display-view fetch no longer spins
  "Reading full image…" forever — it reports the failure and keeps the
  preview. A failed 1:1 escalation stays retryable. The batch output guard
  now checks every rendered dimension, and the formatting helpers degrade
  to a dash instead of "NaN" on a bad number.
- **Memory discipline.** The frontend source cache (which can hold
  full-resolution data URLs) is evicted when images leave the collection,
  and re-importing a file invalidates its cached view so changed pixels on
  disk are never hidden behind yesterday's cache.
- **Interrupted batch recovery.** A mid-batch app close (engine slot shut
  down + queue flagged) leaves no phantom in-flight work: the running item
  reports cancelled and nothing claims to still be waiting — tested
  directly against the queue worker.
- **Dependency audit.** Removed the unused `thiserror` crate; the frontend
  tree is already minimal (React + the Tauri API only) and `npm dedupe`
  found no duplicates. ONNX Runtime telemetry is confirmed disabled at
  init; no runtime code path opens a socket (grep-verified: no HTTP client,
  no fetch/WebSocket in the shipped source). The `ort`/`webp` network
  contact is build-time binary download only.
- **Verification:** 120 Rust tests + 2 real end-to-end ONNX/GPU pipeline
  tests pass; 177 frontend tests pass; clippy `-D warnings`, `cargo fmt`,
  `tsc`, oxlint, Prettier, and the production `vite build` are all clean.
  The only stage-12 case not reproduced end-to-end is genuine disk-full
  during inference, which needs a filled volume — its classification and
  terminal-ladder behavior are covered by unit tests instead.

## Premium UX + motion (Stage 11)

A product-quality pass over the whole shell — no new features, no
redesign; every fix makes an existing surface feel finished.

- **Compare chrome is constant on screen.** The before/after slider's
  handle, divider, side tags and pending card used to live inside the
  viewer's zoom transform: at fit zoom the handle rendered ~15 px, at 4×
  it would have ballooned to ~144 px. Every chrome dimension is now
  `calc(Npx × 1/viewScale)`, so the handle is exactly 36 px and tags stay
  legible at any zoom. The handle is fixed light chrome (white circle,
  dark arrows) so it reads over arbitrary image content in either theme.
- **The Enhance strip sits on one axis.** Scale and Mode became inline
  labeled segmented controls (`SegmentedField labelInline`) sharing a
  single center line with the mode hint and the primary action — the old
  stacked layout bottom-aligned the Scale control with the Mode _hint_.
- **Dialogs, menus and notifications exit instead of vanishing.** A short
  fade/settle (140 ms dialogs, 100 ms menus, 150 ms toasts) plays before
  unmount; dismissal now reads as intentional. Toasts pause their clock
  under the pointer and grant a short grace on leave, so a toast never
  disappears while being read. Entry motion was already shared; exit
  motion now speaks the same language.
- **The image stage got its own tone** (`--bg-canvas`): a shade deeper
  than the app surface in both themes, so the workspace reads as the
  image's place — barely distinguishable in light mode before.
- **Smaller fixes:** dialog initial focus lands on the panel (never one
  accidental Enter from the close button), the workspace menu/zoom
  readout/thumb hovers got consistent depth, the engine warning carries
  an icon, and tests now encode the animated exits.

## GPU + CPU optimization (Stage 07)

```
services/hardware.rs — detection, once per process, zero personal data:
  CPU brand/cores (public registry value), RAM total/free
  (GlobalMemoryStatusEx), every DXGI adapter with a real
  D3D12CreateDevice(12_0) probe — "can DirectML run here" answered by
  the API itself, not guessed
        ↓
memory_budgets(): the tile buffer and the streaming band buffer are
  capped at conservative quarters of the applicable pool (VRAM on the
  GPU path, free RAM on the CPU path), floored so a 64 px tile always
  fits and clamped so no machine gets over-reached
        ↓
engine::adaptive_tile(): the largest tile ≤ 256 whose runtime output
  and per-band composite fit those budgets; wide panoramas shrink via
  the band term, tiny-VRAM machines via the tile term
        ↓
service ladder (every job):
  PreferGpu → any GPU failure (session build, device removed, OOM
  mid-run) → retry on CpuOnly → still OOM → halve the tile ceiling →
  still OOM at the 64 px floor → honest `insufficient_resources`
  Each attempt announces itself with a `device` event — the UI chip and
  the completion message follow the truth, including a mid-job switch.
  Oversized masters (256 MP output) build their compare-view
  representation from a box-downsample tee *during* the streaming
  encode — the giant file is never re-decoded (peak RSS stayed ≈ 380 MB).
```

- **Measured benchmarks** (`examples/stage07_bench.rs`, release build,
  RTX 3050 Laptop 6 GB + Ryzen 5 5600, 4× Standard, end-to-end: decode →
  session → tiles → encode → commit):

  | fixture | source    | engine       | tile | time   | output MP/s | peak RSS |
  | ------- | --------- | ------------ | ---- | ------ | ----------- | -------- |
  | small   | 512×384   | DirectML GPU | 256  | 1.0 s  | 3.0         | 301 MB   |
  | typical | 1920×1440 | DirectML GPU | 256  | 5.6 s  | 7.8         | 331 MB   |
  | hi-res  | 4032×3024 | DirectML GPU | 256  | 19.8 s | 9.8         | 362 MB   |
  | large   | 5300×3000 | DirectML GPU | 256  | 23.3 s | 10.9        | 385 MB   |
  | small   | 512×384   | CPU (forced) | 256  | 1.8 s  | 1.8         | 178 MB   |
  | typical | 1920×1440 | CPU (forced) | 256  | 22.8 s | 1.9         | 214 MB   |
  | hires   | 4032×3024 | DirectML GPU | 64   | 49.9 s | 3.9         | 319 MB   |

  The last row reproduces low-VRAM conditions for real
  (`FOVEA_BUDGET_MB=16`): the adaptive planner drops to 64 px tiles and
  the job completes ~2.5× slower — degraded, never broken.

- **The honest cap moved to the output:** `MAX_ENHANCE_OUTPUT_PIXELS` =
  256 MP (16 MP in at 4×, 64 MP in at 2×). Sources above it refuse with
  `file_too_large` before any work.
- **Memory is bounded at every stage:** tiles sized from the budget,
  band allocation via `try_reserve` (allocation failure = a recoverable
  `out-of-memory`, not an abort), alpha re-attached at source resolution,
  per-band buffers dropped as the PNG streams to disk, the session drops
  with the job. CPU sessions cap intra-op threads at the physical core
  count so the UI stays responsive during a long pass.
- **Never a crash for a device reason:** session-load DML→CPU fallback
  (Stage 05) plus the runtime ladder plus `panic = "unwind"` on release
  — a panicking inference task now surfaces as an error to the UI
  instead of taking the app down.
- **Detection doors for QA (dev env vars, same family as
  `FOVEA_MODELS_DIR`):** `FOVEA_FORCE_CPU=1` runs the CPU path on a GPU
  machine (reproducible "unsupported GPU"), `FOVEA_TILE` pins the tile
  ceiling, `FOVEA_BUDGET_MB` squeezes the budgets (reproducible
  low-VRAM). Production defaults are the detected budgets.
- **UX:** the status bar keeps its one-word device readout (GPU / CPU);
  the job panel adds a small pill following the engine's own `device`
  events, including a mid-job downgrade; full hardware/strategy detail
  lives in Settings → Processing (a `get_diagnostics` snapshot — Task
  Manager class facts, no personal data).

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
- **Motion:** entries use the `fovea-*` keyframes from `motion.css` with
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

"# Fovea"
"# Fovea"
