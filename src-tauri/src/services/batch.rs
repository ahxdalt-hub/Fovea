//! Batch processing queue (Stage 08).
//!
//! A professional batch is one thing the Stage 05 engine already refuses
//! to do at once — run several enhancements simultaneously — so the queue
//! supplies what the engine lacks: *patience*. Many items, one job at a
//! time, each through the engine's full Stage 07 memory ladder.
//!
//! Design:
//! - **State is the single source of truth.** A [`Mutex<QueueState>`]
//!   holds every item's state; a snapshot is cheap to clone and the
//!   frontend's `batch/sync` action reconciles from it (monotonic
//!   progress, terminal states never overwritten by stale events).
//! - **One worker, strictly sequential.** The engine's memory budget is
//!   sized for a single session and its `JobRegistry` is a single slot,
//!   so two batch items could not run at once even if the queue let them.
//!   The worker is the honest control: a batch of huge images advances
//!   one tile-counted job at a time and can never gradually eat the
//!   machine.
//! - **A failed item never sinks the batch.** Each item reports its own
//!   terminal outcome (completed / failed / cancelled); the worker
//!   advances regardless. Failures are retryable; retries are re-queued
//!   as new runs of the same item.
//! - **Cancellation is cooperative and prompt.** A cancel flips the
//!   item's [`CancelToken`] — the running engine job terminates
//!   mid-tile, waiting items are flagged so the worker skips them — and
//!   "cancel all" covers both cases at once.
//! - **Nothing crosses the worker boundary twice.** Completed items
//!   carry a file reference and metadata — never image bytes. The engine
//!   runs in viewless mode (see `inference::service::enhance_without_view`),
//!   so no display data URL is ever built for a queued image; the webview
//!   keeps showing its own existing small preview for the thumbnail.
//!   This is the whole memory story: per-job working sets peak during
//!   processing and drop at the job boundary, and the queue's steady-state
//!   cost is one `BatchItemDto` per item.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::services::export::{self, ExportFormat};
use crate::services::hardware;
use crate::services::history;
use crate::services::history::{EntryKind, EntryStatus, HistoryEntry, now_ms};
use crate::services::inference::backend::{CancelToken, GpuPreference};
use crate::services::inference::finish::Filter;
use crate::services::inference::model::{EnhanceMode, ModelRegistry};
use crate::services::inference::service::{
    self, EngineConfig, EnhanceEvent, JobRegistry, MAX_ENHANCE_OUTPUT_PIXELS,
};

/// A batch is dozens or hundreds of files, not thousands (the same bound
/// import places on a drop payload).
pub const MAX_BATCH_ITEMS: usize = 500;

/// The five honest states an item moves through. Every transition is
/// driven by a real event — `processing` never appears before the engine
/// says `preparing`, `completed` only after the master file exists and
/// the export landed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BatchItemState {
    /// Queued, no resources touched.
    Waiting,
    /// The worker holds this item; progress events are flowing.
    Processing,
    /// Master committed and exported; an `output` is present.
    Completed,
    /// The run failed with a user-safe error; retry is offered.
    Failed,
    /// The user cancelled this item (mid-run or from the queue).
    Cancelled,
}

/// One enhancement setting for the queue (per-item, shared settings in
/// the UI, but the DTO keeps each item self-describing).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BatchSettings {
    pub mode: EnhanceMode,
    pub scale: usize,
    pub filter: Filter,
    pub intensity: u8,
}

/// The committed artifact of a completed item: everything the UI needs
/// to show the result and open it, without holding image bytes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOutput {
    pub file_path: String,
    pub file_name: String,
    pub folder: String,
    pub bytes: u64,
    /// True source dimensions (facts from the engine's decode plan).
    pub source_width: u32,
    pub source_height: u32,
    /// True master dimensions of the enhanced file.
    pub output_width: u32,
    pub output_height: u32,
    pub label: String,
    pub engine: String,
}

/// Serialized `BatchItem` in the queue snapshot (`BatchItemDto` in TS).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub id: String,
    /// The imported image's canonical path id ("" for a non-imported
    /// path — the UI matches its own collection by it).
    pub image_id: String,
    pub name: String,
    pub state: BatchItemState,
    /// Completed tiles / planned tiles, from the engine — a real
    /// measurement. (0, 0) before the first processing event.
    pub done: u32,
    pub total: u32,
    /// "DirectML GPU" | "CPU" once the engine announces its path;
    /// re-set honestly if a mid-run retry changes it.
    pub device: Option<&'static str>,
    pub error: Option<service::UserError>,
    pub output: Option<BatchOutput>,
    /// The settings this item runs (or ran) with.
    pub mode: &'static str,
    pub scale: usize,
    pub filter: &'static str,
    pub intensity: u8,
    /// True once a cancel has been requested but the item hasn't reached
    /// its terminal `cancelled` state yet (mid-run: the engine is
    /// tearing the attempt down).
    pub cancelling: bool,
}

/// Snapshot handed to the UI on subscribe and after every change that
/// outlives the per-item events (`batch/sync`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSnapshot {
    pub items: Vec<BatchItem>,
    /// True while the worker exists and more work can run.
    pub running: bool,
    /// Worker strategy in effect (1 — see the module docs).
    pub worker_limit: usize,
}

/// Streamed progress events (`BatchEventDto` in TS). One channel, one
/// command, many items: every event names its item id.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BatchEvent {
    /// The engine started this item (the item's `preparing` phase).
    Started { item_id: String },
    /// Completed tiles so far — monotonic per run.
    Progress {
        item_id: String,
        done: u32,
        total: u32,
    },
    /// The device an attempt runs on (re-emitted on a ladder retry).
    Device {
        item_id: String,
        device: &'static str,
    },
    /// The encode-and-export half after the last tile.
    Saving { item_id: String },
    /// All done; the output is committed (full record in the DTO).
    Completed { item_id: String },
    /// This item failed; the batch continues.
    Failed {
        item_id: String,
        code: &'static str,
        message: &'static str,
    },
    /// This item was cancelled (by item or by cancel-all).
    Cancelled { item_id: String },
}

