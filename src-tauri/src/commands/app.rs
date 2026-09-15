//! Application-level commands: config, system info, frontend log relay.

use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
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
    Ok(SystemInfo::collect(dir.display().to_string()))
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
