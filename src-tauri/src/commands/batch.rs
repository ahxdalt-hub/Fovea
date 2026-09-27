//! Batch queue commands (Stage 08 queue, wired for Stage 09).
//!
//! Same thin-entry-point rule as every other command module: validate,
//! resolve state, spawn, map failures. All queue logic lives in
//! `services::batch`.
//!
//! What the command layer owns:
//! - **One session at a time.** A new batch replaces the old session
//!   wholesale; the previous worker is cooperatively shut down and its
//!   committed files stay exactly where they were.
//! - **The trust boundary.** Every queued path goes through the real
//!   import ladder first; a stale or unreadable file is dropped from the
//!   run (and reported by the UI comparing what it sent to what the
//!   snapshot returned), never smuggled into the worker.
//! - **The busy contract.** The engine's single job slot is shared with
//!   manual Enhance (Stage 05/07 memory rule): a second concurrent run
//!   is refused honestly, never queued invisibly.
//! - **The event relay.** The queue's sync channel drains into the
//!   webview `Channel` on its own thread; a closed window stops the
//!   relay, not the work — items finish to disk and the journal anyway.

use std::sync::Mutex;
use std::sync::mpsc;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::commands::inference::EngineState;
use crate::error::{AppError, AppResult};
use crate::services::batch::{
    self, BatchEngine, BatchEvent, BatchOutputConfig, BatchSession, BatchSnapshot, BatchSource,
};
use crate::services::export::{self, ExportFormat};
use crate::services::history::Store as HistoryStore;
use crate::services::import;
use crate::services::inference::model::EnhanceMode;

/// The queue session slot. `None` until the first batch starts.
pub struct BatchState {
    pub session: Mutex<Option<BatchSession>>,
}

/// One queued image as the client describes it. `path` is the
/// collection's canonical id — the same string `ImportedImageDto.id`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItemArg {
    pub path: String,
    pub name: String,
    pub scale: usize,
    pub mode: String,
}

/// Where and how results are written. `folder: ""` selects Pixora's
/// default batch export folder (app-data `exports/batch/`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchConfigArg {
    pub folder: String,
    pub format: String,
    pub quality: u8,
}

/// Start (or replace) the batch queue. Streams item events into
/// `on_event` and returns the initial snapshot so the UI can render the
/// full queue before the first event lands.
#[tauri::command]
pub async fn start_batch(
    app: AppHandle,
    items: Vec<BatchItemArg>,
    output: BatchConfigArg,
    on_event: Channel<BatchEvent>,
) -> AppResult<BatchSnapshot> {
    if items.is_empty() {
        return Err(AppError::FileMissing {
            detail: "empty batch".into(),
        });
    }
    if items.len() > batch::MAX_BATCH_ITEMS {
        return Err(AppError::FileTooLarge {
            detail: format!(
                "batch of {} items rejected (max {})",
                items.len(),
                batch::MAX_BATCH_ITEMS
            ),
        });
    }
    let format =
        ExportFormat::from_key(&output.format).ok_or_else(|| AppError::UnsupportedFormat {
            detail: format!("unknown export format {:?}", output.format),
        })?;

    // Resolve handles and validate paths off the async executor thread —
    // `import_one` decodes pixels.
    let engine_state = app.state::<EngineState>();
    // The single engine slot is shared with manual Enhance; whoever
    // asks second hears "busy" honestly.
    if engine_state.jobs.active_count() > 0 {
        return Err(AppError::InsufficientResources {
            detail: "engine busy".into(),
        });
    }
    let registry = engine_state.registry.clone();
    let jobs = engine_state.jobs.clone();
    let engine_config = engine_state.config;
    let enhanced_out_dir = engine_state.out_dir.clone();
    let history = app.state::<std::sync::Arc<HistoryStore>>().inner().clone();
    let batch_state = app.state::<BatchState>();
    // Refuse a *running* previous batch — replacing it would abandon
    // live work. A drained/retired session is replaced silently.
    {
        let slot = batch_state
            .session
            .lock()
            .map_err(|_| AppError::unexpected("batch state poisoned"))?;
        if let Some(old) = slot.as_ref() {
            if old.is_running() {
                return Err(AppError::InsufficientResources {
                    detail: "a batch is already running".into(),
                });
            }
        }
    }

    let folder = if output.folder.is_empty() {
        default_batch_export_dir(&app)?
            .to_string_lossy()
            .into_owned()
    } else {
        output.folder.clone()
    };
    let config = BatchOutputConfig {
        folder,
        format,
        quality: export::normalize_quality(output.quality),
    };
    let (session, snapshot) = tauri::async_runtime::spawn_blocking(move || {
        // Validate every path through the production import ladder.
        // Failures drop out of the run (the UI reports them per file);
        // if nothing survives, the whole start is refused.
        let mut sources = Vec::with_capacity(items.len());
        for item in items {
            let mode =
                EnhanceMode::from_key(&item.mode).ok_or_else(|| AppError::UnsupportedFormat {
                    detail: format!("unknown enhancement mode {:?}", item.mode),
                })?;
            if item.scale == 0 {
                return Err(AppError::UnsupportedScale {
                    detail: "zero scale".into(),
                });
            }
            // Validate cheaply: existence + format + pixel/byte limits
            // via `decode_validated` — no preview bytes built (a batch can
            // be hundreds of files; the collection's canonical id is
            // already this exact path, so re-deriving it is pointless).
            let path = std::path::Path::new(&item.path);
            match import::decode_validated(path) {
                Ok(_) => sources.push(BatchSource {
                    image_id: item.path.clone(),
                    path: item.path,
                    name: item.name,
                    settings: batch::BatchSettings {
                        mode,
                        scale: item.scale,
                    },
                }),
                Err(e) => {
                    log::warn!("batch item rejected at validation: {}", e.code());
                }
            }
        }
        if sources.is_empty() {
            return Err(AppError::FileMissing {
                detail: "no valid files in batch".into(),
            });
        }
        let engine = std::sync::Arc::new(BatchEngine {
            registry,
            jobs,
            config: engine_config,
            out_dir: enhanced_out_dir,
            history,
        });
        let (tx, rx) = mpsc::sync_channel::<BatchEvent>(256);
        let (session, snapshot) = batch::start_batch(
            sources,
            config,
            engine,
            tx,
            std::sync::Arc::new(batch::enhance_item_onnx),
        )?;
        // The event relay lives until every queue-side sender drops —
        // i.e. for this session's whole lifetime, across replacement.
        std::thread::Builder::new()
            .name("pixora-batch-relay".into())
            .spawn(move || {
                for event in rx {
                    if on_event.send(event).is_err() {
                        break; // window gone; the queue drains to disk anyway
                    }
                }
            })
            .map_err(|e| AppError::unexpected(format!("spawn batch relay: {e}")))?;
        Ok((session, snapshot))
    })
    .await
    .map_err(|e| AppError::unexpected(format!("batch start task failed: {e}")))??;

    // Replace the previous (retired) session. Its worker, if any were
    // still running, was refused above — only drained sessions land here.
    let batch_state = app.state::<BatchState>();
    let mut slot = batch_state
        .session
        .lock()
        .map_err(|_| AppError::unexpected("batch state poisoned"))?;
    *slot = Some(session);
    drop(slot);
    Ok(snapshot)
}