/// The queue's internal item record.
struct Item {
    id: String,
    image_id: String,
    name: String,
    path: PathBuf,
    state: BatchItemState,
    settings: BatchSettings,
    done: u32,
    total: u32,
    device: Option<&'static str>,
    error: Option<service::UserError>,
    output: Option<BatchOutput>,
    cancelling: bool,
    /// Present only while the item runs (set by the worker before the
    /// engine call, dropped right after). Cancel flips it; it is also
    /// the "is anything running" fact for the worker's own accounting.
    token: Option<Arc<CancelToken>>,
}

impl Item {
    fn to_dto(&self) -> BatchItem {
        BatchItem {
            id: self.id.clone(),
            image_id: self.image_id.clone(),
            name: self.name.clone(),
            state: self.state,
            done: self.done,
            total: self.total,
            device: self.device,
            error: self.error.clone(),
            output: self.output.clone(),
            mode: self.settings.mode.key(),
            scale: self.settings.scale,
            filter: self.settings.filter.key(),
            intensity: self.settings.intensity,
            cancelling: self.cancelling,
        }
    }
}

/// The queue's shared state: items in stable order, and the worker's
/// presence (true while items can still run).
struct QueueState {
    items: Vec<Item>,
    running: bool,
}

/// Where results land: `""` means Fovea's default batch-export folder.
#[derive(Debug, Clone)]
pub struct BatchOutputConfig {
    pub folder: String,
    pub format: ExportFormat,
    pub quality: u8,
}

/// Per-source settings for a queued run.
#[derive(Debug, Clone)]
pub struct BatchSource {
    /// The imported image's canonical id ("" if none — non-imported
    /// paths get validated through the import ladder first).
    pub image_id: String,
    pub path: String,
    pub name: String,
    pub settings: BatchSettings,
}

/// Everything the worker needs to run engine jobs: the same handles the
/// Stage 05 command layer holds, bundled once for the batch thread —
/// plus the Stage 09 journal, so completed/failed items are recorded the
/// moment they land, whether or not the webview is watching.
pub struct BatchEngine {
    pub registry: Arc<ModelRegistry>,
    pub jobs: Arc<JobRegistry>,
    pub config: EngineConfig,
    pub out_dir: PathBuf,
    pub history: Arc<history::Store>,
}

/// A live batch: the queue state plus the worker handle. Managed as app
/// state; one exists at a time (the command layer enforces it), and the
/// current instance is replaced when a new batch starts.
pub struct BatchSession {
    handle: BatchHandle,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
}

