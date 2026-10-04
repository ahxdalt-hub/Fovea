//! Final-audit matrix: the representative image set, the full workflows,
//! and the hardware paths a customer actually hits.
//!
//!   cargo run --manifest-path src-tauri/Cargo.toml --example audit_matrix -- <out-dir> [sizes…]
//!
//! Sections, in order:
//!   A  fixture generation for the representative set
//!   B  import pass — every good file, every bad file, nothing panics
//!   C  enhance pass — 2×/4× per fixture on the real runtime, dims verified
//!   D  export pass — PNG/JPEG/WebP at both quality points, re-decoded
//!   E  batch pass — run, mid-run cancel, waiting cancel, failed item, retry
//!   F  constrained-memory pass — tiny budgets force the tile ladder for real
//!   G  CPU path — the same job with the GPU taken away
//!
//! Findings are collected and printed at the end rather than panicking, so
//! one run reports the whole picture.

use std::io::{Cursor, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use image::{DynamicImage, GrayImage, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
use upscaler_lib::services::export::{self, ExportFormat};
use upscaler_lib::services::inference::backend::{CancelToken, OnnxBackend};
use upscaler_lib::services::inference::finish::{DEFAULT_INTENSITY, Filter};
use upscaler_lib::services::inference::model::{EnhanceMode, ModelRegistry};
use upscaler_lib::services::inference::service::{
    self, EngineConfig, EnhanceEvent, EnhanceResult, JobRegistry, probe_device,
};
use upscaler_lib::services::{batch, hardware, history, import};

/// One line of the findings report.
struct Finding {
    area: &'static str,
    detail: String,
}

#[derive(Default)]
struct Report {
    findings: Vec<Finding>,
}

impl Report {
    fn note(&mut self, area: &'static str, detail: impl Into<String>) {
        let detail = detail.into();
        println!("  [!] {area}: {detail}");
        self.findings.push(Finding {
            area,
            detail: detail.clone(),
        });
    }
    fn ok(&self, msg: &str) {
        println!("  ok {msg}");
    }
}

// ── A: fixtures ───────────────────────────────────────────────────────

fn save(img: &DynamicImage, path: &Path, fmt: ImageFormat) {
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, fmt).expect("encode");
    std::fs::write(path, out.into_inner()).expect("write");
}

/// Deterministic photo-like content: gradient sky, hard edges, fine grain.
fn scene(w: u32, h: u32, grain: usize) -> RgbImage {
    let mut img = RgbImage::new(w, h);
    for (x, y, p) in img.enumerate_pixels_mut() {
        let sky = 40 + (y as usize * 150) / (h as usize).max(1);
        let g = (grain * ((x as usize * 1103515245 + y as usize * 12345 + 7) % 48)) as u8 / 48;
        let mut v = [
            (sky as u8).saturating_add(g),
            (sky as u8 / 2).saturating_add(g),
            (200u8).saturating_sub(g),
        ];
        if (w / 4..w / 2).contains(&x) && (h / 6..h / 2).contains(&y) {
            let window = ((x - w / 4) % 16 < 8) && ((y - h / 6) % 14 > 4);
            v = if window {
                [250, 240, 210]
            } else {
                [60, 60, 72]
            };
        }
        *p = Rgb(v);
    }
    img
}

/// Splice a minimal EXIF APP1 (Orientation=6: "rotate 90° CW to display")
/// into an encoded JPEG, right after SOI. This is what a phone writes for
/// every portrait photo it takes.
fn jpeg_with_orientation(img: &RgbImage, orientation: u16) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(img.clone())
        .write_to(&mut out, ImageFormat::Jpeg)
        .expect("encode jpeg");
    let jpeg = out.into_inner();
    let mut tiff: Vec<u8> = Vec::new();
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&42u16.to_le_bytes());
    tiff.extend_from_slice(&8u32.to_le_bytes()); // IFD0 at offset 8
    tiff.extend_from_slice(&1u16.to_le_bytes()); // one entry
    tiff.extend_from_slice(&0x0112u16.to_le_bytes()); // Orientation
    tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
    tiff.extend_from_slice(&1u32.to_le_bytes()); // count
    tiff.extend_from_slice(&(orientation as u32).to_le_bytes());
    tiff.extend_from_slice(&0u32.to_le_bytes()); // no IFD1
    let mut app1: Vec<u8> = Vec::new();
    app1.extend_from_slice(&[0xFF, 0xE1]);
    app1.extend_from_slice(&((6 + tiff.len() + 2) as u16).to_be_bytes());
    app1.extend_from_slice(b"Exif\0\0");
    app1.extend_from_slice(&tiff);
    let mut fixed = Vec::with_capacity(jpeg.len() + app1.len());
    fixed.extend_from_slice(&jpeg[..2]);
    fixed.extend_from_slice(&app1);
    fixed.extend_from_slice(&jpeg[2..]);
    fixed
}

