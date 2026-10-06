//! Application error foundation.
//!
//! `AppError` is the single error type that crosses the native boundary.
//! The UI never sees raw internal details: every error serializes to a
//! structured `{ code, message }` payload where `message` is safe to show
//! to a user. Internal detail is logged separately via [`AppError::log`].

use serde::Serializer;

/// Result alias used by services and commands.
pub type AppResult<T> = Result<T, AppError>;

/// Every failure the native layer can report.
///
/// The `detail` field carries internal context (paths, engine messages).
/// It is only ever written to the log, never sent to the frontend.
///
/// Several variants are constructed by services that arrive in later
/// stages (image validation, processing). The full error vocabulary is
/// part of this foundation and is tested here, so dead-code analysis is
/// intentionally relaxed for this module.
/// Several variants are constructed by services that arrive in later
/// stages (processing, resources). The full error vocabulary is
/// part of this foundation and is tested here, so dead-code analysis is
/// intentionally relaxed for this module.
#[allow(dead_code, reason = "variants are reserved for later-stage services")]
#[derive(Debug, Clone)]
pub enum AppError {
    /// The selected file is not a readable/valid image.
    InvalidImage { detail: String },
    /// The image format is not supported by the engine.
    UnsupportedFormat { detail: String },
    /// A processing job failed.
    ProcessingFailed { detail: String },
    /// Not enough memory/VRAM to complete an operation.
    InsufficientResources { detail: String },
    /// Not enough free disk space to write the result (Stage 12: distinct
    /// from InsufficientResources so the engine's memory ladder never
    /// retries a job that can only end one way).
    InsufficientDisk { detail: String },
    /// The OS denied a file or hardware operation.
    PermissionDenied { detail: String },
    /// The file existed when shown to the user but is gone now.
    FileMissing { detail: String },
    /// The file or its decoded size exceeds an import safety limit.
    FileTooLarge { detail: String },
    /// The inference engine could not start (runtime init failure).
    EngineUnavailable { detail: String },
    /// A required enhancement model is not installed.
    ModelMissing { detail: String },
    /// A model file exists but failed validation (hash/size/structure).
    ModelCorrupt { detail: String },
    /// The requested upscale isn't genuinely deliverable by the installed
    /// model (e.g. asking an odd-factor model for a half-size pass).
    UnsupportedScale { detail: String },
    /// The user cancelled the operation. Carries no fault.
    Cancelled { detail: String },
    /// The chosen export codec has a hard ceiling this image exceeds —
    /// WebP caps any edge at 16383 px. The master is fine; the format is
    /// not, so this is named as its own condition rather than a crash or a
    /// vague "processing failed".
    ExportLimit { detail: String },
    /// Stage 13 licensing: the pasted key is not a license this build can
    /// honour — malformed, not a Fovea key, or the signature fails. One
    /// variant on purpose: telling a user *which* of those is never
    /// actionable for them, and never useful to a forger.
    LicenseInvalid { detail: String },
    /// The key was fine, but its validity window has closed.
    LicenseExpired { detail: String },
    /// An optional license service reported the key revoked. The offline
    /// default provider never produces this — absence of an answer is
    /// never treated as a revocation.
    LicenseRevoked { detail: String },
    /// The key is signed for a different machine.
    LicenseWrongMachine { detail: String },
    /// This machine's clock sits below the last time Fovea recorded —
    /// the shape of a rollback attempt against an expiring license.
    LicenseClockSuspect { detail: String },
    /// The key is newer than this build understands; update Fovea.
    LicenseUnsupportedVersion { detail: String },
    /// Neither the credential store nor the app-data file accepted the
    /// key on activation (or deactivation couldn't reach them).
    LicenseStoreUnavailable { detail: String },
    /// Stage 20 entitlements: the in-force license does not include this
    /// capability (4×, a restoration mode, an engine control). Detail
    /// names the feature and the plan that carries it — log only, since
    /// the UI already knows which control the user touched.
    FeatureLocked { detail: String },
    /// The free plan's monthly enhancement allowance is used up. The count
    /// is kept on Fovea's server and cached here, so a different calendar
    /// month is the server's decision, not this machine's clock. This is a
    /// commercial boundary, not a fault with the user's file.
    QuotaExceeded { detail: String },
    /// The meter could not be reached, and this install has never spoken to
    /// it. Only the server's reply says which month is current and what is
    /// left in it, so a first run with no network cannot honestly grant an
    /// allowance — unlike a machine that has synced, which keeps working on
    /// its cached balance offline.
    MeterUnreachable { detail: String },
    /// Anything that did not fit the expected failure categories.
    Unexpected { detail: String },
}

