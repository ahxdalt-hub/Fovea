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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::services::inference::backend::{CancelToken, OnnxBackend};
use crate::services::inference::model::{EnhanceMode, ModelRegistry};
use crate::services::inference::service::{
    self, EngineConfig, EnhanceEvent, EnhanceResult, InferenceStatus, JobRegistry,
};

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
#[tauri::command]
pub async fn enhance_image(
    app: AppHandle,
    image_id: String,
    mode: String,
    scale: usize,
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
    if scale == 0 {
        return Err(AppError::UnsupportedScale {
            detail: "zero scale".into(),
        });
    }
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
            if let Ok(result) = &inner {
                // Remember the committed file so export can use it without
                // the client ever naming a path.
                if let Ok(mut map) = state.outputs.lock() {
                    map.insert(result.image_id.clone(), result.file_path.clone());
                }
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
