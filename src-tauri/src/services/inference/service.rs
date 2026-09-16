//! Application-level enhancement service (Stage 05).
//!
//! Ties the pieces together for one real workflow — *input image → local
//! inference → enhanced output on disk* — and owns the application
//! semantics the commands and UI rely on:
//!
//! - **Stages:** `preparing` (validate/decode source, load model) →
//!   `processing` (real completed-tile counts from the engine) →
//!   `completing` (encode + atomically move into place) → `completed` /
//!   `failed` / `cancelled`. Every phase is a fact, never an estimate;
//!   the processing fraction is completed-tiles / planned-tiles.
//! - **Output:** a lossless PNG under the app-data `enhanced/` directory,
//!   streamed row-by-row (never a second full-res frame in memory),
//!   written to `*.part` and renamed only on success. Cancellation or
//!   failure deletes the `.part` — no corrupt file ever becomes visible.
//! - **Cancellation:** in-flight jobs live in [`JobRegistry`] keyed by a
//!   server-generated id; cancel flags the job's [`CancelToken`], which
//!   also hard-terminates the in-flight ONNX Runtime call.
//! - **The privacy path:** source bytes, model bytes, and output bytes
//!   are opened by local code on local paths. This module performs no
//!   network I/O of any kind.
//!
//! The result crosses the boundary once (the command's return value): a
//! display-ready data URL built through the *existing* viewer ladder, so
//! the compare view gets exactly the honest resolution contract Stage 04
//! defined for the original side.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use image::RgbImage;
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::services::import;

use super::backend::{Backend, CancelToken, EngineError};
use super::engine::{self, Plan, PostPass, RowWriter};
use super::model::{EnhanceMode, ModelRegistry, ModelState, product_scales_for};

/// Largest source (in pixels) the engine will attempt. Import allows
/// 64 MP for *viewing*; a 4× pass over that would produce a >100 MP
/// output and hundreds of MB of intermediates — reject honestly instead
/// of grinding or crashing.
pub const MAX_ENHANCE_INPUT_PIXELS: u64 = 16_000_000;

/// Tile edge / pad defaults live in `engine`; surfaced here as the tunable
/// process configuration so "where do tile sizes come from" has one answer.
#[derive(Debug, Clone, Copy)]
pub struct EngineConfig {
    pub tile: usize,
    pub pad: usize,
    pub max_input_pixels: u64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            tile: engine::DEFAULT_TILE,
            pad: engine::DEFAULT_PAD,
            max_input_pixels: MAX_ENHANCE_INPUT_PIXELS,
        }
    }
}

/// One enhancement result — serialized to the UI (`EnhanceResultDto`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceResult {
    /// The imported image's canonical path (the UI's stable key).
    pub image_id: String,
    /// Pixora's output file — export/save-as works from here.
    pub file_path: PathBuf,
    pub width: u32,
    pub height: u32,
    /// Human label, e.g. "4× · Real-ESRGAN general".
    pub label: String,
    /// Engine device actually used, e.g. "DirectML GPU" | "CPU".
    pub engine: String,
    /// Display-size view of the result (the compare slider's `afterSrc`).
    pub data_url: String,
}

/// Progress events streamed to the UI over a Tauri channel while a job
/// runs. Terminal states (failed/cancelled) are *also* observable here
/// before the command's promise rejects — the UI closes the progress
/// surface on either signal without waiting.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum EnhanceEvent {
    /// Validating the source + loading the model. Carries the server-side
    /// job id so the UI can cancel this exact run.
    Preparing { job_id: String },
    /// Inference running. `done`/`total` are completed tiles — a real
    /// measurement, not an estimate.
    Processing { done: u32, total: u32 },
    /// Encoding and committing the output file.
    Completing,
    /// All tiles inferred, file committed; the result arrives via the
    /// command's return value.
    Completed,
    /// The command will reject with this safe `{ code, message }`.
    Failed {
        code: &'static str,
        message: &'static str,
    },
    /// The user cancelled; nothing was committed.
    Cancelled,
}

/// Tracks in-flight jobs so the UI can cancel them. Registration is
/// single-slot by design: Pixora Stage 05 runs one enhancement at a time
/// (a second concurrent GPU job would thrash memory and slow both); a
/// busy second request is refused honestly. Stage 08's batch queue
/// replaces this with a real queue.
#[derive(Default)]
pub struct JobRegistry {
    inner: Mutex<HashMap<String, Arc<CancelToken>>>,
    seq: AtomicU64,
    shutting_down: AtomicBool,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a unique job id. Server-generated so ids can safely seed file
    /// names — client-supplied ids never touch the filesystem. Nanosecond
    /// precision makes ids globally unique even across process restarts
    /// and multiple registries, so a committed output can never be
    /// silently overwritten by a later job reusing the name.
    pub fn next_job_id(&self) -> String {
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("job-{t}-{n}")
    }

    /// Register a token. `Err(Busy)` when a job is already running or the
    /// app is closing.
    pub fn begin(&self, id: &str, token: Arc<CancelToken>) -> Result<(), Busy> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(Busy::ShuttingDown);
        }
        let mut guard = self.inner.lock().map_err(|_| Busy::Poisoned)?;
        if !guard.is_empty() {
            return Err(Busy::Running);
        }
        guard.insert(id.to_string(), Arc::clone(&token));
        Ok(())
    }

    pub fn finish(&self, id: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.remove(id);
        }
    }

    /// Whether a job id is currently registered (live).
    pub fn has(&self, id: &str) -> bool {
        self.inner
            .lock()
            .map(|g| g.contains_key(id))
            .unwrap_or(false)
    }

    /// Cancel the running job. Idempotent; an unknown id is a no-op
    /// (racing with natural completion is normal and safe).
    pub fn cancel(&self, id: &str) {
        if let Ok(guard) = self.inner.lock() {
            if let Some(token) = guard.get(id) {
                token.cancel();
            }
        }
    }

    /// Live job count — asserted by the service tests.
    #[cfg(test)]
    pub fn active_count(&self) -> usize {
        self.inner.lock().map(|g| g.len()).unwrap_or(0)
    }

    /// Window-close hook: refuse new jobs and cancel live ones. Workers
    /// delete their `.part` scratch and exit promptly via the token.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Ok(guard) = self.inner.lock() {
            for token in guard.values() {
                token.cancel();
            }
        }
    }
}