impl AppError {
    /// Stable machine-readable code the UI can branch on.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::InvalidImage { .. } => "invalid_image",
            AppError::UnsupportedFormat { .. } => "unsupported_format",
            AppError::ProcessingFailed { .. } => "processing_failed",
            AppError::InsufficientResources { .. } => "insufficient_resources",
            AppError::InsufficientDisk { .. } => "insufficient_disk",
            AppError::PermissionDenied { .. } => "permission_denied",
            AppError::FileMissing { .. } => "file_missing",
            AppError::FileTooLarge { .. } => "file_too_large",
            AppError::EngineUnavailable { .. } => "engine_unavailable",
            AppError::ModelMissing { .. } => "model_missing",
            AppError::ModelCorrupt { .. } => "model_corrupt",
            AppError::UnsupportedScale { .. } => "unsupported_scale",
            AppError::Cancelled { .. } => "cancelled",
            AppError::ExportLimit { .. } => "export_limit",
            AppError::LicenseInvalid { .. } => "license_invalid",
            AppError::LicenseExpired { .. } => "license_expired",
            AppError::LicenseRevoked { .. } => "license_revoked",
            AppError::LicenseWrongMachine { .. } => "license_wrong_machine",
            AppError::LicenseClockSuspect { .. } => "license_clock_suspect",
            AppError::LicenseUnsupportedVersion { .. } => "license_unsupported_version",
            AppError::LicenseStoreUnavailable { .. } => "license_store_unavailable",
            AppError::FeatureLocked { .. } => "feature_locked",
            AppError::QuotaExceeded { .. } => "quota_exceeded",
            AppError::MeterUnreachable { .. } => "meter_unreachable",
            AppError::Unexpected { .. } => "unexpected_error",
        }
    }

    /// User-facing message. Calm, specific enough to act on, never technical.
    pub fn user_message(&self) -> &'static str {
        match self {
            AppError::InvalidImage { .. } => {
                "That file doesn't look like a valid image. It may be damaged or incomplete."
            }
            AppError::UnsupportedFormat { .. } => {
                "This file type isn't supported yet. Try a JPG, PNG, or WebP image."
            }
            AppError::ProcessingFailed { .. } => {
                "Processing failed. Try again, and check the application log for details."
            }
            AppError::InsufficientResources { .. } => {
                "Not enough system resources are available to complete this operation."
            }
            AppError::InsufficientDisk { .. } => {
                "Not enough free disk space to save that. Free up space and try again."
            }
            AppError::PermissionDenied { .. } => {
                "Windows won't let Fovea open that file. Check its location and permissions."
            }
            AppError::FileMissing { .. } => {
                "That file is no longer where it was. It may have been moved or deleted."
            }
            AppError::FileTooLarge { .. } => {
                "That image is too large to import. Fovea supports images up to 64 megapixels."
            }
            AppError::EngineUnavailable { .. } => {
                "The local AI engine couldn't start. Restart Fovea; if it persists, check the application log."
            }
            AppError::ModelMissing { .. } => {
                "The enhancement model isn't installed yet. Place it in Fovea's models folder and try again."
            }
            AppError::ModelCorrupt { .. } => {
                "The enhancement model file is damaged or incomplete. Re-download it into Fovea's models folder."
            }
            AppError::UnsupportedScale { .. } => {
                "This upscale size isn't supported by the installed model. Pick a supported size."
            }
            AppError::Cancelled { .. } => "Processing was cancelled.",
            AppError::ExportLimit { .. } => {
                "That image is bigger than this export format can store. Export it as PNG instead."
            }
            AppError::LicenseInvalid { .. } => {
                "That doesn't read as a Fovea license key. Copy it again from your purchase email and try once more."
            }
            AppError::LicenseExpired { .. } => {
                "That license key has expired. Renew it to get your paid options back — until then Fovea keeps working on the free plan."
            }
            AppError::LicenseRevoked { .. } => {
                "That license key was revoked by its issuer. Contact the store where you bought it."
            }
            AppError::LicenseWrongMachine { .. } => {
                "That license key is bound to a different computer. Ask the store where you bought it to re-issue for this machine."
            }
            AppError::LicenseClockSuspect { .. } => {
                "This computer's clock is behind the last time Fovea ran. Correct the date and time in Windows settings, then restart Fovea."
            }
            AppError::LicenseUnsupportedVersion { .. } => {
                "That license key is newer than this version of Fovea. Update Fovea and activate again."
            }
            AppError::LicenseStoreUnavailable { .. } => {
                "Fovea couldn't save the license on this computer. Check free disk space and app-data permissions, then try again."
            }
            AppError::FeatureLocked { .. } => {
                "That option isn't part of the plan you're running. Upgrade to unlock it — images you've already enhanced stay exactly as they are."
            }
            AppError::QuotaExceeded { .. } => {
                "You've used this month's free enhancements. The count resets at the start of next month, or upgrade for unlimited processing."
            }
            AppError::MeterUnreachable { .. } => {
                "Fovea needs one internet connection to set up this month's free allowance. Connect, then try again — after that, enhancing works offline."
            }
            AppError::Unexpected { .. } => "Something went wrong. The application log may help.",
        }
    }

    /// Write the internal detail to the application log.
    ///
    /// Never logs file contents or image data — only short contextual detail
    /// supplied by the failing service.
    #[allow(
        dead_code,
        reason = "wired into every service return path from Stage 02 onward"
    )]
    pub fn log(&self) {
        match self {
            AppError::Unexpected { detail } => log::error!("[{}] {}", self.code(), detail),
            other => log::warn!("[{}] {}", other.code(), other_detail(other)),
        }
    }

    /// Convenience constructor for genuinely unexpected failures.
    pub fn unexpected(context: impl std::fmt::Display) -> Self {
        AppError::Unexpected {
            detail: context.to_string(),
        }
    }

    /// The free-plan meter returned no answer. Detail names the transport
    /// reason; the message the user sees is the same either way, because
    /// "DNS failed" and "connection reset" ask the same fix of them.
    pub fn meter_unreachable(context: impl std::fmt::Display) -> Self {
        AppError::MeterUnreachable {
            detail: context.to_string(),
        }
    }
}

