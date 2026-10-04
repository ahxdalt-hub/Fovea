# Fovea v1.0.0 — Production Release (Stage 18)

Released: 2026-10-04 · Feature work is closed for v1. This document is the
release record: what was built, where the artifacts are, how to reproduce
the build, and the exact launch steps left to the vendor.

## Version

v1.0.0, set consistently in:

- `package.json` (root app)
- `src-tauri/Cargo.toml` + `Cargo.lock`
- `src-tauri/tauri.conf.json` (`version`, embedded in the installer and the
  in-app About/diagnostics view via `config.rs`)
- `website/package.json`

## Release artifacts

| Artifact | Location |
| --- | --- |
| Windows installer (NSIS, primary) | `src-tauri/target/release/bundle/nsis/Fovea_1.0.0_x64-setup.exe` |
| Windows installer (MSI, enterprise) | `src-tauri/target/release/bundle/msi/Fovea_1.0.0_x64_en-US.msi` |
| Release binary | `src-tauri/target/release/local-ai-image-upscaler.exe` |
| Website production build | `website/.next` (Next.js static + 2 dynamic routes) |
| Cloudflare Workers package | `website/.open-next` (`npm run build:cf` → `deploy:cf`) |
| License configuration | vendor keypair — see below |

Bundled runtime assets (verified inside the installer): Real-ESRGAN models
`realesr-general-x4v3.onnx` + `realesr-general-wdn-x4v3.onnx` (~9.5 MB,
BSD-3-Clause license text included), ONNX Runtime with DirectML statically
linked into the binary (DirectML itself loads from the Windows system
runtime — no loose DLLs needed). Application icon: `src-tauri/icons/icon.ico`
generated from `assets/app-icon.svg`, embedded in the exe, installer and
shortcuts.

## How to reproduce the release build

```sh
npm ci
cargo test --manifest-path src-tauri/Cargo.toml   # 143 tests
npm test                                          # 190 tests
npm run lint && npm run typecheck
FOVEA_LICENSE_PUBKEYS=6db036b448370816e55ef8f1682ab4e0371e0094c48e810c8a7e7e2a9764e7ee \
  npm run tauri build
```

The public key env var is mandatory for a distributable build: since Stage
17 `build.rs` panics on a release build with no verifier key (a keyless
release could never activate anyone). The private seed is stored outside the
repository at `~/fovea-vendor/fovea-license-private.hex` with vendor
instructions; guard and back it up — losing it means no future key can be
issued.

Issue a customer key:

```sh
cargo run --manifest-path src-tauri/Cargo.toml --example issue_license -- \
  --seed <private-seed-hex> --holder "buyer@email" --edition pro --id PL-2026-000001
```

Keys are `FOVEA1.<base64url(payload)>.<base64url(signature)>`, verified
fully offline; Pro = 1 machine, Studio = up to 5 with per-machine binding,
optionally dated via `--expires`.

## Development/debug behavior excluded from release

- `useDevDemoImages`, `useDevPreviewParams`, `previewBridge` are gated on
  `import.meta.env.DEV` — Vite replaces it with `false` in the production
  bundle (dead-code eliminated).
- Dev license key pair is `#[cfg(debug_assertions)]` only; the release
  binary cannot accept dev-issued keys (verified: installed release app
  starts `debug=false` and activates a production-signed key).
- `windows_subsystem` hides the console, no `devtools` feature on the tauri
  dependency; CSP is strict (`'self'` only); capabilities are
  least-privilege (`src-tauri/capabilities/default.json`).

## Test status at release

- 190 JS tests (18 files) — pass
- 143 Rust tests (3 ignored, machine-bound) — pass
- `cargo clippy -D warnings` + `cargo fmt --check` — clean
- `oxlint` + `prettier --check` — clean (app, website, and root both)
- `tsc -b` and website `tsc --noEmit` — clean
- Clean-machine install test: dev data moved aside, NSIS 1.0.0 installed
  silently, exe metadata reports Fovea 1.0.0, models + BSD license present
  in the install tree, app launches, registers fresh config, detects GPU
  (RTX 3050, DirectML) and connects the frontend — pass
- Offline end-to-end journey (checkout → issue → deliver → activate →
  import → enhance → compare inputs → export PNG/JPEG, engine checks) —
  `cargo run --example website_journey` (debug build, dev pair) — pass

## Public claims audit

Every marketing statement was re-verified against the code: JPEG/PNG/WebP
import + export (lossless PNG, quality control JPEG/WebP, WebP's hard
16383 px ceiling refused with a clear message), true 2× and 4×
(`product_scales_for` — factors only genuinely delivered by the bundled
models), three real modes (Standard/Natural/Detail), DirectML on any DX12
GPU with automatic CPU fallback (never a crash), zero network I/O in the
desktop app (no HTTP client in the dependency tree; CSP allows only
self/IPC), offline activation, logs never contain image paths. Website
metadata points at the live origin `https://fovea.caelmont.in` (canonical
`site.url`, OG, sitemap, robots). No unsupported claims found.

## Launch steps left to the vendor (deliberately not automated)

1. Upload `Fovea_1.0.0_x64-setup.exe` to hosting (e.g. a Cloudflare R2
   bucket) and set `FOVEA_DOWNLOAD_URL` / `FOVEA_DOWNLOAD_VERSION=1.0.0` /
   `FOVEA_DOWNLOAD_SIZE` on the deployed site. Until then the /download
   page honestly shows "not published yet" — by design, not a defect.
2. Connect a payment provider (Razorpay/Stripe adapter in
   `website/lib/providers/`) when the account is ready; the manual provider
   is the honest pre-provider flow.
3. `npm run deploy:cf` after the OpenNext build to push this release live.

## Known limitations (v1 scope, accepted)

- Windows only; no macOS/Linux build in v1.
- Installer is not Authenticode-signed (SmartScreen "unknown publisher"
  warning on first run; signing is a paid-certificate decision left to the
  vendor).
- Support entry point is "reply to your receipt" — no public support email
  is advertised because none is provisioned yet.
- WebP export is capped by the format at 16383 px per edge (named error,
  use PNG); very large images tile and take time proportional to pixels.
- License gates nothing: an unlicensed copy is fully functional (commercial
  record, not DRM) — accepted trade-off documented in Stage 13.
- Screenshots cannot be captured in this QA environment (browser-use has no
  visual surface); web UI verification was done via DOM/computed-style
  probes and console inspection.
