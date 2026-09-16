# Pixora models

Self-contained ONNX models the local AI engine (`services/inference`) can
find, validate, and run. This directory is bundled into the installer as
the app's `models/` resource folder (see `tauri.conf.json` →
`bundle.resources`).

## realesr-general-x4v3.onnx — mode "Standard"

- **What it is:** Real-ESRGAN's general-purpose 4× upscaler
  (`realesr-general-x4v3` variant), exported to ONNX.
- **Upstream:** xinntao/Real-ESRGAN (Tencent ARC Lab), BSD-3-Clause.
- **Source file:** HuggingFace `Heliosoph/realesrgan-onnx` (a re-host of
  the upstream release, licensed BSD-3-Clause with the upstream `LICENSE`
  reproduced as `realesrgan-BSD-3-Clause.txt` and redistributed here).
- **SHA-256:** `09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4`
  (4,871,181 bytes) — pinned in `src-tauri/src/services/inference/model.rs`
  and verified before every load.
- **Runtime:** input `[1,3,H,W]` float32 RGB in [0,1], dynamic sizes;
  output `[1,3,4H,4W]`. Pixora tiles large images (see
  `services/inference/engine.rs`).

## realesr-general-wdn-x4v3.onnx — mode "Natural"

- **What it is:** Real-ESRGAN's WDN (wavelet denoising) variant of the
  same architecture — genuinely different trained weights that suppress
  noise and compression artifacts and keep the photo's character, instead
  of reconstructing detail. Upstream ships it to be _blended_ with the
  general model; Pixora exposes the two pure behaviors as modes rather
  than inventing a blend knob the pipeline doesn't run.
- **Upstream:** xinntao/Real-ESRGAN (Tencent ARC Lab), BSD-3-Clause —
  same license file as above.
- **Source file:** `realesr-general-wdn-x4v3.pth` (upstream release,
  mirrored at HuggingFace `Lachter0808/realesr`), exported to ONNX with
  the upstream architecture definition (`SRVGGNetCompact`, num_feat=64,
  num_conv=31, pixel-shuffle 4× + nearest skip). Export parity against
  the torch weights was verified at 1.4e-05 max error.
- **SHA-256:** `7132e99f7bc09342e31cfee9276cb4c77b6d94d0ed2acc2c9586398b334d4792`
  (4,866,499 bytes) — pinned in `model.rs`, verified before every load.
- **Runtime:** identical I/O contract to the Standard model, so the tiling
  pipeline, the 2× resample path, and the compare-view ladder all apply.

## License obligations met

- BSD-3-Clause permits commercial redistribution of the model weights in
  binary form provided the copyright notice and disclaimers accompany the
  distribution → the upstream `LICENSE` ships beside both `.onnx` files.
- ONNX Runtime binaries fetched by the `ort` build script are MIT-licensed
  by Microsoft; the runtime's ETW telemetry is explicitly disabled at
  init (`backend.rs`).
- `libwebp` (vendored C, compiled into the app by the `webp` crate's
  build script) is BSD-3-Clause by Google; it is a build-time dependency
  with zero runtime network use.

## Adding a model later

1. Drop the `.onnx` here.
2. Add a `ModelSpec` to `MODELS` in `services/inference/model.rs` (file
   name, exact size, SHA-256, scale, label, mode).
3. Keep the model's license file next to it and note the obligations.

No other code changes: search, validation, status surfaces, and the
mode/scale controls all read from the registry.