#[derive(Debug)]
pub enum Busy {
    Running,
    ShuttingDown,
    Poisoned,
}

impl From<Busy> for AppError {
    fn from(b: Busy) -> Self {
        match b {
            Busy::Running => AppError::InsufficientResources {
                detail: "an enhancement job is already running".into(),
            },
            Busy::ShuttingDown => AppError::Cancelled {
                detail: "application is closing".into(),
            },
            Busy::Poisoned => AppError::unexpected("job registry lock poisoned"),
        }
    }
}

/// Where enhanced files live — resolved once per app data dir. Every
/// caller (setup cleanup, jobs, later export) asks this; no one else
/// builds the path.
pub fn enhanced_dir(app_data: &Path) -> PathBuf {
    app_data.join("enhanced")
}

/// Startup cleanup: drop leftover `*.part` scratch from interrupted runs
/// (crash, kill, cancel race). Completed results are kept until a later
/// stage adds history management.
pub fn cleanup_scratch(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // nothing to clean (dir not created yet) — fine
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "part") && std::fs::remove_file(&path).is_ok() {
            log::info!("cleaned leftover enhancement scratch file");
        }
    }
}

/// Engine/model readiness summary for the UI. Cheap enough to call on
/// demand (size + sha256 over a ~5 MB model).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceStatus {
    /// Device the *next* session will use: "DirectML GPU" | "CPU".
    pub device: &'static str,
    pub models: Vec<super::model::ModelStatus>,
    /// True when at least one validated model is installed.
    pub ready: bool,
    /// Product upscale factors the installed models genuinely deliver.
    pub scales: Vec<usize>,
    /// Every mode the product knows about and whether its model is
    /// installed — the UI hides what isn't rather than offering a lie.
    pub modes: Vec<ModeStatus>,
    /// Directory the user can drop models into (display only).
    pub models_dir_display: String,
}

/// One enhancement mode's availability (Stage 06).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeStatus {
    /// "standard" | "natural" | "detail".
    pub key: &'static str,
    /// Display label — identical on both sides of the boundary.
    pub label: &'static str,
    pub description: &'static str,
    /// The model behind the mode is installed, validated, and runnable.
    pub available: bool,
}

