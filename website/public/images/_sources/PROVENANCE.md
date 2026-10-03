# Sample photo provenance

The `before`/`after` images in `website/public/images/` are **genuine Pixora
outputs**, not fabricated screenshots. Each pair was made by the app's own
pipeline, run on a local ONNX Runtime / DirectML GPU:

1. `_sources/<name>.jpg` — the original photograph (a public-domain / CC0
   download from Wikimedia Commons).
2. `<name>-before.jpg` — `_sources/<name>.jpg` resized down with Lanczos3,
   which is the small input handed to Pixora.
3. `<name>-after.jpg` — the result of `service::enhance(..., scale = 4)` on the
   `<name>-before.jpg`, using the bundled Real-ESRGAN model.

Reproduce them with:

```
cargo run --manifest-path src-tauri/Cargo.toml --example website_samples
```

Mode per shot: `coast` = Detail, `face` = Natural, `foliage` = Standard.

## License note — confirm before public launch

These sources were chosen as public-domain / CC0, but each specific file's
license and any attribution must be re-verified against its Wikimedia Commons
page before the site goes live. Do not ship the marketing site until that
check is done for every file in this folder.
