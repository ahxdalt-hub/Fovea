//! Application configuration.
//!
//! A single serializable `AppConfig` describes product identity and the
//! runtime paths the application owns. Environment-specific behaviour
//! (dev vs production) is resolved once at startup, and the frontend reads
//! it through the `get_config` command rather than hard-coding values.

use serde::Serialize;

/// Paths and product settings resolved at startup.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// Human-readable product name shown in the window title and dialogs.
    pub product_name: String,
    /// Semantic version of the application bundle.
    pub version: String,
    /// Stable identifier used for config/log storage locations.
    pub identifier: String,
    /// True when running a debug build (drives verbose logging in the UI).
    pub debug: bool,
}

impl AppConfig {
    /// Build the configuration from build-time metadata.
    ///
    /// Values come from `Cargo.toml`/`tauri.conf.json` equivalents so they
    /// stay in sync with the bundle and never drift from user input.
    pub fn from_build() -> Self {
        AppConfig {
            product_name: "Local AI Image Upscaler".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            identifier: "com.localaiimageupscaler.desktop".to_string(),
            debug: cfg!(debug_assertions),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_carries_package_version() {
        let cfg = AppConfig::from_build();
        assert_eq!(cfg.version, env!("CARGO_PKG_VERSION"));
        assert!(!cfg.product_name.is_empty());
        assert_eq!(cfg.debug, cfg!(debug_assertions));
    }
}