pub fn inference_status(registry: &ModelRegistry) -> InferenceStatus {
    let models = registry.status();
    let ready = models.iter().any(|m| m.state == "ready");
    let scales = registry.available_scales();
    let modes = EnhanceMode::ALL
        .iter()
        .map(|m| ModeStatus {
            key: m.key(),
            label: m.label(),
            description: m.description(),
            available: registry.mode_available(*m),
        })
        .collect();
    InferenceStatus {
        device: probe_device(),
        models,
        ready,
        scales,
        modes,
        models_dir_display: registry
            .search_dirs()
            .last()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// Which device a newly-created session will land on. `ort` decides per
/// session; the answer is stable for the process, so probe + cache.
fn probe_device() -> &'static str {
    static DEVICE: OnceLock<&'static str> = OnceLock::new();
    DEVICE.get_or_init(|| {
        use ort::ep::ExecutionProvider;
        super::backend::init_environment();
        match ort::ep::DirectML::default().is_available() {
            Ok(true) => "DirectML GPU",
            _ => "CPU",
        }
    })
}

/// Run one enhancement job to completion. Generic over [`Backend`] so the
/// whole service contract — staging, errors, atomicity, registry — is
/// tested with a fake runtime; the real one is `OnnxBackend`.
///
/// `mode` selects the enhancement behavior (each one backed by genuinely
/// different processing — see `model::EnhanceMode`); `target` is the
/// product upscale factor, which must be genuinely deliverable by the
/// chosen model (`product_scales_for`), or the job fails honestly before
/// any work starts.
///
/// `jobs.begin` must already own registration failure; this function
/// always reaches `jobs.finish` exactly once. `emit` observes every
/// phase transition in order.
#[allow(clippy::too_many_arguments)]
pub fn enhance<B: Backend>(
    source_id: &str,
    mode: EnhanceMode,
    target: usize,
    registry: &ModelRegistry,
    config: &EngineConfig,
    out_dir: &Path,
    jobs: &JobRegistry,
    job_id: &str,
    token: &Arc<CancelToken>,
    mut emit: impl FnMut(EnhanceEvent),
    open_backend: impl FnOnce(&Path) -> Result<B, EngineError>,
) -> AppResult<EnhanceResult> {
    emit(EnhanceEvent::Preparing {
        job_id: job_id.to_string(),
    });
    match enhance_inner(
        source_id,
        mode,
        target,
        registry,
        config,
        out_dir,
        job_id,
        token,
        &mut emit,
        open_backend,
    ) {
        Ok(result) => {
            jobs.finish(job_id);
            emit(EnhanceEvent::Completed);
            Ok(result)
        }
        Err(err) => {
            jobs.finish(job_id);
            err.log();
            match &err {
                AppError::Cancelled { .. } => emit(EnhanceEvent::Cancelled),
                other => emit(EnhanceEvent::Failed {
                    code: other.code(),
                    message: other.user_message(),
                }),
            }
            Err(err)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn enhance_inner<B: Backend>(
    source_id: &str,
    mode: EnhanceMode,
    target: usize,
    registry: &ModelRegistry,
    config: &EngineConfig,
    out_dir: &Path,
    job_id: &str,
    token: &Arc<CancelToken>,
    emit: &mut dyn FnMut(EnhanceEvent),
    open_backend: impl FnOnce(&Path) -> Result<B, EngineError>,
) -> AppResult<EnhanceResult> {
    let source = Path::new(source_id);

    // The same validation ladder import ran — a deleted or mutated file
    // now fails with its right user-safe code, not an engine mystery.
    let (decoded, _size) = import::decode_validated(source)?;
    let pixels = u64::from(decoded.width()) * u64::from(decoded.height());
    if pixels > config.max_input_pixels {
        return Err(AppError::FileTooLarge {
            detail: format!(
                "enhancement source {pixels} px exceeds the {} px engine cap",
                config.max_input_pixels
            ),
        });
    }

    // Model: the mode selects which model runs. Locate + validate through
    // the registry, then load the session.
    let (spec, model_path) = registry.ready_model_for_mode(mode).ok_or_else(|| {
        let backed = mode.model_backing();
        match registry
            .specs()
            .iter()
            .find(|m| m.mode == Some(backed))
            .map(|s| registry.locate(s))
        {
            Some(ModelState::Corrupt { reason }) => AppError::ModelCorrupt {
                detail: format!("{}: {reason}", spec_detail(mode, backed)),
            },
            _ => AppError::ModelMissing {
                detail: spec_detail(mode, backed),
            },
        }
    })?;
    // The requested upscale must be genuinely deliverable by this model:
    // the model's native factor, or exactly half of it (the band is then
    // box-resampled on stream — a real two-stage pipeline). Anything else
    // is refused before the runtime is touched, not approximated.
    if !product_scales_for(spec.scale).contains(&target) {
        return Err(AppError::UnsupportedScale {
            detail: format!("target {target}x not offered by model scale {}", spec.scale),
        });
    }
    let mut backend = open_backend(&model_path).map_err(|err| match err {
        EngineError::Cancelled => AppError::Cancelled {
            detail: spec.id.into(),
        },
        EngineError::OutOfMemory(detail) => AppError::InsufficientResources { detail },
        EngineError::Failed(detail) => AppError::EngineUnavailable { detail },
    })?;

    // Flatten to the pipeline's input format. Alpha sources keep their
    // transparency: the mask is nearest-resampled onto the output while
    // the AI restores color.
    let has_alpha = decoded.color().has_alpha();
    let alpha_plane: Option<Vec<u8>> = has_alpha.then(|| {
        let rgba = decoded.to_rgba8();
        rgba.pixels().map(|p| p[3]).collect()
    });
    let rgb: RgbImage = decoded.into_rgb8();

    // Detail is Standard + the engine's real unsharp post-pass.
    let post = match mode {
        EnhanceMode::Detail => PostPass::Sharpen,
        _ => PostPass::None,
    };

    let plan = Plan::with_target(
        rgb.width() as usize,
        rgb.height() as usize,
        spec.scale,
        target,
        config.tile,
        config.pad,
    );

    // Atomic output: write `*.part`, rename on success, delete otherwise.
    std::fs::create_dir_all(out_dir)?;
    let final_path = out_dir.join(format!("{job_id}.png"));
    let part_path = out_dir.join(format!("{job_id}.png.part"));
    let _ = std::fs::remove_file(&part_path);
    let outcome = run_pipeline(
        &mut backend,
        &rgb,
        alpha_plane,
        &plan,
        post,
        &part_path,
        token,
        emit,
    );
    let Err(err) = outcome else {
        // Commit, then build the display view through the viewer ladder.
        if let Err(e) = std::fs::rename(&part_path, &final_path) {
            let _ = std::fs::remove_file(&part_path);
            return Err(AppError::unexpected(format!("commit output: {e}")));
        }
        let view = import::load_image_view(&final_path, import::VIEW_MAX_EDGE)?;
        return Ok(EnhanceResult {
            image_id: source_id.to_string(),
            file_path: final_path,
            width: view.width,
            height: view.height,
            label: format!("{target}× · {}", mode.label()),
            engine: backend.device_name().to_string(),
            data_url: view.data_url,
        });
    };
    let _ = std::fs::remove_file(&part_path);
    Err(err)
}

/// Log-only identity for a mode's backing model in missing/corrupt detail
/// strings (never crosses the boundary).
fn spec_detail(mode: EnhanceMode, backed: EnhanceMode) -> String {
    format!("{}:{}", mode.key(), backed.key())
}

/// Inference + encoding for one committed output path. Any failure here
/// means the `.part` must die; that cleanup is the caller's job.
#[allow(clippy::too_many_arguments)]
fn run_pipeline<B: Backend>(
    backend: &mut B,
    rgb: &RgbImage,
    alpha_plane: Option<Vec<u8>>,
    plan: &Plan,
    post: PostPass,
    part_path: &Path,
    token: &CancelToken,
    emit: &mut dyn FnMut(EnhanceEvent),
) -> AppResult<()> {
    let file =
        File::create(part_path).map_err(|e| AppError::unexpected(format!("create output: {e}")))?;
    let writer = BufWriter::with_capacity(1 << 16, file);
    let mut sink = PngSink::new(
        writer,
        plan.out_w() as u32,
        plan.out_h() as u32,
        alpha_plane,
        plan.src_w,
        plan.target,
    )?;
    engine::run(backend, rgb, plan, post, &mut sink, token, |done, total| {
        emit(EnhanceEvent::Processing { done, total })
    })
    .map_err(|err| match err {
        EngineError::Cancelled => AppError::Cancelled {
            detail: "tiles".into(),
        },
        EngineError::OutOfMemory(detail) => AppError::InsufficientResources { detail },
        EngineError::Failed(detail) => AppError::ProcessingFailed { detail },
    })?;
    // All tiles done — finishing the encode is the last real phase.
    emit(EnhanceEvent::Completing);
    sink.finish()
}

/// Streaming PNG sink: one row in, compressed bytes out — the full frame
/// is never materialized. RGB sources encode as Rgb8 PNG; sources that
/// had alpha re-attach it via nearest sampling (alpha is a coverage mask;
/// "sharpening" it would invent transparency).
struct PngSink {
    stream: Option<png::StreamWriter<'static, BufWriter<File>>>,
    alpha: Option<Vec<u8>>,
    src_w: usize,
    scale: usize,
    out_w: usize,
    rows_written: usize,
    row_buf: Vec<u8>,
}

impl PngSink {
    fn new(
        w: BufWriter<File>,
        out_w: u32,
        out_h: u32,
        alpha: Option<Vec<u8>>,
        src_w: usize,
        scale: usize,
    ) -> AppResult<Self> {
        let mut encoder = png::Encoder::new(w, out_w, out_h);
        encoder.set_color(if alpha.is_some() {
            png::ColorType::Rgba
        } else {
            png::ColorType::Rgb
        });
        encoder.set_depth(png::BitDepth::Eight);
        let writer = encoder
            .write_header()
            .map_err(|e| AppError::unexpected(format!("png header: {e}")))?;
        let stream = writer
            .into_stream_writer()
            .map_err(|e| AppError::unexpected(format!("png stream: {e}")))?;
        Ok(PngSink {
            stream: Some(stream),
            alpha,
            src_w,
            scale: scale.max(1),
            out_w: out_w as usize,
            rows_written: 0,
            row_buf: Vec::new(),
        })
    }

    fn finish(&mut self) -> AppResult<()> {
        let Some(stream) = self.stream.take() else {
            return Ok(());
        };
        stream
            .finish()
            .map_err(|e| AppError::unexpected(format!("png finish: {e}")))
    }
}

impl RowWriter for PngSink {
    fn write_row(&mut self, rgb: &[u8]) -> Result<(), EngineError> {
        let Some(stream) = self.stream.as_mut() else {
            return Err(EngineError::Failed("sink written after finish".into()));
        };
        debug_assert_eq!(rgb.len(), self.out_w * 3, "row width must match header");
        let result = match &self.alpha {
            None => stream.write_all(rgb),
            Some(plane) => {
                let src_y = (self.rows_written / self.scale).min(plane.len() / self.src_w);
                self.row_buf.clear();
                for (x, px) in rgb.chunks_exact(3).enumerate() {
                    self.row_buf.extend_from_slice(px);
                    let sx = (x / self.scale).min(self.src_w - 1);
                    self.row_buf.push(plane[src_y * self.src_w + sx]);
                }
                stream.write_all(&self.row_buf)
            }
        };
        result.map_err(|e| EngineError::Failed(format!("png row: {e}")))?;
        self.rows_written += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::inference::backend::TileOutput;
    use crate::services::inference::model::ModelSpec;
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
    use std::io::Cursor;

    /// Identity-ish fake backend (2× nearest) — fast, no runtime needed.
    struct Fake2x;

    /// Nearest-neighbour upscale by any factor — geometry stand-in for the
    /// real runtime so the service contract (and the 2×-target resample)
    /// is testable without ONNX Runtime.
    struct FakeScale {
        scale: usize,
    }

    impl Backend for FakeScale {
        fn device_name(&self) -> &'static str {
            "fake"
        }
        fn run_tile(
            &mut self,
            chw: Vec<f32>,
            width: usize,
            height: usize,
            cancel: &CancelToken,
        ) -> Result<TileOutput, EngineError> {
            if cancel.is_cancelled() {
                return Err(EngineError::Cancelled);
            }
            let s = self.scale;
            let (ow, oh) = (width * s, height * s);
            let mut data = vec![0f32; 3 * oh * ow];
            for c in 0..3 {
                for y in 0..oh {
                    for x in 0..ow {
                        data[c * oh * ow + y * ow + x] =
                            chw[c * height * width + (y / s) * width + x / s];
                    }
                }
            }
            Ok(TileOutput {
                width: ow,
                height: oh,
                data,
            })
        }
    }

    impl Backend for Fake2x {
        fn device_name(&self) -> &'static str {
            "fake"
        }
        fn run_tile(
            &mut self,
            chw: Vec<f32>,
            width: usize,
            height: usize,
            cancel: &CancelToken,
        ) -> Result<TileOutput, EngineError> {
            FakeScale { scale: 2 }.run_tile(chw, width, height, cancel)
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pixora-enhance-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn source_png(dir: &Path, name: &str, w: u32, h: u32, alpha: bool) -> PathBuf {
        let mut img = RgbaImage::new(w, h);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = Rgba([
                (x * 5 % 251) as u8,
                (y * 9 % 249) as u8,
                ((x + y) % 253) as u8,
                if alpha && (x + y) % 2 == 0 { 120 } else { 255 },
            ]);
        }
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(img)
            .write_to(&mut out, ImageFormat::Png)
            .expect("encode");
        let path = dir.join(name);
        std::fs::write(&path, out.into_inner()).expect("write source");
        path
    }

    /// A registry whose first dir contains a model file matching `spec`.
    fn registry_with(dir: &Path, spec: &ModelSpec) -> ModelRegistry {
        // The manager hashes by the *declared* spec fields; build a spec
        // that matches the bytes we can fabricate here: real ONNX magic +
        // anything. Write minimal valid-onnx-magic bytes and derive hash.
        let mut bytes = vec![0x08, b'O', b'N', b'N', b'X', 0x10, 0x01, 0x00];
        bytes.extend_from_slice(&[42u8; 64]);
        std::fs::create_dir_all(dir).expect("dir");
        std::fs::write(dir.join(spec.file_name), &bytes).expect("write model");
        let mut spec = *spec;
        let (size, hash) = measure(&bytes);
        // Leaked statics keep ModelSpec's &'static fields ergonomic.
        let hash: &'static str = Box::leak(hash.into_boxed_str());
        spec.size_bytes = size;
        spec.sha256 = hash;
        // MODELS is the public list; the test registry uses its own spec
        // by pointing id/file_name at what locate_by_id / ready_model use.
        // We can't inject a spec into MODELS, so registry tests here only
        // exercise paths that pass through ready_model(model_id). For unit
        // tests, we patch the lookup: build specs into a temp registry.
        ModelRegistry::with_specs(vec![dir.to_path_buf()], vec![spec])
    }

    fn measure(bytes: &[u8]) -> (u64, String) {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let hex = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        (bytes.len() as u64, hex)
    }

    fn fake_spec() -> ModelSpec {
        ModelSpec {
            id: "fake-2x",
            file_name: "fake.onnx",
            label: "fake model",
            scale: 2,
            size_bytes: 0,
            sha256: "",
            // The service resolves Standard → this fake model (the general
            // 4× model in production); Detail shares the same backing.
            mode: Some(EnhanceMode::Standard),
        }
    }

    fn harness(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = scratch(tag);
        (root.clone(), root.join("models"), root.join("enhanced"))
    }

    #[allow(clippy::type_complexity)]
    fn run_job(
        tag: &str,
        source_pixels: u32,
        alpha: bool,
        mutate: Option<fn(&Path)>,
        token_setup: Option<fn(&CancelToken)>,
        config: EngineConfig,
    ) -> (
        AppResult<EnhanceResult>,
        Vec<EnhanceEvent>,
        PathBuf,
        Arc<JobRegistry>,
        Arc<CancelToken>,
    ) {
        run_job_with(
            tag,
            source_pixels,
            alpha,
            mutate,
            token_setup,
            config,
            EnhanceMode::Standard,
            2,
        )
    }

    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    fn run_job_with(
        tag: &str,
        source_pixels: u32,
        alpha: bool,
        mutate: Option<fn(&Path)>,
        token_setup: Option<fn(&CancelToken)>,
        config: EngineConfig,
        mode: EnhanceMode,
        target: usize,
    ) -> (
        AppResult<EnhanceResult>,
        Vec<EnhanceEvent>,
        PathBuf,
        Arc<JobRegistry>,
        Arc<CancelToken>,
    ) {
        let (root, models_dir, out_dir) = harness(tag);
        let mut events = Vec::new();
        let source = source_png(&root, "photo.png", source_pixels, source_pixels / 2, alpha);
        if let Some(m) = mutate {
            m(&source);
        }
        let spec = fake_spec();
        let registry = registry_with(&models_dir, &spec);
        let jobs = Arc::new(JobRegistry::new());
        let token = Arc::new(CancelToken::new());
        let job_id = jobs.next_job_id();
        jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
        if let Some(setup) = token_setup {
            setup(&token);
        }
        let result = enhance(
            &source.to_string_lossy(),
            mode,
            target,
            &registry,
            &config,
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |e| events.push(e),
            |_| Ok(Fake2x),
        );
        (result, events, root, jobs, token)
    }

    #[test]
    fn successful_job_produces_double_size_png_and_measured_progress() {
        let (result, events, root, jobs, _) =
            run_job("ok", 90, false, None, None, EngineConfig::default());
        let result = result.expect("enhance succeeds");
        assert_eq!(jobs.active_count(), 0, "job slot released");
        assert_eq!(result.width, 90 * 2);
        assert_eq!(result.height, 45 * 2);
        assert_eq!(result.engine, "fake");
        assert!(result.label.contains("2×"));
        assert!(result.data_url.starts_with("data:image/png;base64,"));
        // The committed file exists; no scratch remains.
        assert!(result.file_path.exists());
        assert_eq!(result.file_path.extension().unwrap(), "png");
        let parts: Vec<_> = std::fs::read_dir(root.join("enhanced"))
            .expect("out dir")
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "part"))
            .collect();
        assert!(parts.is_empty(), "no .part leftovers");
        // Event sequence: preparing, processing×N (tiles), completing,
        // completed — strictly ordered and real.
        let phases: Vec<&str> = events
            .iter()
            .map(|e| match e {
                EnhanceEvent::Preparing { .. } => "preparing",
                EnhanceEvent::Processing { .. } => "processing",
                EnhanceEvent::Completing => "completing",
                EnhanceEvent::Completed => "completed",
                EnhanceEvent::Failed { .. } => "failed",
                EnhanceEvent::Cancelled => "cancelled",
            })
            .collect();
        assert_eq!(phases.first(), Some(&"preparing"));
        assert_eq!(phases.last(), Some(&"completed"));
        let last = events.iter().rev().find_map(|e| match e {
            EnhanceEvent::Processing { done, total } => Some((*done, *total)),
            _ => None,
        });
        // 90x45 with default 256px tiles → a single tile; fraction is honest.
        assert_eq!(last, Some((1, 1)));
        // Verify the *file* decodes at the expected dimensions.
        let decoded = image::open(&result.file_path).expect("open output");
        assert_eq!((decoded.width(), decoded.height()), (180, 90));
    }

    #[test]
    fn tiled_job_reports_every_tile_and_stays_pixel_faithful() {
        // Force a 40px tile grid over a 100×60 source → 3×2 = 6 tiles.
        let (result, events, _root, _jobs, _) = run_job(
            "tiled",
            100,
            false,
            None,
            None,
            EngineConfig {
                tile: 40,
                pad: 8,
                ..Default::default()
            },
        );
        let result = result.expect("enhance succeeds");
        let counts: Vec<(u32, u32)> = events
            .iter()
            .filter_map(|e| match e {
                EnhanceEvent::Processing { done, total } => Some((*done, *total)),
                _ => None,
            })
            .collect();
        assert_eq!(counts.len(), 6);
        assert_eq!(counts.last(), Some(&(6, 6)));
        // Faithfulness: the fake doubles pixels; output at (x,y) equals
        // source at (x/2, y/2).
        let src = image::open(Path::new(&result.image_id))
            .expect("src")
            .into_rgb8();
        let out = image::open(&result.file_path).expect("out").into_rgb8();
        for (x, y) in [(1u32, 7u32), (50, 30), (199, 99)] {
            assert_eq!(
                out.get_pixel(x, y).0,
                src.get_pixel(x / 2, y / 2).0,
                "pixel ({x},{y})"
            );
        }
    }

    #[test]
    fn alpha_source_preserves_transparency() {
        let (result, _events, _root, _jobs, _) =
            run_job("alpha", 48, true, None, None, EngineConfig::default());
        let result = result.expect("enhance succeeds");
        let decoded = image::open(&result.file_path).expect("open");
        assert!(decoded.color().has_alpha(), "alpha preserved");
        let rgba = decoded.into_rgba8();
        // Source alpha checkerboard: (x+y) even → 120, else 255. Output
        // (ox,oy) maps nearest to src (ox/2, oy/2): (0,0)→(0,0) even→120,
        // (0,2)→(0,1) odd→255.
        assert_eq!(rgba.get_pixel(0, 0)[3], 120);
        assert_eq!(rgba.get_pixel(2, 2)[3], 120);
        assert_eq!(rgba.get_pixel(0, 2)[3], 255);
    }

    #[test]
    fn cancelled_job_leaves_no_files_and_flags_cancelled() {
        let (result, events, _root, jobs, _) = run_job(
            "cancel",
            80,
            false,
            None,
            Some(|t: &CancelToken| t.cancel()),
            EngineConfig::default(),
        );
        let err = result.expect_err("must fail as cancelled");
        assert_eq!(err.code(), "cancelled");
        assert_eq!(events.last().map(phase), Some("cancelled"));
        assert_eq!(jobs.active_count(), 0, "job slot released on cancel");
        let out = _root.join("enhanced");
        let leftovers: Vec<_> = std::fs::read_dir(&out)
            .expect("dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty(), "scratch cleaned: {leftovers:?}");
        assert_eq!(
            std::fs::read_dir(&out).expect("dir").count(),
            0,
            "no outputs"
        );
    }

    #[test]
    fn missing_model_is_reported_not_faked() {
        let (root, models_dir, out_dir) = harness("missing-model");
        let _ = models_dir; // registry searches an empty models dir
        let source = source_png(&root, "photo.png", 40, 20, false);
        let registry =
            ModelRegistry::with_specs(vec![root.join("nothing-here")], vec![fake_spec()]);
        let jobs = JobRegistry::new();
        let token = Arc::new(CancelToken::new());
        let job_id = jobs.next_job_id();
        jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
        let mut events = Vec::new();
        let err = enhance(
            &source.to_string_lossy(),
            EnhanceMode::Standard,
            2,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |e| events.push(e),
            |_| Ok(Fake2x),
        )
        .expect_err("must fail");
        assert_eq!(err.code(), "model_missing");
        assert_eq!(events.last().map(phase), Some("failed"));
        assert_eq!(jobs.active_count(), 0);
        // The output dir was never even needed — the job aborted in
        // preparing, so there is nothing (or only nothing) there.
        let entries = std::fs::read_dir(&out_dir).map(|d| d.count()).unwrap_or(0);
        assert_eq!(entries, 0, "no output produced for a missing model");
    }

    #[test]
    fn corrupt_model_is_reported_as_corrupt() {
        let (root, models_dir, out_dir) = harness("corrupt-model");
        let source = source_png(&root, "photo.png", 40, 20, false);
        // File present but hash lies.
        std::fs::create_dir_all(&models_dir).expect("dir");
        std::fs::write(models_dir.join("fake.onnx"), "not really a model at all!").expect("write");
        let registry = ModelRegistry::with_specs(vec![models_dir.clone()], vec![fake_spec()]);
        let spec_path = models_dir.join("fake.onnx");
        assert!(matches!(
            registry.locate_by_id("fake-2x"),
            ModelState::Corrupt { .. }
        ));
        let _ = spec_path;
        let jobs = JobRegistry::new();
        let token = Arc::new(CancelToken::new());
        let job_id = jobs.next_job_id();
        jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
        let err = enhance(
            &source.to_string_lossy(),
            EnhanceMode::Standard,
            2,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |_| {},
            |_| Ok(Fake2x),
        )
        .expect_err("must fail");
        assert_eq!(err.code(), "model_corrupt");
        assert_eq!(jobs.active_count(), 0);
    }

    #[test]
    fn oversized_input_is_refused_before_the_engine_runs() {
        let (result, events, _root, _jobs, _) = run_job(
            "oversize",
            6_000,
            false,
            None,
            None,
            EngineConfig {
                max_input_pixels: 1_000_000,
                ..Default::default()
            },
        );
        let err = result.expect_err("must fail");
        assert_eq!(err.code(), "file_too_large");
        assert!(matches!(events.last(), Some(EnhanceEvent::Failed { .. })));
    }

    #[test]
    fn deleted_source_fails_as_file_missing() {
        let (result, _events, _root, _jobs, _) = run_job(
            "deleted",
            40,
            false,
            Some(|p| {
                let _ = std::fs::remove_file(p);
            }),
            None,
            EngineConfig::default(),
        );
        let err = result.expect_err("must fail");
        assert_eq!(err.code(), "file_missing");
    }

    #[test]
    fn backend_init_failure_maps_to_engine_unavailable() {
        let (root, models_dir, out_dir) = harness("init-fail");
        let source = source_png(&root, "photo.png", 40, 20, false);
        let registry = registry_with(&models_dir, &fake_spec());
        let jobs = JobRegistry::new();
        let token = Arc::new(CancelToken::new());
        let job_id = jobs.next_job_id();
        jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
        let err = enhance(
            &source.to_string_lossy(),
            EnhanceMode::Standard,
            2,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |_| {},
            |_| Err::<Fake2x, EngineError>(EngineError::Failed("dml device removed".into())),
        )
        .expect_err("must fail");
        assert_eq!(err.code(), "engine_unavailable");
        assert_eq!(jobs.active_count(), 0);
    }

    #[test]
    fn busy_registry_refuses_a_second_concurrent_job() {
        let jobs = JobRegistry::new();
        let a = jobs.next_job_id();
        jobs.begin(&a, Arc::new(CancelToken::new()))
            .expect("begin a");
        let b = jobs.next_job_id();
        assert!(matches!(
            jobs.begin(&b, Arc::new(CancelToken::new())),
            Err(Busy::Running)
        ));
        jobs.finish(&a);
        jobs.begin(&b, Arc::new(CancelToken::new()))
            .expect("b after a");
    }

    #[test]
    fn unsupported_scale_is_refused_before_the_engine_runs() {
        // The fake model is 2× native — asking for 4× is not a lie
        // candidate (no upscale-by-2 of a 2× output is offered); it must
        // fail with its own code, having touched no runtime.
        let (root, models_dir, out_dir) = harness("bad-scale");
        let source = source_png(&root, "photo.png", 40, 20, false);
        let registry = registry_with(&models_dir, &fake_spec());
        let jobs = JobRegistry::new();
        let token = Arc::new(CancelToken::new());
        let job_id = jobs.next_job_id();
        jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
        let err = enhance(
            &source.to_string_lossy(),
            EnhanceMode::Standard,
            4,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |_| {},
            |_| -> Result<Fake2x, EngineError> {
                panic!("the runtime must never be touched for an unsupportable scale")
            },
        )
        .expect_err("must fail");
        assert_eq!(err.code(), "unsupported_scale");
        assert_eq!(jobs.active_count(), 0);
        assert_eq!(
            std::fs::read_dir(&out_dir).map(|d| d.count()).unwrap_or(0),
            0,
            "no output for a refused scale"
        );
    }

    #[test]
    fn natural_mode_resolves_the_wdn_model_and_labels_it() {
        let (root, models_dir, out_dir) = harness("natural-mode");
        let source = source_png(&root, "photo.png", 40, 20, false);
        // Two models in one dir: standard + wdn (natural).
        let std_bytes = {
            let mut b = vec![0x08, b'O', b'N', b'N', b'X', 0x10, 0x01, 0x00];
            b.extend_from_slice(&[42u8; 64]);
            b
        };
        let wdn_bytes = {
            let mut b = vec![0x08, b'O', b'N', b'N', b'X', 0x10, 0x01, 0x01];
            b.extend_from_slice(&[7u8; 40]);
            b
        };
        std::fs::create_dir_all(&models_dir).expect("dir");
        std::fs::write(models_dir.join("std.onnx"), &std_bytes).expect("std");
        std::fs::write(models_dir.join("wdn.onnx"), &wdn_bytes).expect("wdn");
        let (ss, sh) = measure(&std_bytes);
        let (ws, wh) = measure(&wdn_bytes);
        let sh: &'static str = Box::leak(sh.into_boxed_str());
        let wh: &'static str = Box::leak(wh.into_boxed_str());
        let registry = ModelRegistry::with_specs(
            vec![models_dir],
            vec![
                ModelSpec {
                    id: "std",
                    file_name: "std.onnx",
                    label: "std",
                    scale: 2,
                    size_bytes: ss,
                    sha256: sh,
                    mode: Some(EnhanceMode::Standard),
                },
                ModelSpec {
                    id: "wdn",
                    file_name: "wdn.onnx",
                    label: "wdn",
                    scale: 2,
                    size_bytes: ws,
                    sha256: wh,
                    mode: Some(EnhanceMode::Natural),
                },
            ],
        );
        let jobs = JobRegistry::new();
        let token = Arc::new(CancelToken::new());
        let job_id = jobs.next_job_id();
        jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
        let result = enhance(
            &source.to_string_lossy(),
            EnhanceMode::Natural,
            2,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |_| {},
            |_| Ok(Fake2x),
        )
        .expect("natural job must run");
        assert!(result.label.contains("2× · Natural"));
    }

    #[test]
    fn cancel_command_hits_the_registered_token() {
        let jobs = JobRegistry::new();
        let id = jobs.next_job_id();
        let token = Arc::new(CancelToken::new());
        jobs.begin(&id, Arc::clone(&token)).expect("begin");
        assert!(!token.is_cancelled());
        jobs.cancel(&id);
        assert!(token.is_cancelled());
        // Unknown id: no-op, no panic.
        jobs.cancel("nope");
    }

    #[test]
    fn scratch_cleanup_removes_parts_only() {
        let dir = scratch("cleanup");
        std::fs::write(dir.join("a.png.part"), b"x").expect("part");
        std::fs::write(dir.join("keep.png"), b"x").expect("png");
        cleanup_scratch(&dir);
        assert!(!dir.join("a.png.part").exists());
        assert!(dir.join("keep.png").exists());
    }

    fn phase(e: &EnhanceEvent) -> &'static str {
        match e {
            EnhanceEvent::Preparing { .. } => "preparing",
            EnhanceEvent::Processing { .. } => "processing",
            EnhanceEvent::Completing => "completing",
            EnhanceEvent::Completed => "completed",
            EnhanceEvent::Failed { .. } => "failed",
            EnhanceEvent::Cancelled => "cancelled",
        }
    }

    #[test]
    fn events_serialize_with_stable_phase_names() {
        let json = serde_json::to_string(&EnhanceEvent::Processing { done: 3, total: 9 })
            .expect("serialize");
        assert!(json.contains("\"phase\":\"processing\""));
        assert!(json.contains("\"done\":3"));
        assert!(json.contains("\"total\":9"));
    }

    /// ── Real end-to-end: ONNX Runtime + the bundled model ───────────
    ///
    /// Ignored by default (loads a GPU runtime — slow-ish, needs the
    /// model file). Run with:
    ///   cargo test --lib -- --ignored real_pipeline
    #[test]
    #[ignore = "requires ONNX Runtime binaries + the bundled model file"]
    fn real_pipeline_upscales_a_real_png() {
        use crate::services::inference::backend::OnnxBackend;
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let models_dir = manifest.join("models");
        let spec = crate::services::inference::model::MODELS[0];
        let registry = ModelRegistry::new(vec![models_dir]);
        let Some((_, _model_path)) = registry.ready_model(spec.id) else {
            panic!("bundled model must be present + hash-valid for this test");
        };

        // A real test photo: the fixture generator's gradient is too
        // synthetic for an AI smoke check, so render something with
        // structure — a small photo-like scene: sky gradient, horizon,
        // hard-edged shapes the network must sharpen, not invent.
        let (root, _models, out_dir) = harness("real-pipeline");
        let source = {
            let mut img = RgbaImage::new(140, 90);
            for (x, y, p) in img.enumerate_pixels_mut() {
                let sky = 60.0 + (y as f32 / 90.0) * 140.0;
                let mut v = [sky as u8, (sky * 0.7) as u8, 200u8];
                if y > 60 {
                    // "ground": textured blocks
                    v = [40 + (x / 7 % 200) as u8, 90, 50 + (y / 5 % 120) as u8];
                }
                if (20..40).contains(&x) && (10..50).contains(&y) {
                    v = [250, 240, 30]; // a crisp rectangle edge
                }
                *p = Rgba([v[0], v[1], v[2], 255]);
            }
            let mut out = Cursor::new(Vec::new());
            DynamicImage::ImageRgba8(img)
                .write_to(&mut out, ImageFormat::Png)
                .expect("encode");
            let path = root.join("scene.png");
            std::fs::write(&path, out.into_inner()).expect("write");
            path
        };

        let jobs = JobRegistry::new();
        let token = Arc::new(CancelToken::new());
        let job_id = jobs.next_job_id();
        jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
        let mut events = Vec::new();
        let t0 = std::time::Instant::now();
        let result = enhance(
            &source.to_string_lossy(),
            EnhanceMode::Standard,
            4,
            &registry,
            // Deliberately a small grid so multiple real tiles run.
            &EngineConfig {
                tile: 64,
                pad: 8,
                ..Default::default()
            },
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |e| events.push(e),
            OnnxBackend::load,
        )
        .expect("real enhancement must succeed");
        println!(
            "real 4× enhance of 140x90 → {}x{} in {:?} on {}",
            result.width,
            result.height,
            t0.elapsed(),
            result.engine
        );
        assert_eq!((result.width, result.height), (560, 360));
        assert_eq!(events.last().map(phase), Some("completed"));
        // Real model ran real tiles: multiple processing events.
        let tiles = events
            .iter()
            .filter(|e| matches!(e, EnhanceEvent::Processing { .. }))
            .count();
        assert!(tiles >= 6, "64px grid over 140x90 must run several tiles");
        // Output validity: decodes, exact dimensions, PNG, not uniform.
        let decoded = image::open(&result.file_path).expect("output decodes");
        assert_eq!((decoded.width(), decoded.height()), (560, 360));
        let out_rgb = decoded.into_rgb8();
        let first = out_rgb.get_pixel(0, 0).0;
        let varied = out_rgb.pixels().take(4000).any(|p| p.0 != first);
        assert!(varied, "output must carry real detail, not a flat fill");
        assert!(jobs.active_count() == 0);
    }

    /// Real end-to-end for the *other* Stage 06 surfaces: the 2× target
    /// (resampled model band) and the Natural + Detail modes, against the
    /// two bundled models. Same ignored-by-default runtime requirement.
    #[test]
    #[ignore = "requires ONNX Runtime binaries + the bundled model files"]
    fn real_modes_and_scales_produce_genuinely_different_results() {
        use crate::services::inference::backend::OnnxBackend;
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let registry = ModelRegistry::new(vec![manifest.join("models")]);
        let (root, _models, out_dir) = harness("real-modes");
        let source = {
            // Small synthetic scene; a checkerboard + gradient so modes
            // differ measurably.
            let mut img = RgbaImage::new(128, 96);
            for (x, y, p) in img.enumerate_pixels_mut() {
                let v = if (x / 8 + y / 8) % 2 == 0 {
                    210u8
                } else {
                    30u8
                };
                *p = Rgba([v, v / 2, 255 - v, 255]);
            }
            let mut out = Cursor::new(Vec::new());
            DynamicImage::ImageRgba8(img)
                .write_to(&mut out, ImageFormat::Png)
                .expect("encode");
            let path = root.join("board.png");
            std::fs::write(&path, out.into_inner()).expect("write");
            path
        };
        let config = EngineConfig {
            tile: 64,
            pad: 8,
            ..Default::default()
        };

        let run = |mode: EnhanceMode, scale: usize| -> (EnhanceResult, RgbaImage) {
            let jobs = JobRegistry::new();
            let token = Arc::new(CancelToken::new());
            let job_id = jobs.next_job_id();
            jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
            let result = enhance(
                &source.to_string_lossy(),
                mode,
                scale,
                &registry,
                &config,
                &out_dir,
                &jobs,
                &job_id,
                &token,
                |_| {},
                OnnxBackend::load,
            )
            .expect("real enhancement must succeed");
            let decoded = image::open(&result.file_path)
                .expect("output decodes")
                .into_rgba8();
            (result, decoded)
        };

        // 2× target: half the pixels of 4×, same aspect, real output.
        let (r2, img2) = run(EnhanceMode::Standard, 2);
        assert_eq!((r2.width, r2.height), (128 * 2, 96 * 2));
        assert_eq!((img2.width(), img2.height()), (128 * 2, 96 * 2));
        assert!(r2.label.contains("2×"));
        let (r4, img4) = run(EnhanceMode::Standard, 4);
        assert_eq!((r4.width, r4.height), (128 * 4, 96 * 4));

        // Natural runs a *different model* — its output must differ from
        // Standard on the same source (identical bytes would mean the
        // mode is a lie).
        let (rn, img_nat) = run(EnhanceMode::Natural, 4);
        assert!(rn.label.contains("4× · Natural"));
        let same_as_standard = img4.pixels().zip(img_nat.pixels()).all(|(a, b)| a.0 == b.0);
        assert!(
            !same_as_standard,
            "Natural must produce genuinely different pixels than Standard"
        );

        // Detail = Standard + the real unsharp pass: edge columns gain
        // contrast (measured on the checkerboard transitions), and its
        // output differs from Standard everywhere edges exist.
        let (rd, img_det) = run(EnhanceMode::Detail, 4);
        assert!(rd.label.contains("4× · Detail"));
        assert_ne!(
            img4.as_raw(),
            img_det.as_raw(),
            "Detail must produce genuinely different pixels than Standard"
        );
        // Edge contrast check at a known checkerboard boundary: sample a
        // bright/dark pair either side of a vertical edge at x=63/64.
        let lum =
            |p: &image::Rgba<u8>| 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32;
        let y = 48 * 4; // mid-row in output space
        let std_edge = (lum(img4.get_pixel(63 * 4, y)) - lum(img4.get_pixel(64 * 4, y))).abs();
        let det_edge =
            (lum(img_det.get_pixel(63 * 4, y)) - lum(img_det.get_pixel(64 * 4, y))).abs();
        assert!(
            det_edge >= std_edge * 0.9,
            "Detail edges ({det_edge}) should be at least as strong as Standard ({std_edge})"
        );
    }
}
