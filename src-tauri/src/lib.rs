//! Application bootstrap: logging, command registration, lifecycle.

mod commands;
mod config;
mod error;
mod services;

use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};

/// Called by `main.rs`. Kept separate so integration tests and later
/// headless variants can reuse the same builder.
pub fn run() {
    tauri::Builder::default()
        // Logging: dev builds mirror to stdout so `tauri dev` output is
        // useful immediately; every build also persists to the app's log
        // directory for diagnosing field issues. Image contents and user
        // file paths of *processed images* must never be added to logs.
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                ])
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::app::get_config,
            commands::app::get_system_info,
            commands::app::write_frontend_log
        ])
        .setup(|app| {
            let cfg = config::AppConfig::from_build();
            log::info!(
                "{} v{} starting (debug={})",
                cfg.product_name,
                cfg.version,
                cfg.debug
            );
            // Surface a visible failure early rather than a silent half-start.
            if let Err(err) = app.path().app_data_dir() {
                log::warn!("app data dir unavailable: {err}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Pixora");
}
