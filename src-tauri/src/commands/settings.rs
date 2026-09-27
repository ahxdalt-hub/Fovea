//! Settings commands (Stage 10) — the native half of the preferences
//! system.
//!
//! The frontend owns the full settings record; this command receives the
//! engine-relevant projection (`set_engine_hints`) and puts it in effect
//! immediately *and* durably (see `services::settings`). Thin by rule:
//! validate nothing beyond the types, delegate everything.

use tauri::AppHandle;
use tauri::Manager;

use crate::error::AppResult;
use crate::services::settings::{self, EngineHints};

/// Mirror the user's engine-relevant preferences: which hardware path to
/// take, how hard to use the machine, whether imports may be remembered.
/// Takes effect for the next job (and the next launch, via the file).
#[tauri::command]
pub fn set_engine_hints(
    app: AppHandle,
    cpu_only: bool,
    full_power: bool,
    record_recents: bool,
) -> AppResult<()> {
    let dir = app.path().app_data_dir().ok();
    settings::update(
        dir.as_deref(),
        EngineHints {
            cpu_only,
            full_power,
            record_recents,
        },
    );
    Ok(())
}