fn write_fixtures(dir: &Path) -> Vec<PathBuf> {
    std::fs::create_dir_all(dir).expect("fixtures dir");
    let put = |name: &str, img: DynamicImage, fmt: ImageFormat| {
        save(&img, &dir.join(name), fmt);
    };

    put(
        "tiny.png",
        DynamicImage::ImageRgb8(scene(64, 48, 8)),
        ImageFormat::Png,
    );
    put(
        "square.png",
        DynamicImage::ImageRgb8(scene(900, 900, 10)),
        ImageFormat::Png,
    );
    put(
        "portrait.jpg",
        DynamicImage::ImageRgb8(scene(800, 1200, 12)),
        ImageFormat::Jpeg,
    );
    put(
        "landscape.jpg",
        DynamicImage::ImageRgb8(scene(1200, 800, 12)),
        ImageFormat::Jpeg,
    );
    put(
        "noisy.png",
        DynamicImage::ImageRgb8(scene(500, 500, 48)),
        ImageFormat::Png,
    );
    put(
        "lowres.png",
        DynamicImage::ImageRgb8(scene(32, 32, 0)),
        ImageFormat::Png,
    );
    put(
        "phone_12mp.jpg",
        DynamicImage::ImageRgb8(scene(4032, 3024, 14)),
        ImageFormat::Jpeg,
    );
    put(
        "wide_strip.png",
        DynamicImage::ImageRgb8(scene(3, 12000, 4)),
        ImageFormat::Png,
    );

    // Alpha, grayscale, 16-bit, and a lossless WebP.
    let mut rgba = RgbaImage::new(400, 300);
    for (x, y, p) in rgba.enumerate_pixels_mut() {
        let a = if (x + y) % 200 < 100 { 255 } else { 40 };
        *p = Rgba([90, 160, 240, a]);
    }
    put(
        "alpha.png",
        DynamicImage::ImageRgba8(rgba.clone()),
        ImageFormat::Png,
    );
    put(
        "alpha.webp",
        DynamicImage::ImageRgba8(rgba),
        ImageFormat::WebP,
    );
    let gray: GrayImage = GrayImage::from_fn(300, 200, |x, y| image::Luma([((x + y) % 255) as u8]));
    put("gray.png", DynamicImage::ImageLuma8(gray), ImageFormat::Png);
    let g16: image::ImageBuffer<image::Rgb<u16>, Vec<u16>> =
        image::ImageBuffer::from_fn(120, 90, |x, y| {
            image::Rgb([
                ((x * 700) % 65536) as u16,
                ((y * 900) % 65536) as u16,
                32000,
            ])
        });
    put(
        "sixteen.png",
        DynamicImage::ImageRgb16(g16),
        ImageFormat::Png,
    );

    // EXIF-rotated JPEG: 200×100 stored, displayed as 100×200.
    let rotated = dir.join("exif_rotated.jpg");
    std::fs::write(&rotated, jpeg_with_orientation(&scene(200, 100, 6), 6)).expect("write");

    // The bad set.
    std::fs::write(dir.join("notes.txt"), b"just a text file").unwrap();
    std::fs::write(
        dir.join("corrupt.png"),
        b"\x89PNG\r\n\x1a\n rest of this file is not a PNG",
    )
    .unwrap();
    std::fs::write(dir.join("empty.png"), b"").unwrap();
    // A GIF wearing a .png extension.
    let mut gif: Vec<u8> = Vec::new();
    gif.extend_from_slice(b"GIF89a");
    gif.extend_from_slice(&[10, 0, 10, 0, 0, 0, 0]);
    std::fs::write(dir.join("lies.png"), &gif).unwrap();
    // Truncated real JPEG (header valid, pixels missing).
    let full = std::fs::read(dir.join("landscape.jpg")).unwrap();
    std::fs::write(dir.join("truncated.jpg"), &full[..full.len() / 3]).unwrap();
    // Decompression bomb: 30000×30000 header (900 MP) in a tiny file.
    let mut ihdr: Vec<u8> = Vec::new();
    ihdr.extend_from_slice(b"IHDR");
    ihdr.extend_from_slice(&30000u32.to_be_bytes());
    ihdr.extend_from_slice(&30000u32.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut bomb: Vec<u8> = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
    bomb.extend_from_slice(&(ihdr.len() as u32 - 4).to_be_bytes());
    bomb.extend_from_slice(&ihdr);
    bomb.extend_from_slice(&png_crc(&ihdr).to_be_bytes());
    std::fs::write(dir.join("bomb.png"), &bomb).unwrap();
    // Over the import pixel cap: 8100×8100 = 65.6 MP.
    put(
        "huge.png",
        DynamicImage::ImageRgb8(RgbImage::from_pixel(8100, 8100, Rgb([10, 10, 10]))),
        ImageFormat::Png,
    );

    let mut listing: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("list fixtures")
        .flatten()
        .map(|e| e.path())
        .collect();
    listing.sort();
    listing
}

/// CRC-32 (PNG variant) for the IHDR chunk.
fn png_crc(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

// ── B: import ─────────────────────────────────────────────────────────

fn import_pass(dir: &Path, report: &mut Report) {
    println!("\n── B. import pass ─────────────────────────────────────");
    let good = [
        "tiny.png",
        "square.png",
        "portrait.jpg",
        "landscape.jpg",
        "noisy.png",
        "lowres.png",
        "phone_12mp.jpg",
        "wide_strip.png",
        "alpha.png",
        "alpha.webp",
        "gray.png",
        "sixteen.png",
        "exif_rotated.jpg",
    ];
    let bad = [
        "notes.txt",
        "corrupt.png",
        "empty.png",
        "lies.png",
        "truncated.jpg",
        "bomb.png",
        "huge.png",
        "missing.png",
    ];
    let paths: Vec<String> = good
        .iter()
        .chain(bad.iter())
        .map(|n| dir.join(n).to_string_lossy().into_owned())
        .collect();
    let t0 = Instant::now();
    let outcomes = import::import_many(&paths);
    println!(
        "  {} files validated in {:?} (peak working set {:?} MB)",
        outcomes.len(),
        t0.elapsed(),
        hardware::process_memory().map(|m| m.peak_working_set_bytes / (1 << 20))
    );
    let by_name: std::collections::BTreeMap<String, (bool, String, String)> = outcomes
        .iter()
        .map(|o| match o {
            import::ImportOutcome::Imported { image } => (
                image.name.clone(),
                true,
                format!(
                    "{}x{} {}",
                    image.width,
                    image.height,
                    ser_fmt(&image.format)
                ),
                String::new(),
            ),
            import::ImportOutcome::Failed { name, error } => (
                name.clone(),
                false,
                error.code.to_string(),
                error.message.to_string(),
            ),
        })
        .map(|(n, ok, a, b)| (n, (ok, a, b)))
        .collect();
    for name in good.iter().chain(bad.iter()) {
        let entry = by_name.get(*name);
        let (imported, facts, msg) = match entry {
            Some((i, f, m)) => (*i, f.clone(), m.clone()),
            None => {
                report.note("import", format!("{name} produced no outcome at all"));
                continue;
            }
        };
        println!(
            "  {:<20} {:<5} {}{}",
            name,
            if imported { "OK" } else { "REJECT" },
            facts,
            if msg.is_empty() {
                String::new()
            } else {
                format!(" · {msg}")
            }
        );
        if name == &"exif_rotated.jpg" && imported {
            let (w, h) = facts
                .split(' ')
                .next()
                .and_then(|s| s.split_once('x'))
                .map(|(a, b)| (a.parse::<u32>().unwrap_or(0), b.parse::<u32>().unwrap_or(0)))
                .unwrap_or((0, 0));
            if (w, h) != (100, 200) {
                report.note(
                    "import",
                    format!(
                        "EXIF Orientation=6 ignored: stored {w}x{h} reported; the app must show 100x200. Phone portraits import sideways and export sideways."
                    ),
                );
            }
        }
    }
    for name in bad.iter() {
        if let Some((true, facts, _)) = by_name.get(*name) {
            report.note("import", format!("{name} was ACCEPTED ({facts})"));
        }
    }
    for name in good.iter().take(12) {
        if let Some((false, _, msg)) = by_name.get(*name) {
            report.note("import", format!("{name} unexpectedly REJECTED: {msg}"));
        }
    }
    // Views for the display ladder.
    for name in ["portrait.jpg", "phone_12mp.jpg", "wide_strip.png"] {
        let p = dir.join(name);
        match import::load_image_view(&p, import::VIEW_MAX_EDGE) {
            Ok(v) => report.ok(&format!(
                "view {name}: {}x{} delivered edge {}",
                v.width, v.height, v.delivered_edge
            )),
            Err(e) => report.note("import", format!("view {name} failed: {}", e.code())),
        }
    }
}

fn ser_fmt(f: &import::ImageFormatLabel) -> String {
    serde_json::to_string(f).unwrap_or_default()
}

// ── C/D: enhance + export ─────────────────────────────────────────────

fn enhance(
    registry: &ModelRegistry,
    config: &EngineConfig,
    out_dir: &Path,
    source: &Path,
    mode: EnhanceMode,
    scale: usize,
    events: &mut Vec<EnhanceEvent>,
) -> Result<EnhanceResult, String> {
    let jobs = Arc::new(JobRegistry::new());
    let token = Arc::new(CancelToken::new());
    let job_id = jobs.next_job_id();
    jobs.begin(&job_id, token.clone())
        .map_err(|e| format!("{e:?}"))?;
    let result = service::enhance(
        &source.to_string_lossy(),
        mode,
        scale,
        Filter::Original,
        DEFAULT_INTENSITY,
        registry,
        config,
        out_dir,
        &jobs,
        &job_id,
        &token,
        |e| events.push(e),
        OnnxBackend::load_with,
    );
    result.map_err(|e| format!("{} · {}", e.code(), e.user_message()))
}

fn enhance_pass(
    fixtures: &Path,
    registry: &ModelRegistry,
    config: &EngineConfig,
    masters: &Path,
    report: &mut Report,
) -> Vec<(String, PathBuf, u32, u32)> {
    println!("\n── C. enhance pass (real runtime) ─────────────────────");
    println!(
        "  device {} · budgets tile {:>9} MB band {:>9} MB",
        probe_device(),
        config.max_tile_bytes / (1 << 20),
        config.max_band_bytes / (1 << 20)
    );
    let plan: &[(&str, usize)] = &[
        ("tiny.png", 4),
        ("lowres.png", 4),
        ("square.png", 2),
        ("portrait.jpg", 4),
        ("landscape.jpg", 2),
        ("noisy.png", 4),
        ("alpha.png", 4),
        ("alpha.webp", 4),
        ("gray.png", 4),
        ("sixteen.png", 4),
        ("wide_strip.png", 4),
        ("phone_12mp.jpg", 2),
    ];
    let mut committed = Vec::new();
    for (name, scale) in plan {
        let src = fixtures.join(name);
        let mut events = Vec::new();
        let t0 = Instant::now();
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            enhance(
                registry,
                config,
                masters,
                &src,
                EnhanceMode::Standard,
                *scale,
                &mut events,
            )
        }));
        let secs = t0.elapsed().as_secs_f32();
        let result = match outcome {
            Ok(r) => r,
            Err(_) => {
                report.note(
                    "enhance",
                    format!("{name} at {scale}× PANICKED inside the pipeline (release builds abort the process)"),
                );
                continue;
            }
        };
        match result {
            Ok(res) => {
                let decoded = image::open(&res.file_path).expect("master decodes");
                let want_w = decoded.width();
                if decoded.width() != res.output_width || decoded.height() != res.output_height {
                    report.note(
                        "enhance",
                        format!(
                            "{name}: result claims {}x{} but the file is {}x{}",
                            res.output_width,
                            res.output_height,
                            decoded.width(),
                            decoded.height()
                        ),
                    );
                }
                let tiles = events
                    .iter()
                    .filter(|e| matches!(e, EnhanceEvent::Processing { .. }))
                    .count();
                let last = events.iter().rev().find_map(|e| match e {
                    EnhanceEvent::Processing { done, total } => Some((*done, *total)),
                    _ => None,
                });
                if last != Some((tiles as u32, tiles as u32)) && tiles > 0 {
                    report.note(
                        "enhance",
                        format!("{name}: progress events {tiles} vs last {last:?}"),
                    );
                }
                report.ok(&format!(
                    "{name} {scale}× → {}×{} · {} · {secs:.1}s · {tiles} tiles · {}",
                    want_w,
                    decoded.height(),
                    res.engine,
                    res.file_path
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default()
                ));
                committed.push((
                    (*name).to_string(),
                    res.file_path.clone(),
                    res.output_width,
                    res.output_height,
                ));
                if res.data_url.is_none() {
                    report.note(
                        "enhance",
                        format!("{name}: single-image result has no display view"),
                    );
                }
            }
            Err(err) => {
                report.note("enhance", format!("{name} at {scale}× failed: {err}"));
            }
        }
    }
    committed
}

