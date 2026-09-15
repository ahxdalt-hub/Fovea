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
#[allow(dead_code, reason = "variants are reserved for later-stage services")]
#[derive(Debug, Clone)]
pub enum AppError {
    /// The selected file is not a readable/valid image.
    InvalidImage { detail: String },
    /// The image format is not supported by the engine.
    UnsupportedFormat { detail: String },
    /// A processing job failed.
    ProcessingFailed { detail: String },
    /// Not enough memory/VRAM/disk to complete an operation.
    InsufficientResources { detail: String },
    /// The OS denied a file or hardware operation.
    PermissionDenied { detail: String },
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
            AppError::PermissionDenied { .. } => "permission_denied",
            AppError::Unexpected { .. } => "unexpected_error",
        }
    }

    /// User-facing message. Calm, specific enough to act on, never technical.
    pub fn user_message(&self) -> &'static str {
        match self {
            AppError::InvalidImage { .. } => "The selected file could not be read as an image.",
            AppError::UnsupportedFormat { .. } => {
                "This image format is not supported yet. Try PNG or JPEG."
            }
            AppError::ProcessingFailed { .. } => {
                "Processing failed. Try again, and check the application log for details."
            }
            AppError::InsufficientResources { .. } => {
                "Not enough system resources are available to complete this operation."
            }
            AppError::PermissionDenied { .. } => {
                "Access to the requested location was denied by Windows."
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
}

fn other_detail(err: &AppError) -> &str {
    match err {
        AppError::InvalidImage { detail }
        | AppError::UnsupportedFormat { detail }
        | AppError::ProcessingFailed { detail }
        | AppError::InsufficientResources { detail }
        | AppError::PermissionDenied { detail }
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
            ErrorKind::OutOfMemory | ErrorKind::StorageFull => AppError::InsufficientResources {
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
            "This image format is not supported yet. Try PNG or JPEG."
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
                AppError::ProcessingFailed { detail: "x".into() },
                "processing_failed",
            ),
            (AppError::unexpected("boom"), "unexpected_error"),
        ];
        for (err, code) in cases {
            assert_eq!(err.code(), code);
        }
    }
}
