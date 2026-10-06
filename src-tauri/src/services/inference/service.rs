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
use std::io::{BufWriter, Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine as _;
use image::{DynamicImage, RgbImage};
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::services::hardware::{self, MemoryBudgets};
use crate::services::import;

use super::backend::{Backend, CancelToken, EngineError, GpuPreference};
use super::engine::{self, Plan, RowWriter};
use super::finish::{self, Filter, FilterStatus, Finish, PostPass};
use super::model::{EnhanceMode, ModelRegistry, ModelState, product_scales_for};

/// Largest *output* (in pixels) the engine will attempt. Import allows
/// 64 MP for viewing; the honest cap for enhancement is on the finished
/// frame (decode + encode + disk + the display view all scale with it),
/// which gives each target scale its own input headroom: 16 MP at 4×
/// (as before), 64 MP at 2×. A 256 MP 4× output is where professional
/// usage stops being "reliable" on consumer machines — refuse honestly
/// instead of grinding or crashing.
pub const MAX_ENHANCE_OUTPUT_PIXELS: u64 = 256_000_000;

/// Tile edge / pad / memory configuration for the process. Tile sizes
/// start from `tile` and shrink per plan through [`engine::adaptive_tile`]
/// against `max_tile_bytes`/`max_band_bytes`, so the engine never asks
/// the runtime for more memory than this machine's budget can cover
/// (Stage 07). Defaults come from the one-time hardware snapshot.
#[derive(Debug, Clone, Copy)]
pub struct EngineConfig {
    pub tile: usize,
    pub pad: usize,
    pub max_output_pixels: u64,
    /// Cap on one tile's model-output float buffer (hardware-budgeted).
    pub max_tile_bytes: usize,
    /// Cap on one composited output band buffer (hardware-budgeted).
    pub max_band_bytes: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        let hw = hardware::detect();
        // Match what the job ladder will actually do: forced-CPU or no
        // DX12 adapter → RAM budgets; otherwise the GPU-squeezed ones.
        let budgets = if force_cpu() || hw.acceleration_gpu().is_none() {
            hardware::cpu_only_budgets(hw)
        } else {
            hardware::memory_budgets(hw)
        };
        // QA doors (Stage 07, dev-only like FOVEA_MODELS_DIR):
        // FOVEA_TILE pins the ceiling; FOVEA_BUDGET_MB clamps both
        // budgets to reproduce low-VRAM/low-RAM conditions on a healthy
        // machine — the adaptive shrink and the ladder then run for real.
        let budgets = match std::env::var("FOVEA_BUDGET_MB")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
        {
            Some(mb) if mb >= 1 => MemoryBudgets {
                max_tile_bytes: mb * (1 << 20),
                max_band_bytes: mb * (1 << 20),
            },
            _ => budgets,
        };
        let tile = std::env::var("FOVEA_TILE")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|t| (16..=1024).contains(t))
            .unwrap_or(engine::DEFAULT_TILE);
        EngineConfig::with_budgets(tile, budgets)
    }
}

impl EngineConfig {
    /// Explicit budgets (tests, benchmarks) over the usual defaults.
    pub fn with_budgets(tile: usize, budgets: MemoryBudgets) -> Self {
        EngineConfig {
            tile,
            pad: engine::DEFAULT_PAD,
            max_output_pixels: MAX_ENHANCE_OUTPUT_PIXELS,
            max_tile_bytes: budgets.max_tile_bytes,
            max_band_bytes: budgets.max_band_bytes,
        }
    }

    /// Budgets as reported to diagnostics.
    pub fn budgets(&self) -> MemoryBudgets {
        MemoryBudgets {
            max_tile_bytes: self.max_tile_bytes,
            max_band_bytes: self.max_band_bytes,
        }
    }
}

/// CPU path required for this run: the QA/dev door
/// (`FOVEA_FORCE_CPU=1`, read once so status probing and jobs stay
/// consistent) *or* the user's Settings choice (Stage 10), which is
/// dynamic — flipping it takes effect from the next job onward.
fn force_cpu() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("FOVEA_FORCE_CPU").is_some())
        || crate::services::settings::cpu_only()
}

/// One enhancement result — serialized to the UI (`EnhanceResultDto`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceResult {
    /// The imported image's canonical path (the UI's stable key).
    pub image_id: String,
    /// Fovea's output file — export/save-as works from here.
    pub file_path: PathBuf,
    pub width: u32,
    pub height: u32,
    /// True dimensions of the *source* the job ran on — facts of the
    /// decode plan. Stage 09 history records original/output sizes as
    /// measured numbers, never view-scaled guesses.
    pub source_width: u32,
    pub source_height: u32,
    /// True dimensions of the committed master PNG — identical on both
    /// paths, so the batch view and the history journal share one truth.
    pub output_width: u32,
    pub output_height: u32,
    /// Human label, e.g. "4× · Real-ESRGAN general".
    pub label: String,
    /// Engine device actually used, e.g. "DirectML GPU" | "CPU".
    pub engine: String,
    /// Display-size view of the result (the compare slider's `afterSrc`).
    /// `None` only on the batch path ([`enhance_without_view`]), where no
    /// one ever views the result in the compare slider — building a ~10 MB
    /// base64 string per queued image would be pure waste (Stage 08).
    pub data_url: Option<String>,
}

