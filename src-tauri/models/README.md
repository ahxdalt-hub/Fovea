# Pixora models

Self-contained ONNX models the local AI engine (`services/inference`) can
find, validate, and run. This directory is bundled into the installer as
the app's `models/` resource folder (see `tauri.conf.json` →
`bundle.resources`).

## realesr-general-x4v3.onnx

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

## License obligations met

- BSD-3-Clause permits commercial redistribution of the model weights in
  binary form provided the copyright notice and disclaimers accompany the
  distribution → the upstream `LICENSE` ships beside the `.onnx`.
- ONNX Runtime binaries fetched by the `ort` build script are MIT-licensed
  by Microsoft; the runtime's ETW telemetry is explicitly disabled at
  init (`backend.rs`).

## Adding a model later

1. Drop the `.onnx` here.
2. Add a `ModelSpec` to `MODELS` in `services/inference/model.rs` (file
   name, exact size, SHA-256, scale, label).
3. Keep the model's license file next to it and note the obligations.

No other code changes: search, validation, and status surfaces all read
from the registry.
