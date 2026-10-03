//! Generates Pixora's marketing before/after samples using the REAL
//! enhancement pipeline — the same `service::enhance` the app runs, against
//! the bundled ONNX models (DirectML GPU when present). There is no
//! fabrication: the "after" images are genuine Pixora output, the "before"
//! images are genuinely small, so the website only shows what the product
//! actually produces.
//!
//! Usage:
//!   cargo run --manifest-path src-tauri/Cargo.toml --example website_samples \
//!     -- <sources-dir> <out-dir>
//!
//! <sources-dir> holds source photographs; <out-dir> receives
//!   <name>-before.jpg  (small, what a user starts with)
//!   <name>-after.jpg   (Pixora 4× enhancement of that same small image)

use std::path::{Path, PathBuf};
use std::sync::Arc;

use image::imageops::FilterType;
use image::DynamicImage;
use upscaler_lib::services::inference::backend::{CancelToken, OnnxBackend};
use upscaler_lib::services::inference::model::{EnhanceMode, ModelRegistry};
use upscaler_lib::services::inference::service::{self, EngineConfig, JobRegistry};

/// (source stem, the enhancement behaviour that flatters it, target small width)
const SHOTS: &[(&str, EnhanceMode, u32)] = &[
    ("coast", EnhanceMode::Detail, 360),
    ("face", EnhanceMode::Natural, 420),
    ("foliage", EnhanceMode::Standard, 360),
];

fn main() {
    let mut args = std::env::args().skip(1);
    let sources = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("need <sources-dir>"));
    let out = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("need <out-dir>"));
    std::fs::create_dir_all(&out).expect("out dir");

    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("models");
    let registry = ModelRegistry::new(vec![manifest]);
    let status = service::inference_status(&registry);
    println!("engine device: {} · ready: {}", status.device, status.ready);
    assert!(status.ready, "no usable model on this machine");

    for &(stem, mode, small_w) in SHOTS {
        let src_path = sources.join(format!("{stem}.jpg"));
        if !src_path.is_file() {
            println!("  skip {stem}: {src_path:?} missing");
            continue;
        }
        let full = image::open(&src_path).unwrap_or_else(|e| panic!("{stem}: decode {e}"));

        // "before": the same photo, deliberately small — a file a real
        // person might actually own. Aspect ratio is preserved (not squashed).
        let (fw, fh) = (full.width(), full.height());
        let small_h = (small_w as f64 * fh as f64 / fw as f64).round() as u32;
        let small = full.resize_exact(small_w, small_h, FilterType::Lanczos3);
        let before_path = out.join(format!("{stem}-before.jpg"));
        save_jpeg(&small, &before_path, 82);

        // "after": Pixora runs on that small image and returns a true 4×
        // result (detail reconstructed by the model, not stretched pixels).
        let work = std::env::temp_dir().join(format!("pixora-sample-{stem}"));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).expect("work dir");
        let master = enhance(&registry, &before_path, mode, 4, &work);
        let after = image::open(&master).unwrap_or_else(|e| panic!("{stem}: master {e}"));
        let after_path = out.join(format!("{stem}-after.jpg"));
        save_jpeg(&after, &after_path, 90);

        println!(
          "  {stem}: {small_w}px {mode:?} → {}×{} · {}",
          after.width(),
          after.height(),
          status.device
        );
    }
    println!("done → {}", out.display());
}

fn enhance(
    registry: &ModelRegistry,
    source: &Path,
    mode: EnhanceMode,
    scale: usize,
    out_dir: &Path,
) -> PathBuf {
    let jobs = JobRegistry::new();
    let token = Arc::new(CancelToken::new());
    let job_id = jobs.next_job_id();
    jobs.begin(&job_id, token.clone()).expect("begin");
    let source_str = source.to_string_lossy().into_owned();
    let result = service::enhance(
        &source_str,
        mode,
        scale,
        registry,
        &EngineConfig::default(),
        out_dir,
        &jobs,
        &job_id,
        &token,
        |_| {},
        OnnxBackend::load_with,
    )
    .unwrap_or_else(|e| panic!("{mode:?} {scale}× enhance failed: {e}"));
    result.file_path
}

fn save_jpeg(img: &DynamicImage, path: &Path, quality: u8) {
    let mut buf = std::io::Cursor::new(Vec::new());
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    img.to_rgb8()
        .write_with_encoder(enc)
        .unwrap_or_else(|e| panic!("jpeg encode {path:?}: {e}"));
    std::fs::write(path, buf.into_inner()).expect("write image");
}
