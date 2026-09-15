//! Image import commands.
//!
//! Two entry points, one pipeline:
//! - `pick_image_files` opens the *native* Windows picker (Rust side of the
//!   dialog plugin — the webview gets no dialog permission at all, so the
//!   only file browsing the UI can trigger is this one image-filtered box).
//! - `import_images` validates every path and returns per-file outcomes.
//!
//! Heavy work (decode, thumbnail) runs on Tauri's blocking pool so the UI
//! thread never stalls on a large batch.

use std::sync::mpsc;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::services::import::{self, ImportOutcome};

/// Open a native multi-select image picker and return the chosen paths.
///
/// Returns an empty vec when the user cancels. The dialog is image-filtered
/// at the OS level, but results are still import-validated afterwards —
/// OS filters are advisory, never trusted.
#[tauri::command]
pub async fn pick_image_files(app: AppHandle) -> AppResult<Vec<String>> {
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .file()
        .set_title("Import images")
        .add_filter(
            "Images",
            &["jpg", "jpeg", "png", "webp"], /* keep in sync with FormatHint::from_extension */
        )
        .pick_files(move |chosen| {
            let _ = tx.send(chosen);
        });
    let chosen = rx
        .recv()
        .map_err(|_| AppError::unexpected("file dialog closed without a result"))?;
    Ok(match chosen {
        Some(paths) => paths.into_iter().map(|p| p.to_string()).collect(),
        None => Vec::new(),
    })
}

/// Validate and import a batch of dropped/picked paths. Never fails as a
/// whole — each file reports its own outcome (see `ImportOutcome`).
#[tauri::command]
pub async fn import_images(paths: Vec<String>) -> AppResult<Vec<ImportOutcome>> {
    // Unbounded input is trivially spammable; a real drop is dozens of
    // files, not thousands.
    const MAX_BATCH: usize = 200;
    if paths.len() > MAX_BATCH {
        return Err(AppError::FileTooLarge {
            detail: format!("batch of {} paths rejected (max {MAX_BATCH})", paths.len()),
        });
    }
    let outcomes = tauri::async_runtime::spawn_blocking(move || import::import_many(&paths))
        .await
        .map_err(|err| AppError::unexpected(format!("import task failed: {err}")))?;
    Ok(outcomes)
}