impl BatchSession {
    /// The queue's live worker handle (cancel / retry / snapshot).
    pub fn handle(&self) -> &BatchHandle {
        &self.handle
    }
    /// True while a worker thread exists and more work can run. The
    /// "already running" gate for starting a new batch.
    pub fn is_running(&self) -> bool {
        !self.shutdown.load(std::sync::atomic::Ordering::SeqCst) && self.handle.snapshot().running
    }
    /// Cooperative shutdown: the worker checks this between items, and
    /// the command layer enforces it with the engine slot itself.
    pub fn shutdown_now(&self) {
        self.shutdown
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The per-item engine runner (production: `enhance_item_onnx`; tests
/// inject a scripted fake). Held by the handle so a retry can restart
/// the worker with the same engine.
pub type EngineFn = std::sync::Arc<
    dyn Fn(
            &BatchHandle,
            &str,
            &Path,
            BatchSettings,
            &Arc<CancelToken>,
        ) -> Result<BatchOutput, AppError>
        + Send
        + Sync,
>;

/// The worker's own view of the queue: enough to drain it, cancel into
/// it, and report it. (A plain struct so the fake-backend tests can
/// drive a real session against a real thread.)
#[derive(Clone)]
pub struct BatchHandle {
    state: Arc<Mutex<QueueState>>,
    event_tx: SyncSender<BatchEvent>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    engine: Arc<BatchEngine>,
    output: Arc<BatchOutputConfig>,
    engine_fn: EngineFn,
}

impl BatchHandle {
    /// The next item the worker should run (queue order, `Waiting`),
    /// marking it Processing with a fresh cancel token. `None` when the
    /// queue is drained.
    fn take_next(&self) -> Option<(String, PathBuf, BatchSettings, Arc<CancelToken>)> {
        let mut guard = lock(&self.state);
        let next = guard
            .items
            .iter_mut()
            .find(|i| i.state == BatchItemState::Waiting)?;
        if next.cancelling {
            // Cancelled while waiting: terminal now, never runs.
            next.state = BatchItemState::Cancelled;
            let id = next.id.clone();
            drop(guard);
            self.try_emit(BatchEvent::Cancelled { item_id: id });
            return self.take_next();
        }
        let token = Arc::new(CancelToken::new());
        next.state = BatchItemState::Processing;
        next.token = Some(Arc::clone(&token));
        Some((next.id.clone(), next.path.clone(), next.settings, token))
    }

    /// Apply the engine's tile-stream events to an item + the UI.
    fn relay_engine_event(&self, item_id: &str, event: EnhanceEvent) {
        match event {
            EnhanceEvent::Preparing { .. } => {
                self.try_emit(BatchEvent::Started {
                    item_id: item_id.to_string(),
                });
            }
            EnhanceEvent::Device { device, .. } => {
                {
                    let mut guard = lock(&self.state);
                    if let Some(item) = guard.items.iter_mut().find(|i| i.id == item_id) {
                        item.device = Some(device);
                    }
                }
                self.try_emit(BatchEvent::Device {
                    item_id: item_id.to_string(),
                    device,
                });
            }
            EnhanceEvent::Processing { done, total } => {
                {
                    let mut guard = lock(&self.state);
                    if let Some(item) = guard.items.iter_mut().find(|i| i.id == item_id) {
                        item.done = done;
                        item.total = total;
                    }
                }
                self.try_emit(BatchEvent::Progress {
                    item_id: item_id.to_string(),
                    done,
                    total,
                });
            }
            EnhanceEvent::Completing => {
                self.try_emit(BatchEvent::Saving {
                    item_id: item_id.to_string(),
                });
            }
            // The service wrapper emits these; the relay sees them too
            // but the worker records the terminal state with the full
            // result, so they need no per-item handling here.
            EnhanceEvent::Completed | EnhanceEvent::Failed { .. } | EnhanceEvent::Cancelled => {}
        }
    }

    /// Finalize one run into the item's terminal state + UI event, and —
    /// for completed/failed (never cancelled) — a Stage 09 journal row.
    /// This is the single engine-agnostic chokepoint: it fires whether
    /// the run was real ONNX or a test fake, because what happened to
    /// the work is a fact of the queue, not of the engine.
    fn finish_item(&self, item_id: &str, outcome: Result<BatchOutput, AppError>, cancelled: bool) {
        let (event, journal) = {
            let mut guard = lock(&self.state);
            let Some(item) = guard.items.iter_mut().find(|i| i.id == item_id) else {
                return; // removed from the queue mid-run; nothing to finalize
            };
            item.token = None;
            let journal = match &outcome {
                Ok(output) => Some(HistoryEntry {
                    id: String::new(),
                    source_path: item.path.to_string_lossy().into_owned(),
                    file_name: item.name.clone(),
                    original_width: output.source_width,
                    original_height: output.source_height,
                    output_width: output.output_width,
                    output_height: output.output_height,
                    scale: item.settings.scale,
                    mode: item.settings.mode.key().to_string(),
                    status: EntryStatus::Completed,
                    error_message: None,
                    created_at: now_ms(),
                    kind: EntryKind::Batch,
                    output_path: Some(output.file_path.clone()),
                }),
                Err(err) if !cancelled && !matches!(err, AppError::Cancelled { .. }) => {
                    Some(HistoryEntry {
                        id: String::new(),
                        source_path: item.path.to_string_lossy().into_owned(),
                        file_name: item.name.clone(),
                        // Dimensions the failed run never measured: 0.
                        original_width: 0,
                        original_height: 0,
                        output_width: 0,
                        output_height: 0,
                        scale: item.settings.scale,
                        mode: item.settings.mode.key().to_string(),
                        status: EntryStatus::Failed,
                        error_message: Some(err.user_message().to_string()),
                        created_at: now_ms(),
                        kind: EntryKind::Batch,
                        output_path: None,
                    })
                }
                _ => None, // cancelled: a user-initiated non-event
            };
            let event = match outcome {
                Ok(output) => {
                    item.state = BatchItemState::Completed;
                    item.done = item.total;
                    item.output = Some(output);
                    item.error = None;
                    item.cancelling = false;
                    BatchEvent::Completed {
                        item_id: item_id.to_string(),
                    }
                }
                Err(err) if cancelled || matches!(err, AppError::Cancelled { .. }) => {
                    item.state = BatchItemState::Cancelled;
                    item.cancelling = false;
                    BatchEvent::Cancelled {
                        item_id: item_id.to_string(),
                    }
                }
                Err(err) => {
                    let user = service::UserError::from(&err);
                    item.state = BatchItemState::Failed;
                    item.error = Some(user.clone());
                    item.cancelling = false;
                    BatchEvent::Failed {
                        item_id: item_id.to_string(),
                        code: user.code,
                        message: user.message,
                    }
                }
            };
            (event, journal)
        };
        // The journal write is outside the queue lock — the history
        // store takes its own lock, and nested locks must never form a
        // cycle with the worker's per-item lock.
        if let Some(entry) = journal {
            self.engine.history.record(entry);
        }
        self.try_emit(event);
    }

    /// Push one event to the UI without ever letting a slow webview stall
    /// the queue. Tile progress and device announcements are advisory:
    /// the queue state already holds the true counts, and the next
    /// snapshot corrects the display, so they are *dropped* when the
    /// buffer is full rather than making the worker wait on the window.
    /// Terminal events are the opposite — they are the only thing that
    /// tells the UI an item's fate, so the worker waits for room instead
    /// of losing one. (A disconnected channel returns immediately.)
    fn try_emit(&self, event: BatchEvent) {
        let advisory = matches!(
            event,
            BatchEvent::Progress { .. } | BatchEvent::Device { .. }
        );
        match self.event_tx.try_send(event) {
            Ok(()) => {}
            Err(TrySendError::Full(event)) | Err(TrySendError::Disconnected(event)) => {
                if advisory {
                    return;
                }
                let _ = self.event_tx.send(event);
            }
        }
    }

    /// Cancel every item: running ones via their token, waiting ones via
    /// the flag the worker checks before starting them.
    pub fn cancel_all(&self) {
        let mut guard = lock(&self.state);
        for item in guard.items.iter_mut() {
            match item.state {
                BatchItemState::Waiting => {
                    item.cancelling = true; // the worker finalizes it
                }
                BatchItemState::Processing => {
                    item.cancelling = true;
                    if let Some(token) = &item.token {
                        token.cancel();
                    }
                }
                _ => {}
            }
        }
    }

    /// Cancel one item. Waiting items cancel immediately; a running item
    /// flips its token and the engine's terminate path does the rest.
    pub fn cancel_item(&self, item_id: &str) -> bool {
        let mut guard = lock(&self.state);
        let Some(item) = guard.items.iter_mut().find(|i| i.id == item_id) else {
            return false;
        };
        match item.state {
            BatchItemState::Waiting => {
                item.cancelling = true;
                true
            }
            BatchItemState::Processing => {
                item.cancelling = true;
                if let Some(token) = &item.token {
                    token.cancel();
                }
                true
            }
            _ => false,
        }
    }

    /// Re-queue failed or cancelled items (fresh runs, progress reset).
    /// If the worker already retired with the drained queue, this is
    /// where it wakes again — a retry of a finished batch genuinely runs.
    /// Returns how many items were retried.
    pub fn retry_failed(&self) -> usize {
        let count = {
            let mut guard = lock(&self.state);
            let mut count = 0;
            for item in guard.items.iter_mut() {
                if matches!(
                    item.state,
                    BatchItemState::Failed | BatchItemState::Cancelled
                ) {
                    item.state = BatchItemState::Waiting;
                    item.done = 0;
                    item.total = 0;
                    item.error = None;
                    item.output = None;
                    item.device = None;
                    item.cancelling = false;
                    count += 1;
                }
            }
            count
        };
        if count > 0 && !self.shutdown.load(std::sync::atomic::Ordering::SeqCst) {
            self.wake_worker();
        }
        count
    }

    /// Start the worker thread unless one is already draining. The
    /// `running` flag flips under the queue lock, so two simultaneous
    /// wakes can never start two workers.
    fn wake_worker(&self) {
        {
            let mut guard = lock(&self.state);
            if guard.running {
                return;
            }
            guard.running = true;
        }
        let handle = self.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("fovea-batch-worker".into())
            .spawn(move || run_worker(handle))
        {
            log::error!("batch worker could not start: {e}");
            let mut guard = lock(&self.state);
            guard.running = false;
            // Don't strand re-queued items in a `waiting` lie: they go
            // back to being honest failures until a worker exists.
            for item in guard.items.iter_mut() {
                if item.state == BatchItemState::Waiting {
                    item.state = BatchItemState::Failed;
                    item.error = Some(service::UserError::from(&AppError::unexpected(
                        "batch worker unavailable",
                    )));
                }
            }
        }
    }

    pub fn snapshot(&self) -> BatchSnapshot {
        let guard = lock(&self.state);
        BatchSnapshot {
            items: guard.items.iter().map(Item::to_dto).collect(),
            running: guard.running,
            worker_limit: WORKER_LIMIT,
        }
    }
}

/// How many engine jobs run at once. One — by hardware architecture
/// (Stage 07): the tile/band budget is a fraction of one pool sized for
/// a single session, and the engine's `JobRegistry` is a single slot.
/// The queue's job is not to raise this number; it's to keep items from
/// having to share it.
pub const WORKER_LIMIT: usize = 1;

/// Start a batch: build the queue state, spawn the single worker, and
/// return a handle for cancellation/retry plus the initial snapshot.
/// The worker runs `engine_fn` on real files — production wires it to
/// the ONNX engine via `enhance_item_onnx`; tests inject a fake.
pub fn start_batch(
    sources: Vec<BatchSource>,
    output: BatchOutputConfig,
    engine: Arc<BatchEngine>,
    event_tx: SyncSender<BatchEvent>,
    engine_fn: EngineFn,
) -> AppResult<(BatchSession, BatchSnapshot)> {
    if sources.is_empty() {
        return Err(AppError::FileMissing {
            detail: "empty batch".into(),
        });
    }
    if sources.len() > MAX_BATCH_ITEMS {
        return Err(AppError::FileTooLarge {
            detail: format!(
                "batch of {} items rejected (max {MAX_BATCH_ITEMS})",
                sources.len()
            ),
        });
    }
    let items: Vec<Item> = sources
        .into_iter()
        .map(|src| Item {
            id: next_item_id(),
            image_id: src.image_id,
            name: src.name,
            path: PathBuf::from(src.path),
            state: BatchItemState::Waiting,
            settings: src.settings,
            done: 0,
            total: 0,
            device: None,
            error: None,
            output: None,
            cancelling: false,
            token: None,
        })
        .collect();
    let state = Arc::new(Mutex::new(QueueState {
        items,
        running: false,
    }));
    let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let handle = BatchHandle {
        state: Arc::clone(&state),
        event_tx,
        shutdown: Arc::clone(&shutdown),
        engine,
        output: Arc::new(output),
        engine_fn,
    };
    handle.wake_worker();
    if !state.lock().unwrap_or_else(|e| e.into_inner()).running {
        return Err(AppError::unexpected("batch worker could not start"));
    }
    let snapshot = handle.snapshot();
    Ok((BatchSession { handle, shutdown }, snapshot))
}

/// The worker body: drain queue order, one item at a time, honoring the
/// shutdown flag between items. Panics inside a run are contained by
/// catch_unwind into that item's failure — the queue lives on. Called
/// from `start_batch` and from `retry_failed` alike, so a restarted
/// worker and a first worker are the same code.
fn run_worker(handle: BatchHandle) {
    while !handle.shutdown.load(std::sync::atomic::Ordering::SeqCst) {
        let Some((item_id, path, settings, token)) = handle.take_next() else {
            break; // drained — the worker retires, running → false
        };
        let engine_fn = Arc::clone(&handle.engine_fn);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            engine_fn(&handle, &item_id, &path, settings, &token)
        }));
        let cancelled =
            token.is_cancelled() || handle.shutdown.load(std::sync::atomic::Ordering::SeqCst);
        match outcome {
            Ok(result) => handle.finish_item(&item_id, result, cancelled),
            Err(panic) => {
                let detail = panic
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "unknown panic".into());
                log::error!("batch item panicked: {detail}");
                handle.finish_item(
                    &item_id,
                    Err(AppError::unexpected("batch item panicked")),
                    cancelled,
                );
            }
        }
    }
    // Drained or shut down: finalize under the queue lock. A retry that
    // re-queued work in the instant between the drain and this lock is
    // fresh work, not leftovers — keep draining instead of cancelling.
    let mut guard = lock(&handle.state);
    guard.running = false;
    let renewed = !handle.shutdown.load(std::sync::atomic::Ordering::SeqCst)
        && guard
            .items
            .iter()
            .any(|i| i.state == BatchItemState::Waiting && !i.cancelling);
    if renewed {
        guard.running = true;
        drop(guard);
        return run_worker(handle);
    }
    // Flag any items still waiting/processing as cancelled so the
    // UI's last sync can't show a phantom in-flight batch.
    for item in guard.items.iter_mut() {
        match item.state {
            BatchItemState::Waiting | BatchItemState::Processing => {
                item.state = BatchItemState::Cancelled;
                item.cancelling = false;
                item.token = None;
            }
            _ => {}
        }
    }
    // Stage 09: terminal items *survive* the drained queue — the
    // last sync a window sees is the honest end-of-batch summary
    // (what completed, what failed, where the files are), not an
    // empty list. A new batch replaces the session wholesale.
    guard.items.retain(|i| {
        matches!(
            i.state,
            BatchItemState::Completed | BatchItemState::Failed | BatchItemState::Cancelled
        )
    });
}

