//! Stage 07 benchmark harness — real numbers, no fabricated statistics.
//!
//! Runs the genuine pipeline (Real-ESRGAN on ONNX Runtime, DirectML GPU or
//! CPU per the machine + env) over four fixture sizes and reports measured
//! facts: device, tile geometry, tile count, wall time, throughput, output
//! size, and the process's peak working set.
//!
//!   GPU (default):   cargo run --release --example stage07_bench -- <out-dir>
//!   CPU path:        FOVEA_FORCE_CPU=1 cargo run --release --example stage07_bench -- <out-dir> [sizes…]
//!   Tight tiles:     FOVEA_TILE=64 …  (reproduces low-VRAM conditions)
//!
//! Sizes: `small` (512×384), `typical` (1920×1440), `hires` (4032×3024 ≈
//! 12 MP — a modern phone camera), `large` (5300×3000 ≈ 16 MP, just under
//! the 256 MP output ceiling). Omit the list to run every size. On CPU,
//! run `small typical` — the larger passes are hours, which the harness
//! reports honestly rather than pretending to finish.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use image::{DynamicImage, ImageFormat, RgbImage};
use upscaler_lib::services::hardware;
use upscaler_lib::services::inference::backend::{CancelToken, OnnxBackend};
use upscaler_lib::services::inference::finish::{DEFAULT_INTENSITY, Filter};
use upscaler_lib::services::inference::model::{EnhanceMode, ModelRegistry};
use upscaler_lib::services::inference::service::{self, EngineConfig, EnhanceEvent, JobRegistry};

/// (key, width, height) — see the module header for what each represents.
const SIZES: &[(&str, u32, u32)] = &[
    ("small", 512, 384),
    ("typical", 1920, 1440),
    ("hires", 4032, 3024),
    ("large", 5300, 3000),
];

/// A photo-like fixture: smooth luminance gradient, fine noise (sensor
/// grain), and hard geometric edges (detail the AI must actually
/// reconstruct). Deterministic — no RNG dependency.
fn fixture(w: u32, h: u32) -> RgbImage {
    let mut img = RgbImage::new(w, h);
    for (x, y, p) in img.enumerate_pixels_mut() {
        let (x, y) = (x as usize, y as usize);
        let grad = 40 + (y * 160) / (h as usize).max(1);
        let grain = ((x * 1103515245 + y * 12345 + 7) % 48) as u8;
        let mut v = [grad as u8, (grad / 2 + 40) as u8, 255 - grad as u8];
        if (x / 8 + y / 8) % 2 == 0 {
            v = [20, 20, 24]; // checkerboard edges
        }
        if (x > w as usize / 3 && x < 2 * w as usize / 3)
            && (y > h as usize / 3 && y < 2 * h as usize / 3)
        {
            let stroke = (x - y) % 13 < 3;
            v = if stroke {
                [240, 220, 40]
            } else {
                [12, 60, 120]
            };
        }
        p[0] = v[0].saturating_add(grain / 3);
        p[1] = v[1].saturating_add(grain / 4);
        p[2] = v[2].saturating_sub(grain / 5);
    }
    img
}

fn write_fixture(dir: &Path, key: &str, w: u32, h: u32) -> PathBuf {
    let path = dir.join(format!("fovea-{key}.jpg"));
    if !path.exists() {
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(fixture(w, h))
            .write_to(&mut out, ImageFormat::Jpeg)
            .expect("encode fixture");
        std::fs::write(&path, out.into_inner()).expect("write fixture");
    }
    path
}

struct RunStats {
    device: String,
    tile: u32,
    tiles_done: u32,
    tiles_total: u32,
    wall_ms: u128,
    out_px: u64,
    out_bytes: u64,
    peak_ws: u64,
}

