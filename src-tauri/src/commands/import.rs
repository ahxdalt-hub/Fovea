//! Import + viewing commands.
//!
//! Entry points, one pipeline:
//! - `pick_image_files` opens the *native* Windows picker (Rust side of the
//!   dialog plugin — the webview gets no dialog permission at all, so the
//!   only file browsing the UI can trigger is this one image-filtered box).
//! - `import_images` validates every path and returns per-file outcomes.
//! - `load_image_view` (Stage 04) serves the display representation of an
//!   already-imported file for the image workspace.
//!
//! Heavy work (decode, thumbnail, downscale) runs on Tauri's blocking pool
//! so the UI thread never stalls on a large file.

use std::path::Path;
use std::sync::mpsc;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::services::import::{self, ImageView, ImportOutcome};

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

/// Load the display representation of one imported image (Stage 04).
///
/// `image_id` is the canonical path from `ImportedImage`. `max_edge`
/// requests the largest display dimension to serve; `0` means the default
/// (2600 px — see `services::import::VIEW_MAX_EDGE`). A later 1:1/full
/// fidelity mode raises it toward the true size. Returns the untouched
/// original bytes when the file already fits — the common, zero-loss path.
#[tauri::command]
pub async fn load_image_view(image_id: String, max_edge: Option<u32>) -> AppResult<ImageView> {
    let edge = max_edge.unwrap_or(import::VIEW_MAX_EDGE).max(1);
    tauri::async_runtime::spawn_blocking(move || {
        import::load_image_view(Path::new(&image_id), edge)
    })
    .await
    .map_err(|err| AppError::unexpected(format!("view task failed: {err}")))?
}