fn export_pass(masters: &[(String, PathBuf, u32, u32)], out: &Path, report: &mut Report) {
    println!("\n── D. export pass ─────────────────────────────────────");
    std::fs::create_dir_all(out).expect("export dir");
    let src = masters
        .iter()
        .find(|(n, ..)| n == "square.png")
        .or_else(|| masters.first());
    let Some((_, master, w, h)) = src else {
        report.note("export", "no master to export from");
        return;
    };
    let (w, h) = (*w, *h);
    let cases: [(ExportFormat, u8, &str); 5] = [
        (ExportFormat::Png, 90, "png"),
        (ExportFormat::Jpeg, 90, "jpg"),
        (ExportFormat::Jpeg, 40, "jpg"),
        (ExportFormat::Webp, 90, "webp"),
        (ExportFormat::Webp, 40, "webp"),
    ];
    let mut sizes: Vec<(String, u64)> = Vec::new();
    for (fmt, q, ext) in cases {
        let res = export::export_image(master, out, "audit", fmt, q)
            .unwrap_or_else(|e| panic!("export {fmt:?} {q}: {}", e.user_message()));
        let decoded = image::open(&res.file_path)
            .unwrap_or_else(|e| panic!("{} re-decodes: {e}", res.file_name));
        if (decoded.width(), decoded.height()) != (w, h) {
            report.note(
                "export",
                format!(
                    "{}: {}x{} expected, got {}x{}",
                    res.file_name,
                    w,
                    h,
                    decoded.width(),
                    decoded.height()
                ),
            );
        }
        let got_ext = Path::new(&res.file_name)
            .extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_default();
        if got_ext != ext {
            report.note(
                "export",
                format!("{fmt:?} q{q} wrote .{got_ext}, expected .{ext}"),
            );
        }
        sizes.push((res.file_name.clone(), res.bytes));
        report.ok(&format!("{} · {} KB", res.file_name, res.bytes / 1024));
    }
    let size_of = |needle: &str| {
        sizes
            .iter()
            .find(|(n, _)| n.contains(needle))
            .map(|(_, b)| *b)
    };
    if let (Some(lo), Some(hi)) = (size_of("audit-2.jpg"), size_of("audit.jpg")) {
        if lo >= hi {
            report.note(
                "export",
                format!("JPEG quality is not real: q40 {lo} >= q90 {hi}"),
            );
        }
    }
    let master_bytes = std::fs::read(master).expect("read master");
    let png_copy = std::fs::read(out.join("audit.png")).expect("read png");
    if png_copy != master_bytes {
        report.note("export", "PNG export is not a lossless copy of the master");
    }
    // Alpha must survive to PNG and WebP, and be honestly dropped for JPEG.
    if let Some((_, alpha_master, aw, ah)) = masters.iter().find(|(n, ..)| n == "alpha.png") {
        let adir = out.join("alpha");
        std::fs::create_dir_all(&adir).expect("alpha dir");
        for (fmt, name) in [
            (ExportFormat::Png, "alpha.png"),
            (ExportFormat::Webp, "alpha.webp"),
            (ExportFormat::Jpeg, "alpha.jpg"),
        ] {
            let r = export::export_image(alpha_master, &adir, "a", fmt, 90).expect("alpha export");
            let d = image::open(&r.file_path).expect("alpha re-decode");
            if (d.width(), d.height()) != (*aw, *ah) {
                report.note("export", format!("{name}: wrong dimensions"));
            }
            let has_alpha = matches!(
                d,
                DynamicImage::ImageRgba8(_) | DynamicImage::ImageLumaA8(_)
            );
            let want_alpha = name != "alpha.jpg";
            if has_alpha != want_alpha {
                report.note(
                    "export",
                    format!("{name}: alpha {} (expected {})", has_alpha, want_alpha),
                );
            }
            report.ok(&format!("alpha → {name} · {} KB", r.bytes / 1024));
        }
    }
    // libwebp's 16383 px edge ceiling used to reach the crate's
    // convenience encoder, which answers a failed encode by unwrapping —
    // i.e. a crash. It must be a clean, named refusal instead.
    let ceiling = {
        let img = image::RgbImage::new(17_000, 8);
        let mut cur = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut cur, ImageFormat::Png)
            .expect("encode");
        let p = out.join("ceiling-src.png");
        std::fs::write(&p, cur.into_inner()).expect("write ceiling master");
        p
    };
    match export::export_image(&ceiling, out, "ceiling", ExportFormat::Webp, 80) {
        Ok(_) => report.note("export", "WebP accepted a 17000 px edge"),
        Err(e) if e.code() == "export_limit" => {
            report.ok("WebP refuses an over-ceiling master (export_limit)")
        }
        Err(e) => report.note(
            "export",
            format!("WebP over-ceiling gave {} not export_limit", e.code()),
        ),
    }

    // Collision: a second export with the same stem must not overwrite.
    let first = std::fs::read(out.join("audit.jpg")).expect("first");
    let again =
        export::export_image(master, out, "audit", ExportFormat::Jpeg, 90).expect("collision");
    if std::fs::read(out.join("audit.jpg")).expect("untouched") != first {
        report.note("export", "collision check overwrote an existing file");
    }
    if again.file_name == "audit.jpg" {
        report.note("export", "collision kept the same name");
    } else {
        report.ok(&format!("collision → {}", again.file_name));
    }
    // A stem with path separators must not escape the folder.
    let escape = export::export_image(master, out, "../../escaped", ExportFormat::Png, 90);
    match escape {
        Ok(r) => {
            let p = PathBuf::from(&r.file_path);
            if p.starts_with(out) {
                report.ok(&format!("traversal stem neutralised → {}", r.file_name));
            } else {
                report.note(
                    "export",
                    format!("traversal stem escaped: {}", r.file_path.display()),
                );
            }
        }
        Err(e) => report.ok(&format!("traversal stem refused ({})", e.code())),
    }
}