fn run_case(dir: &Path, models: &Path, out: &Path, key: &str, w: u32, h: u32) -> RunStats {
    let src = write_fixture(dir, key, w, h);
    let registry = ModelRegistry::new(vec![models.to_path_buf()]);
    let jobs = JobRegistry::new();
    let token = Arc::new(CancelToken::new());
    let job_id = jobs.next_job_id();
    jobs.begin(&job_id, Arc::clone(&token)).expect("begin");

    let mut device = String::new();
    let mut tile = 0;
    let mut done = 0;
    let mut total = 0;
    let t0 = Instant::now();
    let result = service::enhance(
        &src.to_string_lossy(),
        EnhanceMode::Standard,
        4,
        Filter::Original,
        DEFAULT_INTENSITY,
        &registry,
        &EngineConfig::default(),
        out,
        &jobs,
        &job_id,
        &token,
        |e| match e {
            EnhanceEvent::Device { device: d, tile: t } => {
                device = d.to_string();
                tile = t;
            }
            EnhanceEvent::Processing { done: d, total: t } => {
                done = d;
                total = t;
            }
            _ => {}
        },
        OnnxBackend::load_with,
    )
    .unwrap_or_else(|e| panic!("{key} enhance failed: {e}"));
    let wall_ms = t0.elapsed().as_millis();
    let bytes = std::fs::metadata(&result.file_path)
        .map(|m| m.len())
        .unwrap_or(0);
    let _ = std::fs::remove_file(&result.file_path); // keep the repo disk sane
    let peak_ws = hardware::process_memory()
        .map(|m| m.peak_working_set_bytes)
        .unwrap_or(0);
    RunStats {
        device,
        tile,
        tiles_done: done,
        tiles_total: total,
        wall_ms,
        out_px: u64::from(w) * u64::from(h) * 16, // 4× → 16× the pixels
        out_bytes: bytes,
        peak_ws,
    }
}

fn mb(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("fovea-bench"));
    std::fs::create_dir_all(&dir).expect("bench dir");
    let selected: Vec<String> = args.collect();
    let models = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models");

    let hw = hardware::detect();
    let budgets = hardware::memory_budgets(hw);
    println!("=== Fovea Stage 07 benchmark ===");
    println!(
        "cpu    : {} ({} phys / {} log)",
        hw.cpu_name, hw.physical_cores, hw.logical_processors
    );
    println!(
        "memory : {:.0} GB total / {:.0} GB free",
        hw.total_memory_bytes as f64 / (1 << 30) as f64,
        hw.available_memory_bytes as f64 / (1 << 30) as f64
    );
    for g in &hw.gpus {
        println!(
            "gpu    : {} — {:.0} GB dedicated, DX12: {}{}",
            g.name,
            g.dedicated_video_bytes as f64 / (1 << 30) as f64,
            g.directx12,
            if g.software { " (software)" } else { "" }
        );
    }
    println!(
        "budgets: tile ≤ {:.0} MB, band ≤ {:.0} MB; device probe: {}",
        budgets.max_tile_bytes as f64 / (1 << 20) as f64,
        budgets.max_band_bytes as f64 / (1 << 20) as f64,
        service::probe_device(),
    );
    println!();
    println!("| size | source | engine | tile | tiles | time | out MP/s | out size | peak RSS |");
    println!("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");

    for (key, w, h) in SIZES {
        if !selected.is_empty() && !selected.iter().any(|s| s == key) {
            continue;
        }
        let stats = run_case(&dir, &models, &dir, key, *w, *h);
        let secs = stats.wall_ms as f64 / 1000.0;
        let out_mp = stats.out_px as f64 / 1e6;
        println!(
            "| {key} | {w}×{h} | {} | {} | {}/{} | {secs:.1} s | {:.2} | {} MB | {} MB |",
            stats.device,
            stats.tile,
            stats.tiles_done,
            stats.tiles_total,
            out_mp / secs,
            mb(stats.out_bytes).round(),
            mb(stats.peak_ws).round(),
        );
    }
    println!(
        "\nNumbers are measured end-to-end (decode → model load → all tiles → encode → commit)."
    );
}
