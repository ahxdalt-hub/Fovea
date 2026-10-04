//! License commands (Stage 13) — the whole licensing surface.
//!
//! Three commands, one service, plus the `app_data` resolver the gated
//! commands share. These commands report the commercial identity (edition,
//! holder, expiry, meter); the *enforcement* of that identity lives in the
//! commands that do the work (`enhance_image`, `start_batch`,
//! `set_engine_hints`), each asking `services::license::entitlement` at
//! its own boundary. See that module for the coupling rules.

use tauri::AppHandle;
use tauri::Manager;

use crate::error::{AppError, AppResult};
use crate::services::license::{self, ActivationDto, LicenseStatusDto};

/// The local license state, verified fresh from the stored signature.
/// Never fails on "no license" — that is a state, not an error. A store
/// this process genuinely cannot read reports honestly instead.
#[tauri::command]
pub fn get_license_status(app: AppHandle) -> AppResult<LicenseStatusDto> {
    let dir = app_data(&app)?;
    Ok(license::status(&dir))
}

/// Activate a pasted license key. Offline-capable by design: the vendor
/// signature is the proof, connectivity is not required. Rejects with a
/// human-readable license error on bad keys (never a raw verification
/// detail).
#[tauri::command]
pub fn activate_license(app: AppHandle, key: String) -> AppResult<ActivationDto> {
    let dir = app_data(&app)?;
    license::activate(&dir, &key)
}

/// Deactivate on this machine: forget the stored key (the vendor-issued
/// key itself stays valid — re-entering it re-activates).
#[tauri::command]
pub fn deactivate_license(app: AppHandle) -> AppResult<LicenseStatusDto> {
    let dir = app_data(&app)?;
    Ok(license::deactivate(&dir))
}

/// The app-data directory every license-side read needs: the stored key,
/// the meter. Shared with the commands that gate on an entitlement, so
/// there is exactly one place that can say "this machine has no app data".
pub(crate) fn app_data(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|err| AppError::LicenseStoreUnavailable {
            detail: format!("app data dir unavailable: {err}"),
        })
}
