//! History commands (Stage 09) — the read/reset surface of the local
//! processing journal.
//!
//! Recording is *not* a command: entries land at the honest moments
//! (see `commands::inference` and `services::batch`). The UI only reads
//! the journal and, deliberately, clears it. Existence flags
//! (`sourceExists`, `outputExists`) and dead-pointer pruning are
//! computed fresh at read time — a history row never claims more about
//! the disk than the disk currently agrees to.

use std::sync::Arc;

use tauri::State;

use crate::error::AppResult;
use crate::services::history::{self, Store as HistoryStore};

/// The journal snapshot for the History view: every recorded run with
/// fresh existence flags, plus the pruned recent-files list.
#[tauri::command]
pub fn get_history(store: State<'_, Arc<HistoryStore>>) -> AppResult<history::HistorySnapshot> {
    Ok(store.snapshot())
}

/// Wipe the journal and the recent list (user-initiated, confirmed in
/// the UI). Processed files on disk are never touched — Pixora deletes
/// records, never records' subject matter.
#[tauri::command]
pub fn clear_history(store: State<'_, Arc<HistoryStore>>) -> AppResult<()> {
    store.clear();
    Ok(())
}
