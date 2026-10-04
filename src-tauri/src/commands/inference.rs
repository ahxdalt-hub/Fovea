//! Inference commands (Stage 05, controls in Stage 06) — the native API
//! surface for enhancing.
//!
//! Entry points, thin by rule: validate args, resolve app state, spawn
//! blocking work, map failures. All engine logic lives in
//! `services::inference`.
//!
//! The session is created per job (`OnnxBackend::load`): a 5 MB model
//! loads in well under a second, and a fresh session keeps the
//! failure/teardown story trivial — no stale GPU state to reason about
//! when a job errors or the DirectML device resets. Session pooling is
//! a later-stage optimization with a measured reason.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::services::history::{
    EntryKind, EntryStatus, HistoryEntry, Store as HistoryStore, now_ms,
};
use crate::services::inference::backend::{CancelToken, OnnxBackend};
use crate::services::inference::finish::Filter;
use crate::services::inference::model::{EnhanceMode, ModelRegistry};
use crate::services::inference::service::{
    self, EngineConfig, EnhanceEvent, EnhanceResult, InferenceStatus, JobRegistry,
};
use crate::services::license;

/// Shared engine state, managed at setup and resolved per command.
pub struct EngineState {
    pub registry: Arc<ModelRegistry>,
    pub jobs: Arc<JobRegistry>,
    pub config: EngineConfig,
    /// Where enhanced PNGs are written (app-data `enhanced/`).
    pub out_dir: PathBuf,
    /// Committed native output per image id (export authority): only
    /// paths the engine itself wrote live here, so the export command
    /// never opens a client-invented path.
    pub outputs: Arc<Mutex<HashMap<String, PathBuf>>>,
}

