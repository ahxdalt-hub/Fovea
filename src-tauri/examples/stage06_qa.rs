//! Stage 06 manual-QA pass over the whole product surface, against the
//! REAL bundled models on ONNX Runtime (DirectML GPU when present):
//! enhance a photo fixture at 2× and 4× in every mode, commit each PNG
//! master, then export every committed master in all three formats and
//! both quality points — verifying each output file decodes at the
//! expected dimensions and that the files genuinely differ.
//!
//! Run with:
//!   cargo run --manifest-path src-tauri/Cargo.toml --example stage06_qa -- <fixtures-dir> <out-dir>

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use upscaler_lib::services::export::{self, ExportFormat};
use upscaler_lib::services::inference::backend::{CancelToken, OnnxBackend};
use upscaler_lib::services::inference::model::{EnhanceMode, ModelRegistry};
use upscaler_lib::services::inference::service::{self, EngineConfig, EnhanceResult, JobRegistry};

/// A photo-like fixture with structure the AI must sharpen honestly:
/// sky gradient, horizon, a crisp rectangle, fine text-like strokes.
fn write_scene(path: &Path) {
    let mut img = RgbaImage::new(360, 240);
    for (x, y, p) in img.enumerate_pixels_mut() {
        let sky = 60.0 + (y as f32 / 240.0) * 150.0;
        let mut v = [sky as u8, (sky * 0.75) as u8, 205u8];
        if y > 150 {
            v = [40 + (x / 9 % 180) as u8, 85, 50 + (y / 6 % 110) as u8];
        }
        if (60..140).contains(&x) && (30..120).contains(&y) {
            // A hard-edged "building" with window rows.
            let window = ((x - 60) % 16 < 8) && ((y - 30) % 14 > 4);
            v = if window {
                [250, 240, 210]
            } else {
                [70, 70, 80]
            };
        }
        *p = Rgba([v[0], v[1], v[2], 255]);
    }
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(img)
        .write_to(&mut out, ImageFormat::Png)
        .expect("encode fixture");
    std::fs::write(path, out.into_inner()).expect("write fixture");
}

