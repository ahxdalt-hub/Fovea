//! Application-level commands: config, system info, diagnostics, frontend
//! log relay.

use serde::Serialize;

use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::services::hardware::{self, HardwareInfo};
use crate::services::inference::service;
use crate::services::system::SystemInfo;
use tauri::{AppHandle, Manager};

/// Return the build configuration so the UI reads identity/version from
/// one authoritative source instead of duplicating constants.
#[tauri::command]
pub fn get_config() -> AppConfig {
    AppConfig::from_build()
}

/// Report the native runtime environment. Proves the full
/// UI → command → service pipeline end to end.
#[tauri::command]
pub fn get_system_info(app: AppHandle) -> AppResult<SystemInfo> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::unexpected(format!("app data dir unavailable: {err}")))?;
    // The directory may not exist until first write; creating it is part of
    // the app owning its storage location.
    std::fs::create_dir_all(&dir)?;
    // The logs dir is display-only here; its resolution must never fail
    // the snapshot, so a missing answer degrades to the documented
    // fallback (app data / `logs`).
    let logs = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| dir.join("logs"));
    // Fovea's own export folders are reported (and created) here, so the UI
    // can name the real place an export lands instead of hiding it behind
    // a label. A Documents folder this machine refuses to hand over is not
    // worth failing the snapshot for: an empty answer keeps the generic
    // label, and the picker still works.
    let exports = crate::commands::export::default_export_dir(&app)
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let batches = crate::commands::export::default_batch_export_dir(&app)
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    Ok(SystemInfo::collect(
        dir.display().to_string(),
        logs.display().to_string(),
        exports,
        batches,
    ))
}

/// Open the app's own log folder in the OS file browser and return the
/// path (so the UI can show exactly what it revealed). Stage 10
/// diagnostics: the path is resolved server-side from Tauri's own
/// resolver — the client never names a location to open.
#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> AppResult<String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|err| AppError::unexpected(format!("log dir unavailable: {err}")))?;
    std::fs::create_dir_all(&dir)?;

    let spawned = {
        #[cfg(windows)]
        {
            // `explorer` exits nonzero even when it opened the window —
            // `spawn` succeeding is the honest signal here.
            std::process::Command::new("explorer")
                .arg(&dir)
                .spawn()
                .is_ok()
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(&dir).spawn().is_ok()
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open")
                .arg(&dir)
                .spawn()
                .is_ok()
        }
    };
    if !spawned {
        return Err(AppError::unexpected("could not open the file browser"));
    }
    Ok(dir.display().to_string())
}

/// Stage 07 diagnostics: what the engine sees about this machine and how
/// it plans to spend it. Everything here is a hardware fact (Task Manager
/// class); no identity, no user data, no image paths.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsDto {
    /// CPU/GPU/memory snapshot (collected once, cached).
    pub hardware: HardwareInfo,
    /// Device a *new* session will use, as the DirectML EP itself answers
    /// it ("DirectML GPU" | "CPU") — not a guess from the adapter list.
    pub engine_device: &'static str,
    /// Tile-output float buffer cap, in bytes (the runtime's budget).
    pub max_tile_bytes: usize,
    /// Streaming band buffer cap, in bytes (Fovea's own budget).
    pub max_band_bytes: usize,
    /// Which pool the tile budget is squeezed by, for display.
    pub memory_limit: &'static str,
}

/// Cheap after first call: the hardware snapshot is cached, and the EP
/// availability question too — but both are real native work, so they run
/// off the UI thread (the first call initializes ONNX Runtime's view of
/// the DirectML provider).
#[tauri::command]
pub async fn get_diagnostics(app: AppHandle) -> AppResult<DiagnosticsDto> {
    use crate::commands::inference::EngineState;
    let config = app.state::<EngineState>().config;
    tauri::async_runtime::spawn_blocking(move || {
        let hw = hardware::detect();
        Ok(DiagnosticsDto {
            hardware: hw.clone(),
            engine_device: service::probe_device(),
            max_tile_bytes: config.max_tile_bytes,
            max_band_bytes: config.max_band_bytes,
            memory_limit: hw.memory_limit_label(),
        })
    })
    .await
    .map_err(|e| AppError::unexpected(format!("diagnostics task failed: {e}")))?
}

/// Relay a message from the webview console into the native log file.
///
/// Capped length and stripped of control characters: the frontend can
/// enrich logs, never flood or corrupt them. No image data ever passes
/// through this boundary.
#[tauri::command]
pub fn write_frontend_log(level: String, message: String) -> AppResult<()> {
    const MAX_LEN: usize = 2_000;
    let clean: String = message
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_LEN)
        .collect();
    match level.as_str() {
        "error" => log::error!("[frontend] {clean}"),
        "warn" => log::warn!("[frontend] {clean}"),
        "debug" => log::debug!("[frontend] {clean}"),
        _ => log::info!("[frontend] {clean}"),
    }
    Ok(())
}