/// Enhance one imported image locally. Runs the job on the blocking pool
/// (decoding + inference are CPU/GPU-heavy, never the UI thread) and
/// streams phase events through `on_event`. Rejects with a user-safe
/// `AppError` when preparation fails; the same terminal phase is
/// announced on the channel so the UI closes its progress promptly.
///
/// Stage 06 args: `mode` ("standard" | "natural" | "detail") selects the
/// genuinely different processing behavior, `scale` (2 | 4) the product
/// upscale factor. Both are validated at the boundary; an unknown mode is
/// refused, never guessed into a default behavior.
///
/// Stage 19 args: `filter` names the finishing look ("original" | … |
/// "portrait") and `intensity` its strength (0-100, clamped). A filter is
/// pure pixel math on the model's own output, so it never needs a model —
/// but an unknown filter key is still refused rather than silently
/// downgraded to "original", because a look the user asked for and did not
/// get is a bug, not a fallback.
///
/// Stage 20: the recipe is checked against the license in force before the
/// job slot is taken (see `services::license` for the policy table), and
/// the free plan's monthly meter is charged when an image is written —
/// never when a job is merely asked for.
#[tauri::command]
pub async fn enhance_image(
    app: AppHandle,
    image_id: String,
    mode: String,
    scale: usize,
    filter: String,
    intensity: u8,
    on_event: Channel<EnhanceEvent>,
) -> AppResult<EnhanceResult> {
    if image_id.is_empty() {
        return Err(AppError::FileMissing {
            detail: "empty image id".into(),
        });
    }
    let mode = EnhanceMode::from_key(&mode).ok_or_else(|| AppError::UnsupportedFormat {
        detail: format!("unknown enhancement mode {mode:?}"),
    })?;
    let filter = Filter::from_key(&filter).ok_or_else(|| AppError::UnsupportedFormat {
        detail: format!("unknown finishing filter {filter:?}"),
    })?;
    if scale == 0 {
        return Err(AppError::UnsupportedScale {
            detail: "zero scale".into(),
        });
    }
    // The plan gate. The engine itself is plan-blind — it would run 4× for
    // anybody — so this boundary is the whole enforcement, and it lands
    // before the job slot is reserved so a locked recipe refuses instead
    // of spinning. One key read plus one signature verify: cheap, and it
    // means no command ever acts on a license picture the UI painted
    // minutes ago.
    let app_data = crate::commands::license::app_data(&app)?;
    let entitlement = license::entitlement(&app_data);
    if scale > license::FREE_MAX_SCALE {
        entitlement.require(license::Feature::Upscale4x)?;
    }
    if mode != EnhanceMode::Standard {
        entitlement.require(license::Feature::AdvancedRestoration)?;
    }
    if filter == Filter::Portrait {
        entitlement.require(license::Feature::FaceEnhancement)?;
    }
    // Ceiling now, charge later: a run that fails, or that the user
    // cancels mid-tile, costs no credit.
    entitlement.check(1)?;
    let state = app.state::<EngineState>();
    let job_id = state.jobs.next_job_id();
    let token = Arc::new(CancelToken::new());
    // Reserve the single job slot *before* spawning: a busy engine
    // refuses honestly, and the UI never sees a half-started run.
    state
        .jobs
        .begin(&job_id, Arc::clone(&token))
        .map_err(AppError::from)?;

    let registry = Arc::clone(&state.registry);
    let jobs = Arc::clone(&state.jobs);
    let config = state.config;
    let out_dir = state.out_dir.clone();
    // History rows keep the source path after the job's copy moves into
    // the blocking task below.
    let source_path = image_id.clone();
    // Clones for the *defensive* release path below: `enhance` always
    // finishes the slot itself, so these only matter if the blocking
    // task panicked before reaching it.
    let jobs_for_cleanup = Arc::clone(&state.jobs);
    let job_id_for_cleanup = job_id.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let emit = |event: EnhanceEvent| {
            // Channel sends can fail if the window closed mid-job; the
            // job still completes/cleans up and the command's promise
            // carries the final truth.
            let _ = on_event.send(event);
        };
        service::enhance(
            &image_id,
            mode,
            scale,
            filter,
            intensity,
            &registry,
            &config,
            &out_dir,
            &jobs,
            &job_id,
            &token,
            emit,
            OnnxBackend::load_with,
        )
    })
    .await;

    match result {
        Ok(inner) => {
            // Stage 09: record the run honestly — completed runs with
            // their true geometry and output location; failed runs with
            // the user-safe message. Cancellations are user-initiated
            // non-events: the journal stays quiet.
            let history = app.state::<Arc<HistoryStore>>().inner().clone();
            let file_name = Path::new(&source_path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| source_path.clone());
            match &inner {
                Ok(result) => {
                    // Remember the committed file so export can use it
                    // without the client ever naming a path — and drop the
                    // master this run replaced. The compare view only ever
                    // shows the latest result per image, so the superseded
                    // PNG is dead weight; a 4× master is tens to hundreds
                    // of MB and app data is not a scratch disk.
                    let previous = state.outputs.lock().ok().and_then(|mut map| {
                        map.insert(result.image_id.clone(), result.file_path.clone())
                    });
                    if let Some(old) = previous.filter(|p| *p != result.file_path) {
                        if let Err(err) = std::fs::remove_file(&old) {
                            log::warn!("superseded master cleanup failed: {err}");
                        }
                    }
                    history.record(HistoryEntry {
                        id: String::new(),
                        source_path: source_path.clone(),
                        file_name,
                        original_width: result.source_width,
                        original_height: result.source_height,
                        output_width: result.output_width,
                        output_height: result.output_height,
                        scale,
                        mode: mode.key().to_string(),
                        status: EntryStatus::Completed,
                        error_message: None,
                        created_at: now_ms(),
                        kind: EntryKind::Single,
                        output_path: Some(result.file_path.to_string_lossy().into_owned()),
                    });
                    // The image exists; now it is counted. A meter that
                    // cannot be written must not undo the user's work —
                    // the spend is logged and the result still returns.
                    if let Err(err) = entitlement.spend(1) {
                        log::warn!("monthly meter could not be recorded: {}", err.code());
                    }
                }
                Err(err) if err.code() != "cancelled" => {
                    history.record(HistoryEntry {
                        id: String::new(),
                        source_path,
                        file_name,
                        // Dimensions the job never got to measure: 0.
                        // The History view shows them as unknown.
                        original_width: 0,
                        original_height: 0,
                        output_width: 0,
                        output_height: 0,
                        scale,
                        mode: mode.key().to_string(),
                        status: EntryStatus::Failed,
                        error_message: Some(err.user_message().to_string()),
                        created_at: now_ms(),
                        kind: EntryKind::Single,
                        output_path: None,
                    });
                }
                Err(_) => {}
            }
            inner
        }
        Err(join_err) => {
            // Join failure: release the slot defensively (enhance always
            // finishes it, but a panic before that would leak busy-ness).
            jobs_for_cleanup.finish(&job_id_for_cleanup);
            log::error!("enhance task failed to complete: {join_err}");
            let panicked = matches!(
                &join_err,
                tauri::Error::JoinError(raw) if raw.is_panic()
            );
            if panicked {
                Err(AppError::unexpected("inference task panicked"))
            } else {
                Err(AppError::ProcessingFailed {
                    detail: format!("task join: {join_err}"),
                })
            }
        }
    }
}

/// Cancel a running enhancement by its job id. Safe after completion —
/// a no-op then. Returns true when a live job received the signal.
#[tauri::command]
pub async fn cancel_enhancement(job_id: String, state: State<'_, EngineState>) -> AppResult<bool> {
    let found = state.jobs.has(&job_id);
    if found {
        state.jobs.cancel(&job_id);
    }
    Ok(found)
}

/// Engine + model readiness for the UI (device, per-model state, the
/// scales and modes the installed models genuinely support).
///
/// Runs off the main thread: the first call initializes the ONNX Runtime
/// environment to probe the DirectML device, which is real work.
#[tauri::command]
pub async fn get_inference_status(app: AppHandle) -> AppResult<InferenceStatus> {
    let registry = app.state::<EngineState>().registry.clone();
    tauri::async_runtime::spawn_blocking(move || service::inference_status(&registry))
        .await
        .map_err(|e| AppError::unexpected(format!("status task failed: {e}")))
}