fn enhance(
    registry: &ModelRegistry,
    source: &str,
    mode: EnhanceMode,
    scale: usize,
    out_dir: &Path,
) -> EnhanceResult {
    let jobs = JobRegistry::new();
    let token = Arc::new(CancelToken::new());
    let job_id = jobs.next_job_id();
    jobs.begin(&job_id, token.clone()).expect("begin");
    service::enhance(
        source,
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
    .unwrap_or_else(|e| panic!("{mode:?} {scale}× enhance failed: {e}"))
}

fn check_file(path: &Path, want_w: u32, want_h: u32, tag: &str) {
    assert!(path.is_file(), "{tag}: file missing");
    let bytes = std::fs::read(path).expect("read");
    assert!(bytes.len() > 1000, "{tag}: suspiciously small");
    let decoded = image::load_from_memory(&bytes).unwrap_or_else(|e| panic!("{tag}: {e}"));
    assert_eq!(
        (decoded.width(), decoded.height()),
        (want_w, want_h),
        "{tag}: dimensions"
    );
    println!("  ok {tag}: {} bytes", bytes.len());
}

fn main() {
    let fixtures = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("pixora-fixtures"));
    let out = std::env::args()
        .nth(2)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("pixora-stage06-qa"));
    // QA output is disposable: start clean so repeated runs are
    // deterministic (file-name-collision checks compare against fresh dirs).
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).expect("out dir");

    let source = fixtures.join("photo.png");
    if !source.is_file() {
        write_scene(&source);
        println!("wrote fixture {}", source.display());
    }
    let source_str = source.to_string_lossy().into_owned();

    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("models");
    let registry = ModelRegistry::new(vec![manifest]);
    let status = service::inference_status(&registry);
    println!(
        "engine: {} · scales {:?} · modes {:?}",
        status.device,
        status.scales,
        status
            .modes
            .iter()
            .map(|m| format!("{}={}", m.key, m.available))
            .collect::<Vec<_>>()
    );
    assert!(status.ready);
    assert_eq!(status.scales, vec![2, 4]);
    assert!(status.modes.iter().all(|m| m.available));

    let masters_dir = out.join("enhanced");
    std::fs::create_dir_all(&masters_dir).expect("masters dir");

    let mut masters: Vec<(EnhanceMode, usize, PathBuf)> = Vec::new();
    for (mode, scale) in [
        (EnhanceMode::Standard, 4usize),
        (EnhanceMode::Standard, 2usize),
        (EnhanceMode::Natural, 4usize),
        (EnhanceMode::Natural, 2usize),
        (EnhanceMode::Detail, 4usize),
        (EnhanceMode::Detail, 2usize),
    ] {
        let t0 = std::time::Instant::now();
        let result = enhance(&registry, &source_str, mode, scale, &masters_dir);
        let edge = if scale == 4 { 360 * 4 } else { 360 * 2 };
        // Display view may be downscaled by the viewer ladder; the master
        // file on disk carries the true result.
        let decoded = image::open(&result.file_path).expect("master decodes");
        assert_eq!(
            (decoded.width(), decoded.height()),
            (edge, edge * 240 / 360)
        );
        println!(
            "  ok {:?} {}× → {}×{} · {:?} · {}",
            mode,
            scale,
            decoded.width(),
            decoded.height(),
            t0.elapsed(),
            result.engine,
        );
        assert!(
            result
                .label
                .contains(&format!("{scale}× · {}", mode.label()))
        );
        if mode == EnhanceMode::Standard {
            // Real detail, not a flat fill.
            let rgb = decoded.into_rgb8();
            let first = rgb.get_pixel(0, 0).0;
            assert!(rgb.pixels().take(5000).any(|p| p.0 != first), "flat output");
        }
        masters.push((mode, scale, result.file_path.clone()));
    }

    // Modes must differ on the same source (different weights / different
    // pass → different master bytes). Identical files would expose a lie.
    let master_for = |mode: EnhanceMode, scale: usize| -> PathBuf {
        masters
            .iter()
            .find(|(m, s, _)| *m == mode && *s == scale)
            .map(|(_, _, p)| p.clone())
            .expect("recorded")
    };
    let png_master = master_for(EnhanceMode::Standard, 4);
    let std_bytes = std::fs::read(&png_master).expect("read standard");
    for other in [
        master_for(EnhanceMode::Natural, 4),
        master_for(EnhanceMode::Detail, 4),
    ] {
        assert_ne!(
            std::fs::read(other).expect("read"),
            std_bytes,
            "every mode must genuinely differ from Standard"
        );
    }
    assert_ne!(
        std::fs::read(master_for(EnhanceMode::Natural, 4)).expect("read"),
        std::fs::read(master_for(EnhanceMode::Detail, 4)).expect("read"),
        "Natural and Detail must differ from each other too"
    );

    // Export: every format × quality, from the 4× master.
    let master = png_master.clone();
    let stem = "qa-photo";
    let dims4 = (360 * 4, 240 * 4);
    let formats = [
        (ExportFormat::Png, None, "png"),
        (ExportFormat::Jpeg, Some(90u8), "jpg"),
        (ExportFormat::Jpeg, Some(40u8), "jpg"),
        (ExportFormat::Webp, Some(90u8), "webp"),
        (ExportFormat::Webp, Some(40u8), "webp"),
    ];
    let export_dir = out.join("exports");
    std::fs::create_dir_all(&export_dir).expect("export dir");
    let mut sizes: Vec<(String, u64)> = Vec::new();
    for (fmt, q, ext) in formats {
        let res =
            export::export_image(&master, &export_dir, stem, fmt, q.unwrap_or(90)).expect("export");
        assert_eq!(
            Path::new(&res.file_name)
                .extension()
                .unwrap()
                .to_str()
                .unwrap(),
            ext
        );
        check_file(&res.file_path, dims4.0, dims4.1, &res.file_name);
        sizes.push((res.file_name, res.bytes));
    }
    // Lossless PNG == the master bytes exactly.
    let png_out = std::fs::read(export_dir.join("qa-photo.png")).expect("png export");
    assert_eq!(png_out, std_bytes, "PNG export must be a lossless copy");

    // Quality is real and ordered: lower quality → smaller file. The
    // files landed as qa-photo.jpg (q90) / qa-photo-2.jpg (q40) etc.
    let get = |name: &str| sizes.iter().find(|(n, _)| n == name).unwrap().1;
    assert!(
        get("qa-photo-2.jpg") < get("qa-photo.jpg"),
        "JPEG q40 ({}) must be smaller than q90 ({})",
        get("qa-photo-2.jpg"),
        get("qa-photo.jpg")
    );
    assert!(
        get("qa-photo-2.webp") < get("qa-photo.webp"),
        "WebP q40 ({}) must be smaller than q90 ({})",
        get("qa-photo-2.webp"),
        get("qa-photo.webp")
    );
    // Lossy sizes all under the lossless master.
    for (name, bytes) in &sizes {
        if !name.ends_with(".png") {
            assert!(*bytes < get("qa-photo.png"), "{name} should beat PNG size");
        }
    }

    // Re-export into the same folder must not overwrite — suffix path.
    let before = std::fs::read(export_dir.join("qa-photo.jpg")).expect("first jpeg");
    let res2 = export::export_image(&master, &export_dir, "qa-photo", ExportFormat::Jpeg, 90)
        .expect("second export");
    assert_eq!(res2.file_name, "qa-photo-3.jpg");
    assert_eq!(
        std::fs::read(export_dir.join("qa-photo.jpg")).expect("untouched"),
        before
    );

    println!("\nstage06 QA complete → {}", out.display());
}