/// The production engine runner: one queued item through the real
/// Stage 07 ladder, viewless, then straight into the user's chosen
/// output folder. Progress reaches the UI through `handle` (the relay).
/// Journaling is *not* here — the worker's `finish_item` records every
/// terminal outcome, so this function stays a pure "run and export".
/// Releases the engine's single job slot if an unwind passes through the
/// engine call. `enhance_without_view` finishes the slot itself on every
/// path it controls, so this only fires for the abnormal one — without it
/// a panicking batch item would leave the engine reporting "busy" for the
/// rest of the session, and the whole queue plus manual Enhance with it.
struct JobSlotGuard {
    jobs: Arc<JobRegistry>,
    job_id: String,
}

impl Drop for JobSlotGuard {
    fn drop(&mut self) {
        if self.jobs.has(&self.job_id) {
            self.jobs.finish(&self.job_id);
        }
    }
}

pub fn enhance_item_onnx(
    handle: &BatchHandle,
    item_id: &str,
    path: &Path,
    settings: BatchSettings,
    token: &Arc<CancelToken>,
) -> Result<BatchOutput, AppError> {
    let engine = &handle.engine;
    let job_id = engine.jobs.next_job_id();
    // The engine's single slot is the hard guarantee behind WORKER_LIMIT:
    // a batch item and a manual Enhance can never collide — whoever
    // asks second hears "already running" honestly.
    if let Err(busy) = engine.jobs.begin(&job_id, Arc::clone(token)) {
        return Err(AppError::from(busy));
    }
    let _slot = JobSlotGuard {
        jobs: Arc::clone(&engine.jobs),
        job_id: job_id.clone(),
    };
    let relay_id = item_id.to_string();
    let result = service::enhance_without_view(
        &path.to_string_lossy(),
        settings.mode,
        settings.scale,
        settings.filter,
        settings.intensity,
        &engine.registry,
        &engine.config,
        &engine.out_dir,
        &engine.jobs,
        &job_id,
        token,
        |event| handle.relay_engine_event(&relay_id, event),
        |model, pref| match pref {
            GpuPreference::PreferGpu => engine_open(model, pref),
            GpuPreference::CpuOnly => engine_open(model, pref),
        },
    );
    match result {
        // The master committed; ensure the destination exists *before*
        // export so a vanished folder fails while the master is still
        // deletable, and clean the master if export itself fails.
        Ok(enhanced) => match commit_batch_output(&handle.output)
            .and_then(|()| export_result_of(&enhanced, &handle.output))
        {
            Ok(exported) => {
                // The batch's deliverable is the exported file; the
                // 16-bit master PNG behind it is an intermediate, and a
                // 100-image run would otherwise leave a gigabyte of
                // unlabelled duplicates in app data that the user is
                // never told about and cannot clean.
                if let Err(err) = std::fs::remove_file(&enhanced.file_path) {
                    log::warn!("batch master cleanup failed: {err}");
                }
                Ok(exported)
            }
            Err(err) => {
                let _ = std::fs::remove_file(&enhanced.file_path);
                Err(err)
            }
        },
        Err(err) => Err(err),
    }
}

