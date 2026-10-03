//! License commands (Stage 13) — the whole licensing surface.
//!
//! Three commands, one service. They deliberately say nothing about
//! what the app can *do*: activation state never changes how images are
//! processed (see `services::license` coupling rules). The DTO carries
//! the commercial identity — edition, holder, expiry — for display and
//! for the feature-access seam that future policy would use.

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

fn app_data(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|err| AppError::LicenseStoreUnavailable {
            detail: format!("app data dir unavailable: {err}"),
        })
}