fn other_detail(err: &AppError) -> &str {
    match err {
        AppError::InvalidImage { detail }
        | AppError::UnsupportedFormat { detail }
        | AppError::ProcessingFailed { detail }
        | AppError::InsufficientResources { detail }
        | AppError::InsufficientDisk { detail }
        | AppError::PermissionDenied { detail }
        | AppError::FileMissing { detail }
        | AppError::FileTooLarge { detail }
        | AppError::EngineUnavailable { detail }
        | AppError::ModelMissing { detail }
        | AppError::ModelCorrupt { detail }
        | AppError::UnsupportedScale { detail }
        | AppError::Cancelled { detail }
        | AppError::ExportLimit { detail }
        | AppError::LicenseInvalid { detail }
        | AppError::LicenseExpired { detail }
        | AppError::LicenseRevoked { detail }
        | AppError::LicenseWrongMachine { detail }
        | AppError::LicenseClockSuspect { detail }
        | AppError::LicenseUnsupportedVersion { detail }
        | AppError::LicenseStoreUnavailable { detail }
        | AppError::FeatureLocked { detail }
        | AppError::QuotaExceeded { detail }
        | AppError::MeterUnreachable { detail }
        | AppError::Unexpected { detail } => detail,
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code(), other_detail(self))
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        use std::io::ErrorKind;
        match err.kind() {
            ErrorKind::PermissionDenied => AppError::PermissionDenied {
                detail: err.to_string(),
            },
            ErrorKind::OutOfMemory => AppError::InsufficientResources {
                detail: err.to_string(),
            },
            ErrorKind::StorageFull => AppError::InsufficientDisk {
                detail: err.to_string(),
            },
            _ => AppError::Unexpected {
                detail: err.to_string(),
            },
        }
    }
}

/// Serialize as a flat, safe `{ code, message }` object for the frontend.
impl serde::Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", self.user_message())?;
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_serializes_to_safe_payload() {
        let err = AppError::UnsupportedFormat {
            detail: r"decoder rejected TIFF at C:\secret\photo.tif".into(),
        };
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["code"], "unsupported_format");
        assert_eq!(
            json["message"],
            "This file type isn't supported yet. Try a JPG, PNG, or WebP image."
        );
        // Internal detail must never cross the boundary.
        let serialized = json.to_string();
        assert!(!serialized.contains("TIFF"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn codes_are_stable() {
        let cases = [
            (
                AppError::InvalidImage { detail: "x".into() },
                "invalid_image",
            ),
            (
                AppError::PermissionDenied { detail: "x".into() },
                "permission_denied",
            ),
            (
                AppError::InsufficientResources { detail: "x".into() },
                "insufficient_resources",
            ),
            (
                AppError::InsufficientDisk { detail: "x".into() },
                "insufficient_disk",
            ),
            (
                AppError::ProcessingFailed { detail: "x".into() },
                "processing_failed",
            ),
            (
                AppError::FeatureLocked { detail: "x".into() },
                "feature_locked",
            ),
            (
                AppError::QuotaExceeded { detail: "x".into() },
                "quota_exceeded",
            ),
            (AppError::meter_unreachable("x"), "meter_unreachable"),
            (AppError::unexpected("boom"), "unexpected_error"),
        ];
        for (err, code) in cases {
            assert_eq!(err.code(), code);
        }
    }

    /// Stage 12: io failures carry their resource — a full disk is disk,
    /// not "memory" or a generic fault.
    #[test]
    fn io_errors_map_to_their_resource() {
        let disk = std::io::Error::from(std::io::ErrorKind::StorageFull);
        assert_eq!(AppError::from(disk).code(), "insufficient_disk");
        let mem = std::io::Error::from(std::io::ErrorKind::OutOfMemory);
        assert_eq!(AppError::from(mem).code(), "insufficient_resources");
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(AppError::from(denied).code(), "permission_denied");
    }
}