/// The actual ONNX session open (kept a function so tests can swap the
/// whole engine_fn above it; this layer stays production-only).
fn engine_open(
    model: &Path,
    pref: GpuPreference,
) -> Result<
    crate::services::inference::backend::OnnxBackend,
    crate::services::inference::backend::EngineError,
> {
    crate::services::inference::backend::OnnxBackend::load_with(model, pref)
}

/// Export the committed master into the batch's output folder with the
/// batch's format/quality (collision-safe naming lives in the export
/// service). The folder is resolved by the command layer (empty means
/// Fovea's default batch export dir — only the command can reach the
/// app-data path, so the service treats it as always-set).
fn export_result_of(
    enhanced: &service::EnhanceResult,
    output: &BatchOutputConfig,
) -> Result<BatchOutput, AppError> {
    let dest = PathBuf::from(&output.folder);
    let stem = Path::new(&enhanced.image_id)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "fovea".into());
    let exported = export::export_image(
        &enhanced.file_path,
        &dest,
        &stem,
        output.format,
        output.quality,
    )?;
    Ok(BatchOutput {
        file_path: exported.file_path.to_string_lossy().into_owned(),
        file_name: exported.file_name,
        folder: exported.folder,
        bytes: exported.bytes,
        source_width: enhanced.source_width,
        source_height: enhanced.source_height,
        output_width: enhanced.output_width,
        output_height: enhanced.output_height,
        label: enhanced.label.clone(),
        engine: enhanced.engine.clone(),
    })
}

/// Existence-check the destination while the master is still deletable.
/// (The real copy/encode work lives in `export_result_of`.)
fn commit_batch_output(output: &BatchOutputConfig) -> Result<(), AppError> {
    let dest = PathBuf::from(&output.folder);
    std::fs::create_dir_all(&dest).map_err(AppError::from)?;
    Ok(())
}

fn next_item_id() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("item-{t}-{n}")
}