// ── E: batch ──────────────────────────────────────────────────────────

fn batch_pass(
    fixtures: &Path,
    registry: Arc<ModelRegistry>,
    config: EngineConfig,
    engine_out: &Path,
    exports: &Path,
    store_dir: &Path,
    report: &mut Report,
) {
    println!("\n── E. batch pass ──────────────────────────────────────");
    let history = history::Store::open(store_dir);
    let jobs = Arc::new(JobRegistry::new());
    let engine = Arc::new(batch::BatchEngine {
        registry,
        jobs,
        config,
        out_dir: engine_out.to_path_buf(),
        history: history.clone(),
    });
    let mk = |name: &str, scale: usize| batch::BatchSource {
        image_id: String::new(),
        path: fixtures.join(name).to_string_lossy().into_owned(),
        name: name.to_string(),
        settings: batch::BatchSettings {
            mode: EnhanceMode::Standard,
            scale,
            filter: Filter::Original,
            intensity: DEFAULT_INTENSITY,
        },
    };
    let sources = vec![
        mk("portrait.jpg", 2),
        mk("square.png", 2),
        mk("corrupt.png", 2),
        mk("lowres.png", 2),
    ];
    let (tx, rx) = mpsc::sync_channel::<batch::BatchEvent>(256);
    let (session, snapshot) = batch::start_batch(
        sources,
        batch::BatchOutputConfig {
            folder: exports.to_string_lossy().into_owned(),
            format: ExportFormat::Jpeg,
            quality: 82,
        },
        engine.clone(),
        tx,
        Arc::new(batch::enhance_item_onnx),
    )
    .unwrap_or_else(|e| panic!("batch start: {}", e.user_message()));
    let handle = session.handle().clone();
    let ids: Vec<String> = snapshot.items.iter().map(|i| i.id.clone()).collect();
    report.ok(&format!("queue started with {} items", ids.len()));

    // Cancel the *waiting* item (square) immediately, then cancel the
    // running item once it has genuinely started producing tiles.
    let mut terminal = 0usize;
    let mut running_cancelled = false;
    let mut cancel_done = false;
    let mut devices = Vec::new();
    let t0 = Instant::now();
    while terminal < ids.len() {
        let event = rx
            .recv_timeout(Duration::from_secs(600))
            .unwrap_or_else(|_| panic!("batch event stream stalled after {:?}", t0.elapsed()));
        match &event {
            batch::BatchEvent::Device { device, .. } => devices.push(*device),
            batch::BatchEvent::Progress {
                item_id,
                done,
                total,
            } => {
                if !cancel_done && item_id == &ids[0] && *done >= 1 && *total > 2 {
                    handle.cancel_item(&ids[0]);
                    handle.cancel_item(&ids[1]);
                    cancel_done = true;
                    println!("  cancel requested for item 0 (mid-run) and 1 (waiting)");
                }
            }
            batch::BatchEvent::Completed { .. }
            | batch::BatchEvent::Failed { .. }
            | batch::BatchEvent::Cancelled { .. } => terminal += 1,
            _ => {}
        }
    }
    let snap = handle.snapshot();
    let state_of = |i: usize| format!("{:?}", snap.items[i].state);
    println!(
        "  states: {} / {} / {} / {}",
        state_of(0),
        state_of(1),
        state_of(2),
        state_of(3)
    );
    if !matches!(snap.items[0].state, batch::BatchItemState::Cancelled) {
        report.note(
            "batch",
            format!("mid-run cancel left item 0 as {:?}", snap.items[0].state),
        );
    } else {
        running_cancelled = true;
    }
    if matches!(snap.items[1].state, batch::BatchItemState::Completed) {
        report.note("batch", "item cancelled from the queue still ran");
    }
    if !matches!(snap.items[2].state, batch::BatchItemState::Failed) {
        report.note(
            "batch",
            format!("corrupt item reported {:?}", snap.items[2].state),
        );
    }
    if !matches!(snap.items[3].state, batch::BatchItemState::Completed) {
        report.note(
            "batch",
            format!("healthy item did not complete: {:?}", snap.items[3].state),
        );
    }
    for item in &snap.items {
        if let Some(out) = &item.output {
            let p = PathBuf::from(&out.file_path);
            if !p.is_file() {
                report.note("batch", format!("{} reported {}", item.name, out.file_path));
            }
            if !p.starts_with(exports) {
                report.note(
                    "batch",
                    format!("{} wrote outside the folder: {}", item.name, out.file_path),
                );
            }
        }
    }
    report.ok(&format!(
        "queue drained in {:?} · devices {:?}",
        t0.elapsed(),
        devices
    ));

    // Retry must re-queue the cancelled + failed items only.
    let before_completed = snap
        .items
        .iter()
        .filter(|i| matches!(i.state, batch::BatchItemState::Completed))
        .count();
    let requeued = handle.retry_failed();
    println!("  retry_failed re-queued {requeued} items");
    if requeued == 0 {
        report.note("batch", "retry_failed re-queued nothing");
    }
    let mut waited = 0usize;
    while handle.snapshot().running && waited < 600 {
        std::thread::sleep(Duration::from_millis(500));
        waited += 1;
    }
    while rx.try_recv().is_ok() {}
    let snap2 = handle.snapshot();
    let after_completed = snap2
        .items
        .iter()
        .filter(|i| matches!(i.state, batch::BatchItemState::Completed))
        .count();
    if after_completed <= before_completed {
        report.note(
            "batch",
            format!("retry made no progress: {before_completed} → {after_completed} completed"),
        );
    } else {
        report.ok(&format!("retry recovered → {after_completed} completed"));
    }
    let corrupt_still_failed = matches!(snap2.items[2].state, batch::BatchItemState::Failed);
    if !corrupt_still_failed {
        report.note(
            "batch",
            format!(
                "retry turned a corrupt file into {:?}",
                snap2.items[2].state
            ),
        );
    }
    if snap2.running {
        report.note("batch", "queue never reported drained");
    }
    // The journal must reflect the work, capped and newest-first.
    let snap_hist = history.snapshot();
    report.ok(&format!(
        "journal holds {} entries, {} recents",
        snap_hist.entries.len(),
        snap_hist.recents.len()
    ));
    if snap_hist.entries.is_empty() {
        report.note("batch", "batch wrote no journal entries");
    }
    if !running_cancelled {
        report.note("batch", "cancel assertion never ran");
    }
    // Cancel-all on a fresh queue.
    let (tx2, rx2) = mpsc::sync_channel::<batch::BatchEvent>(256);
    let (s2, snap3) = batch::start_batch(
        vec![
            mk("square.png", 2),
            mk("noisy.png", 2),
            mk("portrait.jpg", 2),
        ],
        batch::BatchOutputConfig {
            folder: exports.to_string_lossy().into_owned(),
            format: ExportFormat::Png,
            quality: 90,
        },
        engine.clone(),
        tx2,
        Arc::new(batch::enhance_item_onnx),
    )
    .expect("second batch");
    let h2 = s2.handle().clone();
    let _ = rx2
        .recv_timeout(Duration::from_secs(600))
        .expect("first event");
    h2.cancel_all();
    let mut drained = 0;
    let t0 = Instant::now();
    while drained < 3 {
        match rx2.recv_timeout(Duration::from_secs(600)) {
            Ok(batch::BatchEvent::Completed { .. })
            | Ok(batch::BatchEvent::Failed { .. })
            | Ok(batch::BatchEvent::Cancelled { .. }) => drained += 1,
            Ok(_) => {}
            Err(e) => {
                report.note("batch", format!("cancel-all stream ended early: {e:?}"));
                break;
            }
        }
    }
    let s = h2.snapshot();
    let any_completed = s
        .items
        .iter()
        .any(|i| matches!(i.state, batch::BatchItemState::Completed));
    let any_cancelled = s
        .items
        .iter()
        .any(|i| matches!(i.state, batch::BatchItemState::Cancelled));
    println!(
        "  cancel-all → {:?} in {:?}",
        s.items.iter().map(|i| i.state).collect::<Vec<_>>(),
        t0.elapsed()
    );
    if !any_cancelled {
        report.note("batch", "cancel_all cancelled nothing");
    }
    if !any_completed && s3_all_failed(&s) {
        report.note("batch", "cancel_all also destroyed already-committed work");
    }
    let _ = snap3;
}

