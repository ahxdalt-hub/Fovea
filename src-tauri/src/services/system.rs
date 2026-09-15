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
}

impl SystemInfo {
    /// Collect system info. `app_data_dir` is passed in by the command
    /// because only Tauri's path resolver knows the real location.
    pub fn collect(app_data_dir: String) -> Self {
        SystemInfo {
            os_family: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            app_data_dir,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_current_platform() {
        let info = SystemInfo::collect("C:/Fake/AppData".into());
        assert_eq!(info.os_family, std::env::consts::OS);
        assert_eq!(info.arch, std::env::consts::ARCH);
        assert_eq!(info.app_data_dir, "C:/Fake/AppData");
    }

    #[test]
    fn serializes_camel_case() {
        let info = SystemInfo::collect("x".into());
        let json = serde_json::to_value(&info).expect("serialize");
        assert!(json.get("appDataDir").is_some());
        assert!(json.get("osFamily").is_some());
    }
}
