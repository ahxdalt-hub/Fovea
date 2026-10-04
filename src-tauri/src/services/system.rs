//! System information service.
//!
//! The only native capability live at Stage 01: report a small, honest
//! description of the running environment. This doubles as the sanity
//! check that the whole UI → command → service pipeline works.

use serde::Serialize;

/// Snapshot of the native runtime, safe to display in the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// OS family as reported by the compile target, e.g. `windows`.
    pub os_family: &'static str,
    /// CPU architecture of the running binary, e.g. `x86_64`.
    pub arch: &'static str,
    /// Application data directory owned by the app (where logs, settings,
    /// and future caches live). Absolute path, as a display string.
    pub app_data_dir: String,
    /// Where the log file lives (Stage 10 diagnostics). Absolute path, as
    /// a display string; the app's own log dir — never user data.
    pub logs_dir: String,
    /// Fovea's own export folder (`Documents/Fovea`) — the location an
    /// export lands in when the user never chose one. Absolute path, as a
    /// display string, so the UI can name the place instead of hiding it
    /// behind a label.
    pub default_export_dir: String,
    /// The batch sibling (`Documents/Fovea/Batch`) — where an unattended
    /// run writes its files. Same reasoning as above: the UI reports the
    /// path the native layer actually uses, never one it constructed.
    pub default_batch_export_dir: String,
}

impl SystemInfo {
    /// Collect system info. The directories are passed in by the command
    /// because only Tauri's path resolver knows the real locations.
    pub fn collect(
        app_data_dir: String,
        logs_dir: String,
        default_export_dir: String,
        default_batch_export_dir: String,
    ) -> Self {
        SystemInfo {
            os_family: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            app_data_dir,
            logs_dir,
            default_export_dir,
            default_batch_export_dir,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_current_platform() {
        let info = SystemInfo::collect(
            "C:/Fake/AppData".into(),
            "C:/Fake/Logs".into(),
            "C:/Fake/Documents/Fovea".into(),
            "C:/Fake/Documents/Fovea/Batch".into(),
        );
        assert_eq!(info.os_family, std::env::consts::OS);
        assert_eq!(info.arch, std::env::consts::ARCH);
        assert_eq!(info.app_data_dir, "C:/Fake/AppData");
        assert_eq!(info.logs_dir, "C:/Fake/Logs");
        assert_eq!(info.default_export_dir, "C:/Fake/Documents/Fovea");
        assert_eq!(
            info.default_batch_export_dir,
            "C:/Fake/Documents/Fovea/Batch"
        );
    }

    #[test]
    fn serializes_camel_case() {
        let info = SystemInfo::collect("x".into(), "y".into(), "z".into(), "w".into());
        let json = serde_json::to_value(&info).expect("serialize");
        assert!(json.get("appDataDir").is_some());
        assert!(json.get("osFamily").is_some());
        assert!(json.get("logsDir").is_some());
        assert!(json.get("defaultExportDir").is_some());
        assert!(json.get("defaultBatchExportDir").is_some());
    }
}
