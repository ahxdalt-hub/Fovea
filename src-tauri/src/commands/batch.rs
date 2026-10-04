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
//!   The relay is also where the free plan's monthly meter is charged:
//!   one credit per item that actually completed, never per item queued.
//! - **The plan gate.** Every queued recipe is checked against the
//!   license in force before the first file opens, and the queue must fit
//!   this month's remaining credits whole. A batch is one intention;
//!   half of it silently running on a downgraded recipe would be a lie.

use std::sync::Mutex;
use std::sync::mpsc;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::commands::inference::EngineState;
use crate::error::{AppError, AppResult};
use crate::services::batch::{
    self, BatchEngine, BatchEvent, BatchItemState, BatchOutputConfig, BatchSession, BatchSnapshot,
    BatchSource,
};
use crate::services::export::{self, ExportFormat};
use crate::services::history::Store as HistoryStore;
use crate::services::import;
use crate::services::inference::finish::Filter;
use crate::services::inference::model::EnhanceMode;
use crate::services::license;

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
    pub filter: String,
    pub intensity: u8,
}

/// Where and how results are written. `folder: ""` selects Fovea's
/// own batch folder (`Documents/Fovea/Batch`).
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

    // Stage 20: the plan gate. Read once here (a key verify, not a job),
    // applied per item in the validation pass below, and charged per
    // completed item by the event relay. This is the whole enforcement —
    // `services::batch` and the engine know nothing about editions.
    let app_data = crate::commands::license::app_data(&app)?;
    let entitlement = license::entitlement(&app_data);

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
        crate::commands::export::default_batch_export_dir(&app)?
            .to_string_lossy()
            .into_owned()
    } else {
        output.folder.clone()
    };
    // Remembered for the "open the batch folder" action: the reveal path
    // is this side's own record, never one the client names.
    crate::commands::export::remember(
        &app,
        crate::commands::export::ExportRecord {
            folder: std::path::PathBuf::from(&folder),
            file: None,
        },
    );
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
            let filter =
                Filter::from_key(&item.filter).ok_or_else(|| AppError::UnsupportedFormat {
                    detail: format!("unknown finishing filter {:?}", item.filter),
                })?;
            if item.scale == 0 {
                return Err(AppError::UnsupportedScale {
                    detail: "zero scale".into(),
                });
            }
            // Locked ingredients refuse the whole run. Dropping the
            // offending files instead would report a batch that quietly
            // did something other than what was asked.
            if item.scale > license::FREE_MAX_SCALE {
                entitlement.require(license::Feature::Upscale4x)?;
            }
            if mode != EnhanceMode::Standard {
                entitlement.require(license::Feature::AdvancedRestoration)?;
            }
            if filter == Filter::Portrait {
                entitlement.require(license::Feature::FaceEnhancement)?;
            }
            // Validate cheaply: existence + format + pixel/byte limits,
            // header-only (a batch can be hundreds of files, and decoding
            // all of them before the first item runs is minutes of dead
            // air). A file that passes the gate and then fails to decode
            // reports that failure as its own batch item.
            let path = std::path::Path::new(&item.path);
            match import::validate_source(path) {
                Ok(_) => sources.push(BatchSource {
                    image_id: item.path.clone(),
                    path: item.path,
                    name: item.name,
                    settings: batch::BatchSettings {
                        mode,
                        scale: item.scale,
                        filter,
                        intensity: item.intensity,
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
        // This month's remaining credits must cover the queue *whole*.
        // Starting 12 files on 5 credits and stopping at 5 would leave the
        // user with a half-run queue and no explanation until they read
        // the items; refusing up front says what is actually true.
        entitlement.check(sources.len() as u32)?;
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
        let meter = entitlement.clone();
        std::thread::Builder::new()
            .name("fovea-batch-relay".into())
            .spawn(move || {
                for event in rx {
                    // One credit per image actually written. Failed and
                    // cancelled items never reach this line as a spend,
                    // so a queue that half-ran charged for half a batch.
                    if matches!(event, BatchEvent::Completed { .. }) {
                        if let Err(err) = meter.spend(1) {
                            log::warn!("monthly meter could not be recorded: {}", err.code());
                        }
                    }
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
///
/// Stage 20: a retry is new processing, so it is metered like a new batch.
/// The recipes already passed the plan gate at start (a retry cannot
/// introduce a locked option), so only the month's remaining credits are
/// re-checked here — and the queue's original relay still charges each
/// item that completes, retry included.
#[tauri::command]
pub async fn retry_batch_failed(app: AppHandle) -> AppResult<Option<BatchSnapshot>> {
    let state = app.state::<BatchState>();
    let handle = {
        let slot = state
            .session
            .lock()
            .map_err(|_| AppError::unexpected("batch state poisoned"))?;
        slot.as_ref().map(|session| session.handle().clone())
    };
    let Some(handle) = handle else {
        return Ok(None);
    };
    let requeued = handle
        .snapshot()
        .items
        .iter()
        .filter(|item| {
            matches!(
                item.state,
                BatchItemState::Failed | BatchItemState::Cancelled
            )
        })
        .count();
    if requeued > 0 {
        let entitlement = license::entitlement(&crate::commands::license::app_data(&app)?);
        entitlement.check(requeued as u32)?;
    }
    handle.retry_failed();
    Ok(Some(handle.snapshot()))
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