/// The user-safe error half embedded in outcome payloads. Re-exported
/// here because the batch queue reports per-item failures through the
/// inference vocabulary (`UserError::from(&AppError)` lives on the
/// import side; both paths serialize identically).
pub use crate::services::import::UserError;

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
    /// The device an *attempt* is running on. Emitted once per backend
    /// open and again whenever a retry changes the path (GPU OOM → CPU)
    /// or the tile geometry shrinks — the UI's subtle "on GPU / on CPU"
    /// readout follows the truth, never an assumption.
    Device { device: &'static str, tile: u32 },
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
/// single-slot by design: Fovea Stage 05 runs one enhancement at a time
/// (a second concurrent GPU job would thrash memory and slow both); a
/// busy second request is refused honestly. Stage 08's batch queue keeps
/// the same invariant from the other side: it queues many items, but its
/// single worker drains them through this one slot, one at a time — so
/// an Enhance click and a batch never run on top of each other, and the
/// Stage 07 memory budget (sized for exactly one session) always holds.
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

    /// Live job count — asserted by the service tests, and queried by the
    /// batch command layer to refuse a start while the single engine slot
    /// is held (a batch item and a manual Enhance never share it).
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
    /// Every finishing filter the product offers, in native words. Filters
    /// are pure pixel math on data the engine already holds, so unlike
    /// modes they never depend on an installed model — the list is the
    /// product's full set, and the UI repeats these labels and hints
    /// verbatim instead of keeping its own copy.
    pub filters: Vec<FilterStatus>,
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
    let filters = Filter::ALL
        .iter()
        .copied()
        .map(finish::status_for)
        .collect();
    InferenceStatus {
        device: probe_device(),
        models,
        ready,
        scales,
        modes,
        filters,
        models_dir_display: registry
            .search_dirs()
            .last()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// Which device a newly-created session will land on. `ort` decides per
/// session; the answer is stable for the process, so probe + cache.
/// `FOVEA_FORCE_CPU` short-circuits it (QA door — the probe and the job
/// ladder must agree), and so does the user's Stage 10 "processor" choice
/// — that one is checked per call, so Diagnostics never shows a stale GPU.
pub fn probe_device() -> &'static str {
    static DEVICE: OnceLock<&'static str> = OnceLock::new();
    if crate::services::settings::cpu_only() {
        return "CPU";
    }
    DEVICE.get_or_init(|| {
        if force_cpu() {
            return "CPU";
        }
        use ort::ep::ExecutionProvider;
        super::backend::init_environment();
        match ort::ep::DirectML::default().is_available() {
            Ok(true) => "DirectML GPU",
            _ => "CPU",
        }
    })
}

/// Run one enhancement job to completion. Generic over [`Backend`] so the
/// whole service contract — staging, errors, atomicity, registry, the
/// Stage 07 memory ladder — is tested with a fake runtime; the real one
/// is `OnnxBackend`.
///
/// `mode` selects the enhancement behavior (each one backed by genuinely
/// different processing — see `model::EnhanceMode`); `target` is the
/// product upscale factor, which must be genuinely deliverable by the
/// chosen model (`product_scales_for`), or the job fails honestly before
/// any work starts.
///
/// `filter` + `intensity` are the finishing look applied to the model's
/// output (see [`finish`]); [`Filter::Original`] runs no filter pass at
/// all, so an unfiltered job costs exactly what it did before filters
/// existed.
///
/// `open_backend` is *callable per attempt*: the GPU/CPU path may retry
/// (see [`enhance_inner`]'s ladder). `jobs.begin` must already own
/// registration failure; this function always reaches `jobs.finish`
/// exactly once. `emit` observes every phase transition in order.
#[allow(clippy::too_many_arguments)]
pub fn enhance<B: Backend>(
    source_id: &str,
    mode: EnhanceMode,
    target: usize,
    filter: Filter,
    intensity: u8,
    registry: &ModelRegistry,
    config: &EngineConfig,
    out_dir: &Path,
    jobs: &JobRegistry,
    job_id: &str,
    token: &Arc<CancelToken>,
    emit: impl FnMut(EnhanceEvent),
    open_backend: impl FnMut(&Path, GpuPreference) -> Result<B, EngineError>,
) -> AppResult<EnhanceResult> {
    enhance_with_view(
        true,
        source_id,
        mode,
        target,
        filter,
        intensity,
        registry,
        config,
        out_dir,
        jobs,
        job_id,
        token,
        emit,
        open_backend,
    )
}

/// The batch-path twin of [`enhance`]: identical staging, errors,
/// atomicity, registry and memory ladder — minus the display data URL.
/// A queued image's result lives on disk (and is exported from there);
/// no one compares it in the viewer, so the engine never builds the
/// base64 view. That is Stage 08's memory rule in one function: a batch
/// of many large images stays bounded, per job, with nothing to collect.
#[allow(clippy::too_many_arguments, reason = "engine-call parameter set")]
pub fn enhance_without_view<B: Backend>(
    source_id: &str,
    mode: EnhanceMode,
    target: usize,
    filter: Filter,
    intensity: u8,
    registry: &ModelRegistry,
    config: &EngineConfig,
    out_dir: &Path,
    jobs: &JobRegistry,
    job_id: &str,
    token: &Arc<CancelToken>,
    emit: impl FnMut(EnhanceEvent),
    open_backend: impl FnMut(&Path, GpuPreference) -> Result<B, EngineError>,
) -> AppResult<EnhanceResult> {
    enhance_with_view(
        false,
        source_id,
        mode,
        target,
        filter,
        intensity,
        registry,
        config,
        out_dir,
        jobs,
        job_id,
        token,
        emit,
        open_backend,
    )
}

#[allow(clippy::too_many_arguments)]
fn enhance_with_view<B: Backend>(
    include_view: bool,
    source_id: &str,
    mode: EnhanceMode,
    target: usize,
    filter: Filter,
    intensity: u8,
    registry: &ModelRegistry,
    config: &EngineConfig,
    out_dir: &Path,
    jobs: &JobRegistry,
    job_id: &str,
    token: &Arc<CancelToken>,
    mut emit: impl FnMut(EnhanceEvent),
    open_backend: impl FnMut(&Path, GpuPreference) -> Result<B, EngineError>,
) -> AppResult<EnhanceResult> {
    emit(EnhanceEvent::Preparing {
        job_id: job_id.to_string(),
    });
    match enhance_inner(
        include_view,
        source_id,
        mode,
        target,
        filter,
        intensity,
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
    include_view: bool,
    source_id: &str,
    mode: EnhanceMode,
    target: usize,
    filter: Filter,
    intensity: u8,
    registry: &ModelRegistry,
    config: &EngineConfig,
    out_dir: &Path,
    job_id: &str,
    token: &Arc<CancelToken>,
    emit: &mut dyn FnMut(EnhanceEvent),
    mut open_backend: impl FnMut(&Path, GpuPreference) -> Result<B, EngineError>,
) -> AppResult<EnhanceResult> {
    let source = Path::new(source_id);

    // The same validation ladder import ran — a deleted or mutated file
    // now fails with its right user-safe code, not an engine mystery.
    let (decoded, _size) = import::decode_validated(source)?;
    let pixels = u64::from(decoded.width()) * u64::from(decoded.height());
    let out_pixels = pixels * (target * target) as u64;
    if out_pixels > config.max_output_pixels {
        return Err(AppError::FileTooLarge {
            detail: format!(
                "enhancement output {out_pixels} px exceeds the {} px engine cap",
                config.max_output_pixels
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

    // Flatten to the pipeline's input format. Alpha sources keep their
    // transparency: the mask is nearest-resampled onto the output while
    // the AI restores color.
    let has_alpha = decoded.color().has_alpha();
    let alpha_plane: Option<Vec<u8>> = has_alpha.then(|| {
        let rgba = decoded.to_rgba8();
        rgba.pixels().map(|p| p[3]).collect()
    });
    let rgb: RgbImage = decoded.into_rgb8();

    // Detail is Standard + the engine's real unsharp post-pass. The
    // filter is the user's independent look on top of whichever mode ran
    // (see `finish`): mode decides how the result is read, filter decides
    // what it should feel like.
    let post = match mode {
        EnhanceMode::Detail => PostPass::Sharpen,
        _ => PostPass::None,
    };
    let passes = Finish::for_mode(post, filter, intensity);

    // Atomic output: write `*.part`, rename on success, delete otherwise.
    // The `.part` name is per *attempt* so a failed GPU run can never
    // collide with its own CPU retry mid-write.
    std::fs::create_dir_all(out_dir)?;
    let final_path = out_dir.join(format!("{job_id}.png"));
    let _ = std::fs::remove_file(&final_path);

    // ── The processing ladder (Stage 07) ──────────────────────────────
    //
    //   attempt 1: GPU preferred (unless FOVEA_FORCE_CPU) with the
    //              hardware-derived budgets and an adaptive tile
    //   attempt 2: any GPU-path failure (session build, device removed,
    //              OOM mid-run) drops to the CPU session with a halved
    //              tile ceiling — slower, never fatal
    //   attempt 3: still OOM → halve the ceilings once more
    //   then:      honest `insufficient_resources` — no crash, no silent
    //              quality lie, the output scratch dies clean
    //
    // The process config's budgets stay authoritative throughout (they
    // were derived from hardware at startup); retries only ever *shrink*
    // them. Every failed attempt deletes its `.part`; every retry is
    // logged with the real error text so diagnostics can reconstruct
    // exactly what happened.
    let mut preference = if force_cpu() {
        GpuPreference::CpuOnly
    } else {
        GpuPreference::PreferGpu
    };
    let mut budgets = config.budgets();
    let mut tile_ceiling = config.tile;

    let mut last_oom = String::new();
    for attempt in 0..3 {
        if token.is_cancelled() {
            return Err(AppError::Cancelled {
                detail: "before attempt".into(),
            });
        }
        let backend = match open_backend(&model_path, preference) {
            Ok(b) => b,
            Err(err) => {
                // A GPU *session* failing to build must never be fatal:
                // retry once on CPU. A CPU session failing to build is a
                // genuinely broken runtime — report it.
                match err {
                    EngineError::Cancelled => {
                        return Err(AppError::Cancelled {
                            detail: spec.id.into(),
                        });
                    }
                    EngineError::OutOfMemory(detail) | EngineError::Failed(detail)
                        if preference == GpuPreference::PreferGpu =>
                    {
                        log::warn!("GPU path could not open ({detail}) — continuing on CPU");
                        last_oom = detail;
                        preference = GpuPreference::CpuOnly;
                        tile_ceiling = tile_ceiling.div_ceil(2);
                        continue;
                    }
                    EngineError::OutOfMemory(detail) => {
                        return Err(AppError::InsufficientResources { detail });
                    }
                    EngineError::Failed(detail) => {
                        return Err(AppError::EngineUnavailable { detail });
                    }
                    // A session open never writes pixels; OutOfStorage is
                    // unreachable here, but the honest mapping keeps the
                    // match exhaustive without inventing a retry.
                    EngineError::OutOfStorage(detail) => {
                        return Err(AppError::InsufficientDisk { detail });
                    }
                }
            }
        };
        let mut backend = backend;
        // A "DirectML preferred" session that fell back internally runs on
        // the CPU EP — its budget pool is system RAM, not VRAM. Recompute
        // (clamped, never enlarged beyond the machine's honest quarters).
        if backend.device_name() == "CPU" && preference == GpuPreference::PreferGpu {
            preference = GpuPreference::CpuOnly;
            let cpu = hardware::cpu_only_budgets(hardware::detect());
            let cfg = config.budgets();
            budgets = MemoryBudgets {
                max_tile_bytes: cpu.max_tile_bytes.min(cfg.max_tile_bytes),
                max_band_bytes: cpu.max_band_bytes.min(cfg.max_band_bytes),
            };
        }
        let (tile, _fits) = engine::adaptive_tile(
            rgb.width() as usize,
            spec.scale,
            budgets.max_tile_bytes,
            budgets.max_band_bytes,
            config.pad,
            tile_ceiling,
        );
        let plan = Plan::with_target(
            rgb.width() as usize,
            rgb.height() as usize,
            spec.scale,
            target,
            tile,
            config.pad,
        );
        emit(EnhanceEvent::Device {
            device: backend.device_name(),
            tile: tile as u32,
        });
        let part_path = out_dir.join(format!("{job_id}.a{attempt}.png.part"));
        let _ = std::fs::remove_file(&part_path);
        let outcome = run_pipeline(
            &mut backend,
            &rgb,
            alpha_plane.clone(),
            &plan,
            &passes,
            &part_path,
            token,
            emit,
        );
        match outcome {
            Ok(tee_view) => {
                // Commit, then hand the display view through the viewer
                // contract. A tee-produced view (oversized master) is the
                // honest streaming result; small masters go through the
                // original ladder unchanged.
                if let Err(e) = std::fs::rename(&part_path, &final_path) {
                    let _ = std::fs::remove_file(&part_path);
                    return Err(AppError::unexpected(format!("commit output: {e}")));
                }
                // The master's true dimensions are a fact of the plan, so
                // the viewless (batch) path reports them without building
                // any pixels. `view.width`/`height` are the same numbers.
                let (width, height, data_url) = if include_view {
                    let view = match tee_view {
                        Some(v) => v,
                        None => import::load_image_view(&final_path, import::VIEW_MAX_EDGE)?,
                    };
                    (view.width, view.height, Some(view.data_url))
                } else {
                    (plan.out_w() as u32, plan.out_h() as u32, None)
                };
                return Ok(EnhanceResult {
                    image_id: source_id.to_string(),
                    file_path: final_path,
                    width,
                    height,
                    source_width: plan.src_w as u32,
                    source_height: plan.src_h as u32,
                    output_width: plan.out_w() as u32,
                    output_height: plan.out_h() as u32,
                    label: format!("{target}× · {}", mode.label()),
                    engine: backend.device_name().to_string(),
                    data_url,
                });
            }
            Err(AppError::InsufficientResources { detail }) => {
                // The band or a tile could not be allocated (or the
                // runtime reported OOM). Downgrade the path and shrink:
                // GPU→CPU first, then tighter tile ceilings.
                let _ = std::fs::remove_file(&part_path);
                if preference == GpuPreference::PreferGpu {
                    log::warn!(
                        "GPU run out of memory ({detail}) — continuing on CPU with smaller tiles"
                    );
                    preference = GpuPreference::CpuOnly;
                    tile_ceiling = tile_ceiling.div_ceil(2);
                    last_oom = detail;
                    continue;
                }
                log::warn!("out of memory ({detail}) — retrying with half the tile budget");
                budgets.max_tile_bytes /= 2;
                budgets.max_band_bytes /= 2;
                tile_ceiling = tile_ceiling.div_ceil(2);
                last_oom = detail;
                continue;
            }
            Err(err) => {
                let _ = std::fs::remove_file(&part_path);
                return Err(err);
            }
        }
    }
    Err(AppError::InsufficientResources {
        detail: format!("exhausted memory retries; last: {last_oom}"),
    })
}

/// Log-only identity for a mode's backing model in missing/corrupt detail
/// strings (never crosses the boundary).
fn spec_detail(mode: EnhanceMode, backed: EnhanceMode) -> String {
    format!("{}:{}", mode.key(), backed.key())
}

/// Inference + encoding for one committed output path. Any failure here
/// means the `.part` must die; that cleanup is the caller's job.
/// Returns the master's display view when the output is too large for the
/// classic re-decode path (see [`ViewTee`]) — `None` means "use the
/// original view ladder as before", which only ever happens for masters
/// at or below the display edge.
#[allow(clippy::too_many_arguments)]
fn run_pipeline<B: Backend>(
    backend: &mut B,
    rgb: &RgbImage,
    alpha_plane: Option<Vec<u8>>,
    plan: &Plan,
    passes: &Finish,
    part_path: &Path,
    token: &CancelToken,
    emit: &mut dyn FnMut(EnhanceEvent),
) -> AppResult<Option<import::ImageView>> {
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
    engine::run(
        backend,
        rgb,
        plan,
        passes,
        &mut sink,
        token,
        |done, total| emit(EnhanceEvent::Processing { done, total }),
    )
    .map_err(map_engine_error)?;
    // All tiles done — finishing the encode is the last real phase.
    emit(EnhanceEvent::Completing);
    sink.finish()
}

/// The pipeline's single engine-failure → `AppError` mapping. Disk-space
/// exhaustion gets its own user-visible condition and — structurally, via
/// the ladder's `InsufficientResources`-only retry arms — never triggers a
/// memory-ladder retry: a full disk cannot be fixed by shrinking tiles.
fn map_engine_error(err: EngineError) -> AppError {
    match err {
        EngineError::Cancelled => AppError::Cancelled {
            detail: "tiles".into(),
        },
        EngineError::OutOfMemory(detail) => AppError::InsufficientResources { detail },
        EngineError::OutOfStorage(detail) => AppError::InsufficientDisk { detail },
        EngineError::Failed(detail) => AppError::ProcessingFailed { detail },
    }
}

/// Classify a PNG row-write failure. A full disk is reported as its own
/// condition (`OutOfStorage`), never as a generic engine fault — the
/// Stage 12 rule that a resource failure names its resource. Everything
/// else stays `Failed` with the io text for the log.
fn png_row_error(e: &std::io::Error) -> EngineError {
    match e.kind() {
        std::io::ErrorKind::StorageFull => EngineError::OutOfStorage(e.to_string()),
        _ => EngineError::Failed(format!("png row: {e}")),
    }
}

/// Streaming display view for oversized masters (Stage 07 memory rule:
/// a 256 MP output must never be fully re-decoded just to preview it).
/// Rows arrive top-to-bottom from the encoder; each view pixel is the
/// exact box average of its source block — the same honest resample the
/// engine already uses for 2× targets, done as it streams. Peak extra
/// memory: one accumulator row plus the finished ≤2600-edge image
/// (~27 MB) regardless of master size.
struct ViewTee {
    step: usize,
    /// Master width in pixels — the rightmost view block is partial when
    /// `step` exceeds it (a 12 × 48 000 strip from a 3 px-wide source).
    ow: usize,
    vw: usize,
    ch: usize,
    /// Source columns feeding each view column; constant per column.
    cols: Vec<usize>,
    /// u32 channel sums for the current view-row block.
    acc: Vec<u32>,
    /// Finished view rows, top to bottom.
    out: Vec<u8>,
    /// Source rows counted into the current block.
    rows_in_block: usize,
}

impl ViewTee {
    fn new(out_w: usize, out_h: usize, ch: usize) -> Self {
        let step = out_w.max(out_h).div_ceil(import::VIEW_MAX_EDGE as usize);
        let step = step.max(2); // a tee exists only when downscaling is real
        // Ceil, never floor: a partial edge block still produces a view
        // column, averaging only the pixels that exist. Flooring (and
        // clamping to 1) made the single column of an extreme-aspect master
        // read `step` pixels out of a narrower row — a panic mid-encode.
        let vh = out_h.div_ceil(step).max(1);
        let cols: Vec<usize> = (0..out_w.div_ceil(step).max(1))
            .map(|vx| (out_w - vx * step).min(step))
            .collect();
        let vw = cols.len();
        ViewTee {
            step,
            ow: out_w,
            vw,
            ch,
            cols,
            acc: vec![0u32; vw * ch],
            out: Vec::with_capacity(vw * vh * ch),
            rows_in_block: 0,
        }
    }
    fn push_row(&mut self, rgb: &[u8], alpha: Option<&[u8]>) {
        debug_assert!(rgb.len() >= self.ow * 3);
        let mut src = 0usize;
        for vx in 0..self.vw {
            let n = self.cols[vx];
            let a = &mut self.acc[vx * self.ch..][..self.ch];
            for px in rgb[src * 3..(src + n) * 3].chunks_exact(3) {
                for c in 0..3 {
                    a[c] += px[c] as u32;
                }
            }
            if self.ch == 4 {
                let asum = &mut a[3];
                for av in alpha.unwrap()[src..src + n].iter() {
                    *asum += *av as u32;
                }
            }
            src += n;
        }
        self.rows_in_block += 1;
        if self.rows_in_block == self.step {
            self.flush_block();
        }
    }

    fn flush_block(&mut self) {
        let rows = self.rows_in_block.max(1);
        let vw = self.vw;
        let ch = self.ch;
        for vx in 0..vw {
            let denom = (self.cols[vx] * rows) as u32;
            for c in 0..ch {
                let i = vx * ch + c;
                let v = self.acc[i];
                self.out.push(((v + denom / 2) / denom).min(255) as u8);
            }
        }
        self.acc.iter_mut().for_each(|v| *v = 0);
        self.rows_in_block = 0;
    }

    /// Finish and return (view_bytes, view_w, view_h, channels).
    fn finish(mut self) -> (Vec<u8>, usize, usize, usize) {
        if self.rows_in_block > 0 {
            self.flush_block();
        }
        let vh = self.out.len() / (self.vw * self.ch);
        (self.out, self.vw, vh, self.ch)
    }
}

/// Streaming PNG sink: one row in, compressed bytes out — the full frame
/// is never materialized. RGB sources encode as Rgb8 PNG; sources that
/// had alpha re-attach it via nearest sampling (alpha is a coverage mask;
/// "sharpening" it would invent transparency). Masters larger than the
/// display edge accumulate a [`ViewTee`] on the way through, so the
/// compare view exists without ever re-decoding the giant file.
struct PngSink {
    stream: Option<png::StreamWriter<'static, BufWriter<File>>>,
    alpha: Option<Vec<u8>>,
    src_w: usize,
    scale: usize,
    out_w: usize,
    out_h: usize,
    rows_written: usize,
    row_buf: Vec<u8>,
    tee: Option<ViewTee>,
    /// Scratch row holding the master's per-pixel alpha (alpha sources
    /// only) so the tee averages exactly what was written.
    alpha_row: Vec<u8>,
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
        let has_alpha = alpha.is_some();
        let mut encoder = png::Encoder::new(w, out_w, out_h);
        encoder.set_color(if has_alpha {
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
        let tee = if out_w.max(out_h) > import::VIEW_MAX_EDGE {
            Some(ViewTee::new(
                out_w as usize,
                out_h as usize,
                if has_alpha { 4 } else { 3 },
            ))
        } else {
            None
        };
        Ok(PngSink {
            stream: Some(stream),
            alpha,
            src_w,
            scale: scale.max(1),
            out_w: out_w as usize,
            out_h: out_h as usize,
            rows_written: 0,
            row_buf: Vec::new(),
            tee,
            alpha_row: Vec::new(),
        })
    }

    /// Finish the PNG stream; for oversized masters also return the
    /// display view (see [`ViewTee`]).
    fn finish(&mut self) -> AppResult<Option<import::ImageView>> {
        if let Some(stream) = self.stream.take() {
            stream
                .finish()
                .map_err(|e| AppError::unexpected(format!("png finish: {e}")))?;
        }
        let Some(tee) = self.tee.take() else {
            return Ok(None);
        };
        let (bytes, vw, vh, ch) = tee.finish();
        let image = if ch == 4 {
            let img = image::RgbaImage::from_raw(vw as u32, vh as u32, bytes)
                .ok_or_else(|| AppError::unexpected("view buffer geometry"))?;
            DynamicImage::ImageRgba8(img)
        } else {
            let img = image::RgbImage::from_raw(vw as u32, vh as u32, bytes)
                .ok_or_else(|| AppError::unexpected("view buffer geometry"))?;
            DynamicImage::ImageRgb8(img)
        };
        let mut out = Cursor::new(Vec::new());
        image
            .write_to(&mut out, image::ImageFormat::Png)
            .map_err(|e| AppError::unexpected(format!("view encode png: {e}")))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(out.into_inner());
        Ok(Some(import::ImageView {
            width: self.out_w as u32,
            height: self.out_h as u32,
            delivered_edge: (vw as u32).max(vh as u32),
            original: false,
            data_url: format!("data:image/png;base64,{b64}"),
        }))
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
                self.alpha_row.clear();
                for (x, px) in rgb.chunks_exact(3).enumerate() {
                    self.row_buf.extend_from_slice(px);
                    let sx = (x / self.scale).min(self.src_w - 1);
                    let a = plane[src_y * self.src_w + sx];
                    self.row_buf.push(a);
                    self.alpha_row.push(a);
                }
                stream.write_all(&self.row_buf)
            }
        };
        result.map_err(|e| png_row_error(&e))?;
        if let Some(tee) = self.tee.as_mut() {
            tee.push_row(rgb, (!self.alpha_row.is_empty()).then_some(&self.alpha_row));
        }
        self.rows_written += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::inference::backend::TileOutput;
    use crate::services::inference::finish::DEFAULT_INTENSITY;
    use crate::services::inference::model::ModelSpec;
    use image::{ImageFormat, Rgba, RgbaImage};

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
        let dir = std::env::temp_dir().join(format!("fovea-enhance-{}-{tag}", std::process::id()));
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
            Filter::Original,
            DEFAULT_INTENSITY,
            &registry,
            &config,
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |e| events.push(e),
            |_, _| Ok(Fake2x),
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
        assert!(
            result
                .data_url
                .as_deref()
                .is_some_and(|u| u.starts_with("data:image/png;base64,"))
        );
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
                EnhanceEvent::Device { .. } => "device",
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

    /// Stage 08: the batch path runs the identical job with one thing
    /// removed — no display view is built. The master still commits at
    /// plan geometry; the base64 view (which the batch UI never shows)
    /// stays `None` instead of costing a decode + ~10 MB per image.
    #[test]
    fn viewless_job_writes_the_master_without_building_a_view() {
        let (root, models_dir, out_dir) = harness("viewless");
        let source = source_png(&root, "photo.png", 90, 45, false);
        let registry = registry_with(&models_dir, &fake_spec());
        let jobs = JobRegistry::new();
        let token = Arc::new(CancelToken::new());
        let job_id = jobs.next_job_id();
        jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
        let mut events = Vec::new();
        let result = enhance_without_view(
            &source.to_string_lossy(),
            EnhanceMode::Standard,
            2,
            Filter::Original,
            DEFAULT_INTENSITY,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |e| events.push(e),
            |_, _| Ok(Fake2x),
        )
        .expect("viewless enhance succeeds");
        assert!(result.data_url.is_none(), "no view on the batch path");
        assert_eq!((result.width, result.height), (180, 90), "plan geometry");
        assert_eq!(events.last().map(phase), Some("completed"));
        let decoded = image::open(&result.file_path).expect("committed master decodes");
        assert_eq!((decoded.width(), decoded.height()), (180, 90));
        assert_eq!(jobs.active_count(), 0, "job slot released");
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
            Filter::Original,
            DEFAULT_INTENSITY,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |e| events.push(e),
            |_, _| Ok(Fake2x),
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
            Filter::Original,
            DEFAULT_INTENSITY,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |_| {},
            |_, _| Ok(Fake2x),
        )
        .expect_err("must fail");
        assert_eq!(err.code(), "model_corrupt");
        assert_eq!(jobs.active_count(), 0);
    }

    #[test]
    fn oversized_output_is_refused_before_the_engine_runs() {
        // A 600×300 source at 2× → 360K output px. With the cap at 100K,
        // the job must fail as file_too_large without touching the runtime.
        let (result, events, _root, _jobs, _) = run_job(
            "oversize",
            600,
            false,
            None,
            None,
            EngineConfig {
                max_output_pixels: 100_000,
                ..Default::default()
            },
        );
        let err = result.expect_err("must fail");
        assert_eq!(err.code(), "file_too_large");
        assert!(matches!(events.last(), Some(EnhanceEvent::Failed { .. })));
    }

    /// Stage 07: the cap gates the *output*, not the input — so a source
    /// that would bust the cap at 4× is fine at 2× (and vice versa).
    #[test]
    fn the_cap_measures_output_pixels_not_input() {
        // 600×300 = 180K input, 2× → 720K output. A 800K cap passes it,
        // a 700K cap refuses it: the *same source* flips verdict on the
        // *target*, which is the rule.
        let (ok, _e, _r, _j, _t) = run_job(
            "cap-pass",
            600,
            false,
            None,
            None,
            EngineConfig {
                max_output_pixels: 800_000,
                ..Default::default()
            },
        );
        assert!(ok.is_ok(), "720K output ≤ 800K cap must run");
        let (no, _e, _r, _j, _t) = run_job(
            "cap-fail",
            600,
            false,
            None,
            None,
            EngineConfig {
                max_output_pixels: 700_000,
                ..Default::default()
            },
        );
        assert_eq!(no.expect_err("must fail").code(), "file_too_large");
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
            Filter::Original,
            DEFAULT_INTENSITY,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |_| {},
            |_, _| Err::<Fake2x, EngineError>(EngineError::Failed("dml device removed".into())),
        )
        .expect_err("must fail");
        assert_eq!(err.code(), "engine_unavailable");
        assert_eq!(jobs.active_count(), 0);
    }

    // ── Stage 07: the GPU→CPU→smaller-tile ladder ────────────────────

    /// A backend whose behavior depends on which path opened it: the GPU
    /// persona can OOM its first tile (a runtime losing the VRAM fight),
    /// the CPU persona always works. One type serves both ladder attempts
    /// because `enhance` is generic over a *single* `B: Backend`.
    struct LadderBackend {
        device: &'static str,
        fail_first: bool,
        fired: bool,
    }

    impl Backend for LadderBackend {
        fn device_name(&self) -> &'static str {
            self.device
        }
        fn run_tile(
            &mut self,
            chw: Vec<f32>,
            width: usize,
            height: usize,
            cancel: &CancelToken,
        ) -> Result<TileOutput, EngineError> {
            if self.fail_first && !self.fired {
                self.fired = true;
                return Err(EngineError::OutOfMemory("DML: out of memory".into()));
            }
            FakeScale { scale: 2 }.run_tile(chw, width, height, cancel)
        }
    }

    #[test]
    fn gpu_open_failure_retries_on_cpu_and_completes() {
        let (root, models_dir, out_dir) = harness("ladder-open");
        let source = source_png(&root, "photo.png", 40, 20, false);
        let registry = registry_with(&models_dir, &fake_spec());
        let jobs = JobRegistry::new();
        let token = Arc::new(CancelToken::new());
        let job_id = jobs.next_job_id();
        jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
        let mut prefs = Vec::new();
        let result = enhance(
            &source.to_string_lossy(),
            EnhanceMode::Standard,
            2,
            Filter::Original,
            DEFAULT_INTENSITY,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |_| {},
            |_, pref| {
                prefs.push(pref);
                match pref {
                    GpuPreference::PreferGpu => {
                        Err::<Fake2x, EngineError>(EngineError::Failed("no DX12 driver".into()))
                    }
                    GpuPreference::CpuOnly => Ok(Fake2x),
                }
            },
        )
        .expect("a dead GPU path must fall back, not fail the job");
        assert_eq!(
            prefs,
            vec![GpuPreference::PreferGpu, GpuPreference::CpuOnly]
        );
        assert_eq!(result.engine, "fake"); // the CPU retry produced it
    }

    #[test]
    fn gpu_runtime_oom_mid_run_downgrades_to_cpu_and_completes() {
        let (root, models_dir, out_dir) = harness("ladder-oom");
        let source = source_png(&root, "photo.png", 90, 45, false);
        let registry = registry_with(&models_dir, &fake_spec());
        let jobs = JobRegistry::new();
        let token = Arc::new(CancelToken::new());
        let job_id = jobs.next_job_id();
        jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
        let mut events = Vec::new();
        let mut opens = 0;
        let result = enhance(
            &source.to_string_lossy(),
            EnhanceMode::Standard,
            2,
            Filter::Original,
            DEFAULT_INTENSITY,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |e| events.push(e),
            |_, pref| {
                opens += 1;
                Ok(LadderBackend {
                    device: if pref == GpuPreference::PreferGpu {
                        "gpu-persona"
                    } else {
                        "cpu-persona"
                    },
                    fail_first: pref == GpuPreference::PreferGpu,
                    fired: false,
                })
            },
        )
        .expect("the ladder must complete on the CPU retry");
        assert_eq!(opens, 2, "gpu attempt, then cpu retry");
        assert_eq!(result.engine, "cpu-persona");
        let devices: Vec<(&'static str, u32)> = events
            .iter()
            .filter_map(|e| match e {
                EnhanceEvent::Device { device, tile } => Some((*device, *tile)),
                _ => None,
            })
            .collect();
        assert_eq!(devices.len(), 2, "one Device event per attempt");
        assert_eq!(devices[0].0, "gpu-persona");
        assert_eq!(devices[1].0, "cpu-persona");
        assert_eq!(
            devices[1].1 * 2,
            devices[0].1,
            "the retry runs with a halved tile ceiling: {:?} → {:?}",
            devices[0].1,
            devices[1].1
        );
        // The failed attempt's scratch died; only the committed PNG remains.
        let parts: Vec<_> = std::fs::read_dir(&out_dir)
            .expect("dir")
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "part"))
            .collect();
        assert!(
            parts.is_empty(),
            "no .part leftovers from the failed GPU run"
        );
    }

    /// A GPU-preferred *open* that internally settled on the CPU (the
    /// device name is the CPU's own — what `OnnxBackend::load_with` does
    /// when the DirectML session can't be built) must simply run: budget
    /// recomputation is internal, the job never fails over it.
    #[test]
    fn internally_settled_cpu_session_runs_without_a_visible_retry() {
        let (root, models_dir, out_dir) = harness("ladder-settled");
        let source = source_png(&root, "photo.png", 40, 20, false);
        let registry = registry_with(&models_dir, &fake_spec());
        let jobs = JobRegistry::new();
        let token = Arc::new(CancelToken::new());
        let job_id = jobs.next_job_id();
        jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
        let mut events = Vec::new();
        let mut opens = 0;
        let result = enhance(
            &source.to_string_lossy(),
            EnhanceMode::Standard,
            2,
            Filter::Original,
            DEFAULT_INTENSITY,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |e| events.push(e),
            |_, _| {
                opens += 1;
                Ok(LadderBackend {
                    device: "CPU", // reports the CPU name on a PreferGpu open
                    fail_first: false,
                    fired: false,
                })
            },
        )
        .expect("a settled session must just run");
        assert_eq!(opens, 1, "no retry for a healthy settled session");
        assert_eq!(result.engine, "CPU");
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, EnhanceEvent::Device { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn exhausted_memory_retries_report_honestly_and_clean_up() {
        let (root, models_dir, out_dir) = harness("ladder-exhausted");
        let source = source_png(&root, "photo.png", 60, 30, false);
        let registry = registry_with(&models_dir, &fake_spec());
        let jobs = JobRegistry::new();
        let token = Arc::new(CancelToken::new());
        let job_id = jobs.next_job_id();
        jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
        let mut events = Vec::new();
        let err = enhance(
            &source.to_string_lossy(),
            EnhanceMode::Standard,
            2,
            Filter::Original,
            DEFAULT_INTENSITY,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |e| events.push(e),
            |_, _| {
                Ok(LadderBackend {
                    device: "always-oom",
                    fail_first: true, // every attempt dies on its first tile
                    fired: false,
                })
            },
        )
        .expect_err("must fail as resource exhaustion");
        assert_eq!(err.code(), "insufficient_resources");
        assert!(matches!(events.last(), Some(EnhanceEvent::Failed { .. })));
        let devices = events
            .iter()
            .filter(|e| matches!(e, EnhanceEvent::Device { .. }))
            .count();
        assert_eq!(devices, 3, "every attempt announced its path");
        assert_eq!(jobs.active_count(), 0);
        assert_eq!(
            std::fs::read_dir(&out_dir).map(|d| d.count()).unwrap_or(0),
            0,
            "no files of any kind survive an exhausted ladder"
        );
    }

    #[test]
    fn repeated_runs_commit_fresh_results_without_scratch_leaks() {
        let (root, models_dir, out_dir) = harness("repeat");
        let source = source_png(&root, "photo.png", 60, 30, false);
        let registry = registry_with(&models_dir, &fake_spec());
        for _ in 0..3 {
            let jobs = JobRegistry::new();
            let token = Arc::new(CancelToken::new());
            let job_id = jobs.next_job_id();
            jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
            enhance(
                &source.to_string_lossy(),
                EnhanceMode::Standard,
                2,
                Filter::Original,
                DEFAULT_INTENSITY,
                &registry,
                &EngineConfig::default(),
                &out_dir,
                &jobs,
                &job_id,
                &token,
                |_| {},
                |_, _| Ok(Fake2x),
            )
            .expect("each run must succeed");
        }
        let entries: Vec<_> = std::fs::read_dir(&out_dir)
            .expect("dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries.len(), 3, "one committed result per run");
        assert!(entries.iter().all(|n| n.ends_with(".png")));
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
            Filter::Original,
            DEFAULT_INTENSITY,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |_| {},
            |_, _| -> Result<Fake2x, EngineError> {
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
            Filter::Original,
            DEFAULT_INTENSITY,
            &registry,
            &EngineConfig::default(),
            &out_dir,
            &jobs,
            &job_id,
            &token,
            |_| {},
            |_, _| Ok(Fake2x),
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
    fn view_tee_produces_box_average_display_view_for_oversized_masters() {
        // Drive a PngSink directly: a 6000×3999 master (step = 3 → view
        // 2000×1333). Rows alternate black/white bands exactly 3 tall, so
        // every box block is a pure average of one color — deterministic
        // check without touching ONNX or the file system beyond the .part.
        let dir = scratch("tee");
        let part = dir.join("t.png.part");
        let file = File::create(&part).expect("part file");
        let mut sink = PngSink::new(
            BufWriter::new(file),
            6000,
            3999, // 1333 exact view rows
            None,
            1500,
            4,
        )
        .expect("sink");
        let black = vec![0u8; 6000 * 3];
        let white = vec![255u8; 6000 * 3];
        for r in 0..3999usize {
            let row = if (r / 3) % 2 == 0 { &black } else { &white };
            sink.write_row(row).expect("row");
        }
        let view = sink.finish().expect("finish").expect("tee view");
        assert_eq!((view.width, view.height), (6000, 3999));
        assert_eq!(view.delivered_edge, 2000);
        // Decode the delivered PNG and check pure band averages.
        let raw = base64::engine::general_purpose::STANDARD
            .decode(view.data_url.split_once(',').unwrap().1)
            .expect("b64");
        let img = image::load_from_memory(&raw).expect("view decodes");
        assert_eq!((img.width(), img.height()), (2000, 1333));
        let rgb = img.into_rgb8();
        for (vy, expect) in [0u8, 255, 0, 255].iter().enumerate() {
            let px = rgb.get_pixel(10, vy as u32).0;
            assert_eq!(px, [*expect; 3], "view row {vy}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A 3 px-wide strip upscaled 4× yields a 12 × 48 000 master whose view
    /// block (19 px) is wider than the image itself. The original
    /// floor-based column count asked for 19 pixels out of a 12 pixel row
    /// and panicked inside the PNG encode — killing the job, and in an
    /// abort-profile build, the process.
    #[test]
    fn view_tee_averages_partial_columns_on_an_extreme_aspect_master() {
        let (ow, oh) = (12usize, 48_000usize);
        for ch in [3usize, 4] {
            let mut tee = ViewTee::new(ow, oh, ch);
            assert!(tee.step > ow, "row must be narrower than a block");
            assert_eq!(tee.cols.iter().sum::<usize>(), ow);
            let row = vec![100u8; ow * 3];
            let alpha = vec![200u8; ow];
            let alpha_arg = (ch == 4).then_some(alpha.as_slice());
            for _ in 0..oh {
                tee.push_row(&row, alpha_arg);
            }
            let (bytes, vw, vh, channels) = tee.finish();
            assert_eq!(channels, ch);
            assert_eq!(vw, 1, "one partial column across");
            assert_eq!(vh, 2_527, "ceil of 48 000 rows at step 19");
            assert_eq!(bytes.len(), vw * vh * ch);
            let expected: Vec<u8> = (0..ch).map(|c| if c == 3 { 200 } else { 100 }).collect();
            assert!(
                bytes.chunks(ch).all(|px| px == expected),
                "partial block averages the pixels that exist (ch={ch})"
            );
        }
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

    #[test]
    fn png_row_io_failures_name_the_resource() {
        let full = std::io::Error::from(std::io::ErrorKind::StorageFull);
        assert!(matches!(png_row_error(&full), EngineError::OutOfStorage(_)));
        let other = std::io::Error::other("device hiccup");
        assert!(matches!(png_row_error(&other), EngineError::Failed(_)));
    }

    /// Stage 12: a full disk must end the job as `insufficient_disk` —
    /// never `processing_failed` (a lie about the cause) and never a
    /// memory-ladder retry (shrinking tiles cannot free disk space).
    #[test]
    fn out_of_storage_maps_to_the_disk_condition() {
        let mapped = map_engine_error(EngineError::OutOfStorage("no space".into()));
        assert_eq!(mapped.code(), "insufficient_disk");
        // The memory ladder only retries InsufficientResources; disk stays
        // terminal — asserted structurally by this type distinction.
        assert_ne!(mapped.code(), "insufficient_resources");
    }

    fn phase(e: &EnhanceEvent) -> &'static str {
        match e {
            EnhanceEvent::Preparing { .. } => "preparing",
            EnhanceEvent::Device { .. } => "device",
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
            Filter::Original,
            DEFAULT_INTENSITY,
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
            OnnxBackend::load_with,
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
                Filter::Original,
                DEFAULT_INTENSITY,
                &registry,
                &config,
                &out_dir,
                &jobs,
                &job_id,
                &token,
                |_| {},
                OnnxBackend::load_with,
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

    /// ── Real end-to-end for the Look dropdown ───────────────────────
    ///
    /// Every filter the UI offers, run through the actual ONNX pipeline on
    /// one source at the free plan's 2×: each must complete, each must
    /// change the *written master* relative to Original, and no two may
    /// write the same file. The unit tests in `finish` prove the math; this
    /// proves the math survives tiling, the band resample and the PNG
    /// encode — which is where a look could quietly be dropped.
    ///   cargo test --lib -- --ignored real_filters
    #[test]
    #[ignore = "requires ONNX Runtime binaries + the bundled model file"]
    fn real_filters_each_change_the_written_master_in_their_own_way() {
        use crate::services::inference::backend::OnnxBackend;
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let registry = ModelRegistry::new(vec![manifest.join("models")]);
        let (root, _models, out_dir) = harness("real-filters");
        let source = {
            // A neutral grey ramp (so every tonal claim is measured against
            // a picture with no cast of its own) plus one warm and one cool
            // block, so the saturation looks have colour to act on.
            let mut img = RgbaImage::new(96, 64);
            for (x, y, p) in img.enumerate_pixels_mut() {
                let v = (24.0 + (x as f32 / 95.0) * 208.0) as u8;
                let mut rgb = [v, v, v];
                if (6..22).contains(&y) && (6..34).contains(&x) {
                    rgb = [200, 120, 70];
                } else if (40..58).contains(&y) && (60..88).contains(&x) {
                    rgb = [70, 120, 200];
                }
                *p = Rgba([rgb[0], rgb[1], rgb[2], 255]);
            }
            let mut out = Cursor::new(Vec::new());
            DynamicImage::ImageRgba8(img)
                .write_to(&mut out, ImageFormat::Png)
                .expect("encode");
            let path = root.join("ramp.png");
            std::fs::write(&path, out.into_inner()).expect("write");
            path
        };
        let config = EngineConfig {
            tile: 32,
            pad: 8,
            ..Default::default()
        };

        let run = |filter: Filter| -> image::RgbImage {
            let jobs = JobRegistry::new();
            let token = Arc::new(CancelToken::new());
            let job_id = jobs.next_job_id();
            jobs.begin(&job_id, Arc::clone(&token)).expect("begin");
            let result = enhance(
                &source.to_string_lossy(),
                EnhanceMode::Standard,
                2,
                filter,
                100,
                &registry,
                &config,
                &out_dir,
                &jobs,
                &job_id,
                &token,
                |_| {},
                OnnxBackend::load_with,
            )
            .expect("real enhancement must succeed");
            assert!(jobs.active_count() == 0, "the slot must be released");
            image::open(&result.file_path)
                .expect("output decodes")
                .into_rgb8()
        };

        /// One reading of a written master: the numbers each look claims to
        /// move, measured on the file rather than on the tile buffer.
        #[derive(Debug, Clone, Copy)]
        struct Stats {
            luma: f64,
            warm: f64,
            chroma: f64,
            rough: f64,
            dark_luma: f64,
            dark_warm: f64,
            bright_warm: f64,
        }
        let stats = |img: &image::RgbImage| -> Stats {
            let mut luma = 0f64;
            let mut warm = 0f64;
            let mut chroma = 0f64;
            let mut pixels: Vec<(f64, f64)> = Vec::new();
            for p in img.pixels() {
                let (r, g, b) = (f64::from(p[0]), f64::from(p[1]), f64::from(p[2]));
                let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                luma += l;
                warm += r - b;
                chroma += (r - l).abs() + (g - l).abs() + (b - l).abs();
                pixels.push((l, r - b));
            }
            let n = pixels.len() as f64;
            // Mean absolute neighbour difference per channel: local detail.
            let (w, h) = (img.width() as usize, img.height() as usize);
            let mut rough = 0f64;
            for y in 0..h {
                for x in 1..w {
                    let a = img.get_pixel(x as u32 - 1, y as u32);
                    let b = img.get_pixel(x as u32, y as u32);
                    rough += (f64::from(a[0]) - f64::from(b[0])).abs()
                        + (f64::from(a[1]) - f64::from(b[1])).abs()
                        + (f64::from(a[2]) - f64::from(b[2])).abs();
                }
            }
            pixels.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            let tenth = ((n / 10.0) as usize).max(1);
            let dark: Vec<(f64, f64)> = pixels.iter().take(tenth).copied().collect();
            let bright_warm: f64 =
                pixels.iter().rev().take(tenth).map(|p| p.1).sum::<f64>() / tenth as f64;
            Stats {
                luma: luma / n,
                warm: warm / n,
                chroma: chroma / n,
                rough: rough / (n * 3.0),
                dark_luma: dark.iter().map(|p| p.0).sum::<f64>() / tenth as f64,
                dark_warm: dark.iter().map(|p| p.1).sum::<f64>() / tenth as f64,
                bright_warm,
            }
        };

        let original = run(Filter::Original);
        let mut done: Vec<(Filter, image::RgbImage)> = Vec::new();
        for filter in Filter::ALL {
            let img = if filter == Filter::Original {
                original.clone()
            } else {
                run(filter)
            };
            assert_eq!(img.dimensions(), original.dimensions());
            if filter == Filter::Original {
                assert_eq!(img.as_raw(), original.as_raw());
            } else {
                assert_ne!(
                    img.as_raw(),
                    original.as_raw(),
                    "{filter:?} wrote the same file as Original — the look never reached the master"
                );
                for (other, other_img) in &done {
                    assert_ne!(
                        img.as_raw(),
                        other_img.as_raw(),
                        "{filter:?} and {other:?} wrote identical masters"
                    );
                }
            }
            let s = stats(&img);
            println!(
                "{:>10}  luma {:6.1}  warm {:7.1}  chroma {:6.1}  rough {:7.2}  dark {:6.1}/{:7.1}  hi-warm {:7.1}",
                filter.key(),
                s.luma,
                s.warm,
                s.chroma,
                s.rough,
                s.dark_luma,
                s.dark_warm,
                s.bright_warm
            );
            done.push((filter, img));
        }
        assert_eq!(done.len(), 11);

        let get = |key: &str| -> &image::RgbImage {
            done.iter()
                .find(|(f, _)| f.key() == key)
                .map(|(_, i)| i)
                .expect("filter ran above")
        };
        let base = stats(&original);

        // Full-strength Black & White is monochrome in the *file*, not just
        // in the tile buffer.
        for p in get("mono").pixels() {
            assert!(
                p[0] == p[1] && p[1] == p[2],
                "mono master kept colour: {p:?}"
            );
        }
        // Each look's signature, measured on the written master.
        assert!(
            stats(get("warm")).warm > base.warm,
            "warm master is not warmer"
        );
        assert!(
            stats(get("cool")).warm < base.warm,
            "cool master is not cooler"
        );
        let (natural, vivid) = (stats(get("natural")), stats(get("vivid")));
        assert!(
            natural.chroma > base.chroma,
            "natural did not open the colour"
        );
        assert!(
            vivid.chroma > natural.chroma,
            "vivid must out-saturate natural"
        );
        // Softening must survive the encode: less neighbour variation than
        // the untouched model result.
        assert!(
            stats(get("soft")).rough < base.rough,
            "soft master is no smoother than the original"
        );
        assert!(
            stats(get("sharp")).rough > base.rough,
            "sharp master is not crisper"
        );
        assert!(
            stats(get("product")).rough > base.rough,
            "product clarity did not reach the master"
        );
        let portrait = stats(get("portrait"));
        assert!(portrait.warm > base.warm, "portrait did not warm");
        assert!(portrait.rough < base.rough, "portrait did not soften");
        let filmic = stats(get("cinematic"));
        assert!(
            filmic.dark_luma > base.dark_luma,
            "cinematic must lift the blacks (got {} over {})",
            filmic.dark_luma,
            base.dark_luma
        );
        // The split tone, measured where it is claimed: the ramp's darkest
        // and brightest pixels start neutral, so their red-minus-blue axis
        // must move apart — teal into the shadows, warm into the
        // highlights — instead of the whole frame going one way.
        assert!(
            filmic.dark_warm < base.dark_warm,
            "cinematic shadows must go teal (got {} over {})",
            filmic.dark_warm,
            base.dark_warm
        );
        assert!(
            filmic.bright_warm > base.bright_warm,
            "cinematic highlights must go warm (got {} over {})",
            filmic.bright_warm,
            base.bright_warm
        );
    }
}
