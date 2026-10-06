//! Application configuration.
//!
//! A single serializable `AppConfig` describes product identity and the
//! runtime paths the application owns. Environment-specific behaviour
//! (dev vs production) is resolved once at startup, and the frontend reads
//! it through the `get_config` command rather than hard-coding values.

use serde::Serialize;

include!(concat!(env!("OUT_DIR"), "/build_plan.rs"));

/// The product name a build plan carries. This is the *same* string the
/// tier's `tauri*.conf.json` sets as `productName` — a test below reads those
/// files and compares, so the exe name and the name inside the window cannot
/// drift apart.
pub fn product_name_for(plan: &str) -> &'static str {
    match plan {
        "pro" => "Fovea Pro",
        "studio" => "Fovea Studio",
        _ => "Fovea",
    }
}

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
    /// The plan this build ships as (`free` | `pro` | `studio`) — branding
    /// only. What the machine is *allowed* to do comes from the license
    /// record, never from this field.
    pub build_plan: &'static str,
}

impl AppConfig {
    /// Build the configuration from build-time metadata.
    ///
    /// Values come from `Cargo.toml`/`tauri.conf.json` equivalents so they
    /// stay in sync with the bundle and never drift from user input.
    pub fn from_build() -> Self {
        AppConfig {
            product_name: product_name_for(BUILD_PLAN).to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            identifier: "com.fovea.desktop".to_string(),
            debug: cfg!(debug_assertions),
            build_plan: BUILD_PLAN,
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

    /// Every tier's branded name has to be the name its installer declares,
    /// or the window contradicts the exe the customer downloaded.
    #[test]
    fn product_names_match_the_tier_configs() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        for (plan, file) in [
            ("free", "tauri.conf.json"),
            ("pro", "tauri.pro.conf.json"),
            ("studio", "tauri.studio.conf.json"),
        ] {
            let raw = std::fs::read_to_string(manifest.join(file))
                .unwrap_or_else(|err| panic!("read {file}: {err}"));
            let conf: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or_else(|err| panic!("parse {file}: {err}"));
            assert_eq!(
                conf["productName"].as_str(),
                Some(product_name_for(plan)),
                "{file} names a product the app would not show"
            );
        }
    }

    #[test]
    fn an_unmarked_build_is_the_free_one() {
        // Dev builds set nothing; the default must never claim a paid name.
        assert_eq!(product_name_for("free"), "Fovea");
        assert_eq!(product_name_for(""), "Fovea");
    }

    /// The name and the plan come from one marker, so a branded installer
    /// cannot report a name its plan does not carry.
    #[test]
    fn the_build_names_itself_after_its_marker() {
        let cfg = AppConfig::from_build();
        assert_eq!(cfg.product_name, product_name_for(cfg.build_plan));
        assert!(matches!(cfg.build_plan, "free" | "pro" | "studio"));
    }

    /// `--nocapture` proof that the packaging marker reached the binary:
    /// `FOVEA_BUILD_PLAN=pro cargo test --lib config` prints `pro`.
    #[test]
    fn marker_is_compiled_in() {
        println!("this build's plan: {BUILD_PLAN}");
    }
}