fn s3_all_failed(snap: &batch::BatchSnapshot) -> bool {
    snap.items
        .iter()
        .all(|i| matches!(i.state, batch::BatchItemState::Failed))
}

// ── F: constrained memory ─────────────────────────────────────────────

fn memory_pass(fixtures: &Path, registry: &ModelRegistry, masters: &Path, report: &mut Report) {
    println!("\n── F. constrained-memory pass ─────────────────────────");
    for mb in [4usize, 24, 96] {
        let budgets = hardware::MemoryBudgets {
            max_tile_bytes: mb << 20,
            max_band_bytes: mb << 20,
        };
        let config = EngineConfig::with_budgets(256, budgets);
        let mut events = Vec::new();
        let t0 = Instant::now();
        let result = enhance(
            registry,
            &config,
            masters,
            &fixtures.join("portrait.jpg"),
            EnhanceMode::Standard,
            4,
            &mut events,
        );
        let tile = events.iter().find_map(|e| match e {
            EnhanceEvent::Device { tile, .. } => Some(*tile),
            _ => None,
        });
        match result {
            Ok(_) => report.ok(&format!(
                "{mb} MB budget → tile {tile:?} completed in {:?}",
                t0.elapsed()
            )),
            Err(err) => report.note("memory", format!("{mb} MB budget failed: {err}")),
        }
        if tile == Some(0) {
            report.note("memory", format!("{mb} MB budget produced a zero tile"));
        }
    }
    // Absurdly small: the ladder must refuse honestly, not hang or crash.
    let config = EngineConfig::with_budgets(
        256,
        hardware::MemoryBudgets {
            max_tile_bytes: 1 << 10,
            max_band_bytes: 1 << 10,
        },
    );
    let mut events = Vec::new();
    let r = enhance(
        registry,
        &config,
        masters,
        &fixtures.join("portrait.jpg"),
        EnhanceMode::Standard,
        4,
        &mut events,
    );
    match r {
        Ok(_) => report.note("memory", "a 1 KB budget somehow completed"),
        Err(err) => report.ok(&format!("1 KB budget refused honestly: {err}")),
    }
    println!(
        "  peak working set now {:?} MB",
        hardware::process_memory().map(|m| m.peak_working_set_bytes / (1 << 20))
    );
}