/// Pixora's default batch export folder, created on demand.
fn default_batch_export_dir(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::unexpected(format!("app data dir: {e}")))?
        .join("exports")
        .join("batch");
    std::fs::create_dir_all(&dir).map_err(AppError::from)?;
    Ok(dir)
}

/// Cancel one item (mid-run or from the queue). False when the session
/// or item is gone — a harmless no-op from the UI's point of view.
#[tauri::command]
pub async fn cancel_batch_item(app: AppHandle, item_id: String) -> AppResult<bool> {
    let state = app.state::<BatchState>();
    let slot = state
        .session
        .lock()
        .map_err(|_| AppError::unexpected("batch state poisoned"))?;
    Ok(match slot.as_ref() {
        Some(session) => session.handle().cancel_item(&item_id),
        None => false,
    })
}

/// Cancel every item: running ones stop at the tile boundary, waiting
/// ones never run. Committed results are kept — they are the user's work.
#[tauri::command]
pub async fn cancel_batch_all(app: AppHandle) -> AppResult<()> {
    let state = app.state::<BatchState>();
    let slot = state
        .session
        .lock()
        .map_err(|_| AppError::unexpected("batch state poisoned"))?;
    if let Some(session) = slot.as_ref() {
        session.handle().cancel_all();
    }
    Ok(())
}

/// Re-queue failed and cancelled items (fresh runs). Returns the updated
/// snapshot, or `None` when no session exists.
#[tauri::command]
pub async fn retry_batch_failed(app: AppHandle) -> AppResult<Option<BatchSnapshot>> {
    let state = app.state::<BatchState>();
    let slot = state
        .session
        .lock()
        .map_err(|_| AppError::unexpected("batch state poisoned"))?;
    Ok(match slot.as_ref() {
        Some(session) => {
            session.handle().retry_failed();
            Some(session.handle().snapshot())
        }
        None => None,
    })
}

/// The current queue snapshot — for late subscribers (UI re-entry after
/// navigation or an app restart into a still-running batch).
#[tauri::command]
pub async fn get_batch_snapshot(app: AppHandle) -> AppResult<Option<BatchSnapshot>> {
    let state = app.state::<BatchState>();
    let slot = state
        .session
        .lock()
        .map_err(|_| AppError::unexpected("batch state poisoned"))?;
    Ok(slot.as_ref().map(|s| s.handle().snapshot()))
}

/// Cooperative shutdown from the window-event hook: flag the worker so
/// it stops between items and marks unfinished work cancelled; the
/// engine's own slot shutdown (also wired there) releases the job.
pub fn shutdown_batch(app: &AppHandle) {
    if let Some(state) = app.try_state::<BatchState>() {
        if let Ok(slot) = state.session.lock() {
            if let Some(session) = slot.as_ref() {
                session.shutdown_now();
            }
        }
    }
}