fn lock(state: &Arc<Mutex<QueueState>>) -> MutexGuard<'_, QueueState> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}

/// The worker strategy, reported to the UI in the snapshot's
/// `workerLimit`. A single function so the fact has one home.
pub fn worker_limit() -> usize {
    // The honest hardware facts (VRAM budget, single engine slot) all
    // say one; if a future runtime allows concurrent sessions, the
    // engine — not the queue — raises this.
    WORKER_LIMIT
}

/// The hardware the worker strategy is *for* — reported in
/// diagnostics, never used to secretly change the queue's shape.
pub fn worker_strategy_note() -> String {
    let hw = hardware::detect();
    match hw.acceleration_gpu() {
        Some(gpu) => format!(
            "1 sequential worker — GPU {} budgets one session at a time",
            gpu.name
        ),
        None => "1 sequential worker — CPU sessions already use every core".to_string(),
    }
}

/// The engine cap a batch should respect before queueing (same as the
/// single path's — re-exposed for the command layer's validation).
pub fn max_output_pixels() -> u64 {
    MAX_ENHANCE_OUTPUT_PIXELS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::inference::finish::DEFAULT_INTENSITY;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fovea-batch-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn source_png(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
        use image::{ImageFormat, Rgba, RgbaImage};
        let mut img = RgbaImage::new(w, h);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = Rgba([
                (x * 7 % 251) as u8,
                (y * 11 % 249) as u8,
                ((x + y) % 253) as u8,
                255,
            ]);
        }
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut out, ImageFormat::Png)
            .expect("encode");
        let path = dir.join(name);
        std::fs::write(&path, out.into_inner()).expect("write");
        path
    }

    /// A fake engine_fn whose behavior is scripted per source stem:
    /// anything named "boom-*" fails, anything named "slow-*" polls the
    /// token, and the rest succeed after reporting a couple of tiles.
    fn scripted_engine_fn() -> EngineFn {
        Arc::new(
            move |handle: &BatchHandle,
                  item_id: &str,
                  path: &Path,
                  settings: BatchSettings,
                  token: &Arc<CancelToken>|
                  -> Result<BatchOutput, AppError> {
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                handle.relay_engine_event(
                    item_id,
                    EnhanceEvent::Preparing {
                        job_id: "fake".into(),
                    },
                );
                if stem.starts_with("boom") {
                    handle.relay_engine_event(
                        item_id,
                        EnhanceEvent::Failed {
                            code: "processing_failed",
                            message: "boom",
                        },
                    );
                    return Err(AppError::ProcessingFailed { detail: stem });
                }
                if stem.starts_with("slow") {
                    handle.relay_engine_event(
                        item_id,
                        EnhanceEvent::Device {
                            device: "fake-cpu",
                            tile: 64,
                        },
                    );
                    for done in 0..100u32 {
                        if token.is_cancelled() {
                            return Err(AppError::Cancelled {
                                detail: "mid-run".into(),
                            });
                        }
                        handle.relay_engine_event(
                            item_id,
                            EnhanceEvent::Processing {
                                done: done + 1,
                                total: 100,
                            },
                        );
                        std::thread::sleep(Duration::from_millis(10));
                    }
                } else {
                    handle.relay_engine_event(
                        item_id,
                        EnhanceEvent::Processing { done: 1, total: 1 },
                    );
                }
                // Export through the real service into the queue's folder
                // (the harness always sets a non-empty one).
                let dest_dir = PathBuf::from(&handle.output.folder);
                std::fs::create_dir_all(&dest_dir).expect("dest");
                let exported = export::export_image(
                    path,
                    &dest_dir,
                    &stem,
                    handle.output.format,
                    handle.output.quality,
                )
                .map_err(|e| AppError::unexpected(format!("fake export: {e}")))?;
                Ok(BatchOutput {
                    file_path: exported.file_path.to_string_lossy().into_owned(),
                    file_name: exported.file_name,
                    folder: exported.folder,
                    bytes: exported.bytes,
                    source_width: 8,
                    source_height: 4,
                    output_width: 8,
                    output_height: 4,
                    label: format!("{}× · fake", settings.scale),
                    engine: "fake".into(),
                })
            },
        )
    }

    fn sources(dir: &Path, names: &[&str]) -> Vec<BatchSource> {
        names
            .iter()
            .map(|n| BatchSource {
                image_id: dir.join(n).to_string_lossy().into_owned(),
                path: dir.join(n).to_string_lossy().into_owned(),
                name: n.to_string(),
                settings: BatchSettings {
                    mode: EnhanceMode::Standard,
                    scale: 2,
                    filter: Filter::Original,
                    intensity: DEFAULT_INTENSITY,
                },
            })
            .collect()
    }

    struct Harness {
        dir: PathBuf,
        events: Arc<Mutex<Vec<BatchEvent>>>,
        handle: BatchHandle,
    }

    impl Harness {
        fn new(tag: &str, names: &[&str]) -> Harness {
            let dir = scratch(tag);
            for n in names {
                source_png(&dir, n, 8, 4);
            }
            let history = history::Store::open(&dir);
            let jobs = Arc::new(JobRegistry::new());
            let engine = Arc::new(BatchEngine {
                registry: Arc::new(ModelRegistry::new(vec![dir.clone()])),
                jobs: Arc::clone(&jobs),
                config: EngineConfig::default(),
                out_dir: dir.join("enhanced"),
                history,
            });
            let (tx, rx) = mpsc::sync_channel::<BatchEvent>(512);
            let events: Arc<Mutex<Vec<BatchEvent>>> = Arc::new(Mutex::new(Vec::new()));
            let collector = Arc::clone(&events);
            std::thread::spawn(move || {
                for event in rx {
                    collector.lock().unwrap().push(event);
                }
            });
            let output = BatchOutputConfig {
                folder: dir.join("export").to_string_lossy().into_owned(),
                format: ExportFormat::Png,
                quality: 90,
            };
            let (session, _snapshot) = start_batch(
                sources(&dir, names),
                output,
                engine,
                tx,
                scripted_engine_fn(),
            )
            .expect("start batch");
            let handle = session.handle().clone();
            drop(session); // the handle alone drives the live queue here
            Harness {
                dir,
                events,
                handle,
            }
        }

        fn item_by_name(&self, name: &str) -> BatchItem {
            self.handle
                .snapshot()
                .items
                .into_iter()
                .find(|i| i.name == name)
                .unwrap_or_else(|| panic!("no item named {name}"))
        }

        /// Poll until the given predicate over the snapshot holds, or fail.
        fn wait_until(&self, msg: &str, check: impl Fn(&BatchSnapshot) -> bool) -> BatchSnapshot {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let snap = self.handle.snapshot();
                if check(&snap) {
                    return snap;
                }
                assert!(Instant::now() < deadline, "timeout waiting for: {msg}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        fn wait_drained(&self) -> BatchSnapshot {
            self.wait_until("queue drained", |s| !s.running)
        }
    }

    #[test]
    fn batch_completes_multiple_items_in_order() {
        let h = Harness::new("order", &["a.png", "b.png", "c.png"]);
        let snap = h.wait_drained();
        assert_eq!(
            snap.items
                .iter()
                .map(|i| (i.name.as_str(), i.state))
                .collect::<Vec<_>>(),
            vec![
                ("a.png", BatchItemState::Completed),
                ("b.png", BatchItemState::Completed),
                ("c.png", BatchItemState::Completed),
            ],
            "queue order and terminal states"
        );
        // Completed items carry their committed output — a file that exists.
        for item in &snap.items {
            let out = item.output.clone().expect("output record");
            assert!(Path::new(&out.file_path).exists(), "exported file on disk");
            assert_eq!(item.done, item.total);
            assert!(item.device.is_none() || item.device == Some("fake-cpu"));
        }
        // Events streamed per item: started → progress → completed.
        let events = h.events.lock().unwrap();
        let started = events
            .iter()
            .filter(|e| matches!(e, BatchEvent::Started { .. }))
            .count();
        assert_eq!(started, 3);
        let completed = events
            .iter()
            .filter(|e| matches!(e, BatchEvent::Completed { .. }))
            .count();
        assert_eq!(completed, 3);
    }

    #[test]
    fn one_failed_item_never_sinks_the_batch() {
        let h = Harness::new("failure", &["boom-1.png", "good-2.png"]);
        h.wait_drained();
        let failed = h.item_by_name("boom-1.png");
        assert_eq!(failed.state, BatchItemState::Failed);
        let err = failed.error.clone().expect("user-safe error");
        assert_eq!(err.code, "processing_failed");
        assert!(failed.output.is_none(), "failed items have no output");
        assert_eq!(
            h.item_by_name("good-2.png").state,
            BatchItemState::Completed
        );

        // Retry re-queues the failure as a fresh run (the scripted fake
        // still fails it — the *transition* is what this asserts).
        assert_eq!(h.handle.retry_failed(), 1);
        let queued = h.item_by_name("boom-1.png");
        assert_eq!(queued.state, BatchItemState::Waiting);
        assert!(queued.error.is_none());
        h.wait_until("retry settles", |s| !s.running);
        assert_eq!(h.item_by_name("boom-1.png").state, BatchItemState::Failed);
    }

    #[test]
    fn cancel_mid_run_stops_early_and_cancel_all_sweeps_waiting() {
        let h = Harness::new("cancel", &["slow-a.png", "b.png", "c.png"]);
        // Wait for the first item to genuinely be in flight.
        h.wait_until("first item processing", |s| {
            s.items
                .first()
                .is_some_and(|i| i.state == BatchItemState::Processing && i.done > 5)
        });
        h.handle.cancel_all();
        let snap = h.wait_drained();
        let a = h.item_by_name("slow-a.png");
        assert_eq!(a.state, BatchItemState::Cancelled);
        assert!(!a.cancelling, "terminal clears the cancelling flag");
        // b/c may have already run or were cancelled from the queue —
        // in either case, nothing is left waiting/processing.
        for item in &snap.items {
            assert!(
                matches!(
                    item.state,
                    BatchItemState::Completed | BatchItemState::Failed | BatchItemState::Cancelled
                ),
                "drained queue is all-terminal: {} is {:?}",
                item.name,
                item.state
            );
        }
    }

    #[test]
    fn drained_snapshot_keeps_terminal_items_for_the_ui() {
        let h = Harness::new("retain", &["a.png"]);
        h.wait_drained();
        let snap = h.handle.snapshot();
        assert!(!snap.running);
        assert_eq!(snap.items.len(), 1, "the end-of-batch summary survives");
        assert_eq!(snap.items[0].state, BatchItemState::Completed);
    }

    #[test]
    fn completed_and_failed_batch_items_reach_the_history_journal() {
        let h = Harness::new("journal", &["ok.png", "boom-x.png", "slow-j.png"]);
        h.wait_until("first two settle", |s| {
            s.items
                .iter()
                .take(2)
                .all(|i| matches!(i.state, BatchItemState::Completed | BatchItemState::Failed))
        });
        // Cancel the third mid-run — cancellations are *not* journal-worthy.
        let third = h.handle.snapshot().items[2].id.clone();
        h.handle.cancel_item(&third);
        h.wait_drained();

        let entries = h.handle.engine.history.snapshot().entries;
        let names: Vec<&str> = entries.iter().map(|e| e.entry.file_name.as_str()).collect();
        assert!(
            names.contains(&"ok.png"),
            "completed run journaled: {names:?}"
        );
        assert!(names.contains(&"boom-x.png"), "failed run journaled");
        assert!(
            !names.contains(&"slow-j.png"),
            "cancelled runs stay out of history"
        );
        let ok = entries
            .iter()
            .find(|e| e.entry.file_name == "ok.png")
            .expect("ok entry");
        assert_eq!(ok.entry.status, EntryStatus::Completed);
        assert_eq!(ok.entry.kind, EntryKind::Batch);
        assert!(
            ok.output_exists,
            "the exported copy actually exists on disk"
        );
        assert_eq!(ok.entry.source_path, h.dir.join("ok.png").to_string_lossy());
        let bad = entries
            .iter()
            .find(|e| e.entry.file_name == "boom-x.png")
            .expect("failed entry");
        assert_eq!(bad.entry.status, EntryStatus::Failed);
        assert!(bad.entry.error_message.is_some());
        assert!(bad.entry.output_path.is_none());
    }

    #[test]
    fn empty_and_oversized_batches_are_refused() {
        let dir = scratch("refuse");
        let history = history::Store::open(&dir);
        let engine = Arc::new(BatchEngine {
            registry: Arc::new(ModelRegistry::new(vec![dir.clone()])),
            jobs: Arc::new(JobRegistry::new()),
            config: EngineConfig::default(),
            out_dir: dir.join("enhanced"),
            history,
        });
        let (tx, _rx) = mpsc::sync_channel(1);
        let output = BatchOutputConfig {
            folder: dir.join("export").to_string_lossy().into_owned(),
            format: ExportFormat::Png,
            quality: 90,
        };
        let empty = start_batch(
            vec![],
            output.clone(),
            Arc::clone(&engine),
            tx.clone(),
            scripted_engine_fn(),
        );
        assert!(empty.is_err(), "an empty batch is refused");
        let huge: Vec<BatchSource> = (0..=MAX_BATCH_ITEMS)
            .map(|i| BatchSource {
                image_id: format!("C:/x/{i}.png"),
                path: format!("C:/x/{i}.png"),
                name: format!("{i}.png"),
                settings: BatchSettings {
                    mode: EnhanceMode::Standard,
                    scale: 2,
                    filter: Filter::Original,
                    intensity: DEFAULT_INTENSITY,
                },
            })
            .collect();
        assert!(
            start_batch(huge, output, engine, tx, scripted_engine_fn()).is_err(),
            "a batch beyond the cap is refused"
        );
    }

    #[test]
    fn cancel_item_reports_unknown_ids_honestly() {
        let h = Harness::new("unknown", &["a.png"]);
        assert!(!h.handle.cancel_item("item-does-not-exist"));
    }

    /// Stage 12 — the app-close sequence (`lib.rs` on_window_event: the
    /// engine slot shuts down, then the queue is flagged) must leave no
    /// phantom in-flight work: the running item stops, waiting items are
    /// marked cancelled, and the snapshot ends all-terminal with the
    /// worker retired.
    #[test]
    fn window_shutdown_mid_batch_leaves_no_phantom_work() {
        let dir = scratch("shutdown");
        let names = ["slow-s.png", "b.png", "c.png"];
        for n in names {
            source_png(&dir, n, 8, 4);
        }
        let history = history::Store::open(&dir);
        let jobs = Arc::new(JobRegistry::new());
        let engine = Arc::new(BatchEngine {
            registry: Arc::new(ModelRegistry::new(vec![dir.clone()])),
            jobs: Arc::clone(&jobs),
            config: EngineConfig::default(),
            out_dir: dir.join("enhanced"),
            history,
        });
        let (tx, rx) = mpsc::sync_channel::<BatchEvent>(512);
        std::thread::spawn(move || for _ in rx {}); // drain like the relay would
        let output = BatchOutputConfig {
            folder: dir.join("export").to_string_lossy().into_owned(),
            format: ExportFormat::Png,
            quality: 90,
        };
        let (session, _) = start_batch(
            sources(&dir, &names),
            output,
            engine,
            tx,
            scripted_engine_fn(),
        )
        .expect("start batch");
        let handle = session.handle().clone();

        // Wait until the first (slow) item is genuinely in flight.
        // Observing `Processing` is sufficient: the worker flips that state
        // and registers the token before calling the engine, so the item is
        // interruptible the instant we see it — and the scripted slow item
        // runs 100 tiles, so it cannot finish before we cancel. (A stricter
        // "some tiles done" precondition is exactly what flakes under the
        // whole-suite CPU contention this test shares.)
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let snap = handle.snapshot();
            if snap
                .items
                .first()
                .is_some_and(|i| i.state == BatchItemState::Processing)
            {
                break;
            }
            assert!(Instant::now() < deadline, "timeout waiting for processing");
            std::thread::sleep(Duration::from_millis(10));
        }

        // The close sequence: engine slot shutdown (cancels the live
        // token) + queue shutdown (flags the worker between items).
        jobs.shutdown();
        session.shutdown_now();
        handle.cancel_all();
        drop(session); // what a destroyed window leaves behind

        let mut snap = handle.snapshot();
        let deadline = Instant::now() + Duration::from_secs(10);
        while snap.running {
            assert!(Instant::now() < deadline, "timeout waiting for retire");
            std::thread::sleep(Duration::from_millis(10));
            snap = handle.snapshot();
        }
        assert!(!snap.running, "worker retired");
        for item in &snap.items {
            assert!(
                matches!(
                    item.state,
                    BatchItemState::Completed | BatchItemState::Failed | BatchItemState::Cancelled
                ),
                "{} must be terminal after shutdown, is {:?}",
                item.name,
                item.state
            );
            assert!(!item.cancelling, "{} must not stay mid-cancel", item.name);
        }
        // The mid-run item was cancelled (not silently lost), and nothing
        // was left claiming to still be waiting.
        assert!(
            snap.items
                .iter()
                .any(|i| i.name == "slow-s.png" && i.state == BatchItemState::Cancelled),
            "the interrupted item reports cancelled"
        );
        assert!(
            !snap.items.iter().any(|i| matches!(
                i.state,
                BatchItemState::Waiting | BatchItemState::Processing
            )),
            "no phantom work survives shutdown"
        );
    }
}
