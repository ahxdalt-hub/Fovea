//! Export commands (Stage 06) — deliver an enhancement result to disk in
//! the format the user chose.
//!
//! The two entry points mirror the import pair: the folder picker opens on
//! the Rust side (the webview keeps zero dialog/filesystem permissions),
//! and the export itself resolves everything server-side:
//!
//! - the source is the engine's committed master PNG — looked up by image
//!   id in `EngineState::outputs`, which only the engine ever writes, so
//!   the client can never name an arbitrary path to read;
//! - the destination folder is whatever the native picker returned (the
//!   same trust level as an imported file path);
//! - format/quality arrive as strings/numbers and are validated, never
//!   trusted.
//!
//! Encoding runs on the blocking pool; a full-frame encode of a
//! few-MP image is seconds of pure CPU, far below the inference job the
//! user already waited through — no progress channel earns its place.

use std::path::Path;
use std::sync::mpsc;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::commands::inference::EngineState;
use crate::error::{AppError, AppResult};
use crate::services::export::{self, ExportFormat, ExportResult};

/// Open a native folder picker; returns the chosen folder (empty vec on
/// cancel) so the caller can offer the default in-app behavior.
#[tauri::command]
pub async fn pick_export_folder(app: AppHandle) -> AppResult<Vec<String>> {
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .file()
        .set_title("Choose export folder")
        .pick_folder(move |chosen| {
            let _ = tx.send(chosen);
        });
    let chosen = rx
        .recv()
        .map_err(|_| AppError::unexpected("folder dialog closed without a result"))?;
    Ok(chosen.map(|p| vec![p.to_string()]).unwrap_or_default())
}

/// Export the committed enhancement result of `image_id`.
///
/// `format`: "png" | "jpeg" | "webp". `quality`: 1–100, only meaningful
/// for the lossy formats (PNG ignores it — its export is a lossless
/// copy). `folder` is the picker's path; an empty string means "use
/// Pixora's default export folder" (the app-data `exports/` dir), so the
/// primary action never dies on an unclosed dialog.
#[tauri::command]
pub async fn export_enhanced_image(
    app: AppHandle,
    image_id: String,
    format: String,
    quality: u8,
    folder: String,
) -> AppResult<ExportResult> {
    if image_id.is_empty() {
        return Err(AppError::FileMissing {
            detail: "empty image id".into(),
        });
    }
    let format = ExportFormat::from_key(&format).ok_or_else(|| AppError::UnsupportedFormat {
        detail: format!("unknown export format {format:?}"),
    })?;
    let state = app.state::<EngineState>();
    let master = {
        let guard = state
            .outputs
            .lock()
            .map_err(|_| AppError::unexpected("output registry poisoned"))?;
        guard.get(&image_id).cloned()
    }
    .ok_or_else(|| AppError::FileMissing {
        detail: "no committed enhancement for id".into(),
    })?;
    let dest = if folder.is_empty() {
        default_export_dir(&app)?
    } else {
        Path::new(&folder).to_path_buf()
    };
    // File name: the imported image's stem — the user's own name, so the
    // export is recognizable next to the original.
    let stem = Path::new(&image_id)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "pixora".into());

    let result = tauri::async_runtime::spawn_blocking(move || {
        export::export_image(&master, &dest, &stem, format, quality)
    })
    .await
    .map_err(|e| AppError::unexpected(format!("export task failed: {e}")))??;
    Ok(result)
}

/// Pixora's own export folder (app-data `exports/`), used when the user
/// never changed the default. Created on demand.
fn default_export_dir(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::unexpected(format!("app data dir: {e}")))?
        .join("exports");
    std::fs::create_dir_all(&dir).map_err(AppError::from)?;
    Ok(dir)
}
