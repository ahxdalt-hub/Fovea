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
/// Fovea's own export folder" (`Documents/Fovea`), so the primary action
/// never dies on an unclosed dialog.
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
        .unwrap_or_else(|| "fovea".into());

    let written_to = dest.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        export::export_image(&master, &dest, &stem, format, quality)
    })
    .await
    .map_err(|e| AppError::unexpected(format!("export task failed: {e}")))??;
    remember(
        &app,
        ExportRecord {
            folder: written_to,
            file: Some(result.file_path.clone()),
        },
    );
    Ok(result)
}

/// Folder names under the user's Documents: `Fovea/` for single exports,
/// `Fovea/Batch/` for bulk runs.
const PRODUCT_SUBDIR: &str = "Fovea";
const BATCH_SUBDIR: &str = "Batch";

/// Fovea's own export folder, used when the user never changed the
/// default: `Documents/Fovea`.
///
/// Documents, not app data — a photographer looks for their pictures in
/// Documents, and an export buried in `%APPDATA%` is an export they will
/// never find. Created on demand (and at startup, by
/// [`prepare_export_folders`]).
pub fn default_export_dir(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    let dir = documents_fovea(app)?;
    std::fs::create_dir_all(&dir).map_err(AppError::from)?;
    Ok(dir)
}

/// Fovea's own batch folder: `Documents/Fovea/Batch`, so a hundred
/// bulk results never pile on top of single exports.
pub fn default_batch_export_dir(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    let dir = documents_fovea(app)?.join(BATCH_SUBDIR);
    std::fs::create_dir_all(&dir).map_err(AppError::from)?;
    Ok(dir)
}

fn documents_fovea(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    app.path()
        .document_dir()
        .map(|docs| docs.join(PRODUCT_SUBDIR))
        .map_err(|e| AppError::unexpected(format!("documents dir: {e}")))
}

/// Make both default folders exist. Called once from the startup hook so
/// the location is real before the first export is ever offered; the
/// failure is the caller's to log, never to die on — a folder chosen with
/// the picker still works without these.
pub fn prepare_export_folders(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    default_batch_export_dir(app)?;
    default_export_dir(app)
}

/// What Fovea last wrote to disk, remembered on this side of the
/// boundary: revealing a folder needs a location, and the client never
/// gets to name one (`file` is `None` for a batch run, whose result is
/// the folder itself).
#[derive(Debug, Clone)]
pub struct ExportRecord {
    pub folder: std::path::PathBuf,
    pub file: Option<std::path::PathBuf>,
}

/// Managed slot for [`ExportRecord`].
#[derive(Default)]
pub struct LastExport(std::sync::Mutex<Option<ExportRecord>>);

/// Record a completed write. Best-effort: losing the record costs the
/// reveal action, never the export.
pub fn remember(app: &AppHandle, record: ExportRecord) {
    let Some(state) = app.try_state::<LastExport>() else {
        return;
    };
    if let Ok(mut slot) = state.0.lock() {
        *slot = Some(record);
    }
}

/// Open the folder Fovea last exported into — with the exported file
/// selected when the run produced one file. The path comes from this
/// side's own record, never from the client (same rule as
/// `open_logs_folder`).
#[tauri::command]
pub fn open_export_folder(app: AppHandle) -> AppResult<String> {
    let record = app
        .state::<LastExport>()
        .0
        .lock()
        .map_err(|_| AppError::unexpected("export record poisoned"))?
        .clone()
        .ok_or_else(|| AppError::FileMissing {
            detail: "nothing has been exported yet".into(),
        })?;

    if !record.folder.is_dir() {
        return Err(AppError::FileMissing {
            detail: "the export folder is no longer there".into(),
        });
    }
    let selected = record.file.filter(|f| f.is_file());

    let spawned = {
        #[cfg(windows)]
        {
            // `explorer` exits nonzero even when it opened the window —
            // `spawn` succeeding is the honest signal here.
            let mut cmd = std::process::Command::new("explorer");
            match selected {
                Some(file) => {
                    cmd.arg(format!("/select,{}", file.display()));
                    cmd.spawn().is_ok()
                }
                None => {
                    cmd.arg(&record.folder);
                    cmd.spawn().is_ok()
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            let mut cmd = std::process::Command::new("open");
            match selected {
                Some(file) => {
                    let file = file.to_string_lossy().into_owned();
                    cmd.arg("-R").arg(&file);
                    cmd.spawn().is_ok()
                }
                None => {
                    cmd.arg(&record.folder);
                    cmd.spawn().is_ok()
                }
            }
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            // No reveal-a-file idiom exists across Linux file browsers, so
            // the folder is opened and the selection is dropped.
            let _ = selected;
            std::process::Command::new("xdg-open")
                .arg(&record.folder)
                .spawn()
                .is_ok()
        }
    };
    if !spawned {
        return Err(AppError::unexpected("could not open the file browser"));
    }
    Ok(record.folder.display().to_string())
}