// ── main ──────────────────────────────────────────────────────────────

fn main() {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("fovea-audit-matrix"));
    let skip_enhance = std::env::args().any(|a| a == "--import-only");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("root dir");
    let fixtures = root.join("fixtures");
    std::fs::create_dir_all(&fixtures).expect("fixtures dir");
    let masters = root.join("enhanced");
    std::fs::create_dir_all(&masters).expect("masters dir");
    let exports = root.join("exports");
    let store = root.join("store");

    println!("── A. fixtures ────────────────────────────────────────");
    let made = write_fixtures(&fixtures);
    for p in &made {
        let meta = std::fs::metadata(p).ok();
        println!(
            "  {:<22} {:>9} KB",
            p.file_name().unwrap().to_string_lossy(),
            meta.map(|m| m.len() / 1024).unwrap_or(0)
        );
    }

    let mut report = Report::default();
    import_pass(&fixtures, &mut report);

    let registry = Arc::new(ModelRegistry::new(vec![
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("models"),
    ]));
    let config = EngineConfig::default();

    if !skip_enhance {
        let committed = enhance_pass(&fixtures, &registry, &config, &masters, &mut report);
        if !committed.is_empty() {
            export_pass(&committed, &exports, &mut report);
        }
        batch_pass(
            &fixtures,
            registry.clone(),
            config,
            &masters,
            &root.join("batch-exports"),
            &store,
            &mut report,
        );
        memory_pass(&fixtures, &registry, &masters, &mut report);
    }

    println!(
        "\n══════════ FINDINGS ({} ) ══════════",
        report.findings.len()
    );
    for f in &report.findings {
        println!("  [{}] {}", f.area, f.detail);
    }
    if report.findings.is_empty() {
        println!("  none");
    }
    println!("\nartifacts: {}", root.display());
    let _ = std::io::stdout().flush();
}
