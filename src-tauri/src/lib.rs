//! Application bootstrap: logging, command registration, lifecycle.

mod commands;
mod config;
mod error;
// Public for the crate's rlib consumers: unit tests, examples, and the
// Stage 06 manual-QA harness drive services directly (the app binary uses
// the command layer; nothing here is exposed to the webview beyond it).
pub mod services;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};

use commands::batch::BatchState;
use commands::inference::EngineState;
use services::history::Store as HistoryStore;
use services::inference::{model::ModelRegistry, service};
use services::settings;

/// Resolve where model files may live, in priority order:
/// 1. `FOVEA_MODELS_DIR` — explicit dev/QA override,
/// 2. the bundled resource dir's `models/` (release),
/// 3. `src-tauri/models` (dev builds — resource staging differs),
/// 4. `<app_data>/models` — the user-installable drop location.
fn model_search_dirs(app: &tauri::App) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = std::env::var("FOVEA_MODELS_DIR") {
        dirs.push(PathBuf::from(dir));
    }
    if let Ok(resource) = app.path().resource_dir() {
        dirs.push(resource.join("models"));
    }
    if cfg!(debug_assertions) {
        dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models"));
    }
    if let Ok(data) = app.path().app_data_dir() {
        dirs.push(data.join("models"));
    }
    dirs
}

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
        // Native dialogs are owned by the Rust side: the UI asks our
        // command to open a picker and receives paths back. The webview
        // itself is never granted dialog or filesystem permissions.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::app::get_config,
            commands::app::get_system_info,
            commands::app::get_diagnostics,
            commands::app::write_frontend_log,
            commands::import::pick_image_files,
            commands::import::import_images,
            commands::import::load_image_view,
            commands::inference::enhance_image,
            commands::inference::cancel_enhancement,
            commands::inference::get_inference_status,
            commands::export::pick_export_folder,
            commands::export::export_enhanced_image,
            commands::export::open_export_folder,
            commands::batch::start_batch,
            commands::batch::cancel_batch_item,
            commands::batch::cancel_batch_all,
            commands::batch::retry_batch_failed,
            commands::batch::get_batch_snapshot,
            commands::history::get_history,
            commands::history::clear_history,
            commands::settings::set_engine_hints,
            commands::app::open_logs_folder,
            commands::license::get_license_status,
            commands::license::activate_license,
            commands::license::deactivate_license,
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
            // Exports land in `Documents/Fovea` (batches in the `Batch`
            // folder under it). Both are made real here, at first start —
            // before the UI ever offers a location — so the place Fovea
            // names on screen is the place that exists. A refusal (roaming
            // profile locked, OneDrive Documents moved) is logged, not
            // fatal: the picker path still works.
            match commands::export::prepare_export_folders(app.handle()) {
                Ok(_) => log::info!("export folders ready under Documents"),
                Err(err) => log::warn!("export folders unavailable: {err}"),
            }

            // Stage 05: the local inference engine. The app runs without
            // it — every command answers with honest errors until a
            // validated model is found.
            let app_data = app.path().app_data_dir().ok();
            // Stage 10: the user's engine-relevant preferences (hardware
            // path, power mode, recents switch) take effect before the
            // engine config derives its memory budgets below — a choice
            // made last session shapes this one from the first job.
            if let Some(dir) = app_data.as_ref() {
                let hints = settings::hydrate(dir);
                log::info!(
                    "engine hints: {}",
                    if hints.cpu_only {
                        "processor (forced)"
                    } else if hints.full_power {
                        "full power"
                    } else {
                        "default"
                    }
                );
            }
            // Stage 13: the licensing picture, logged once at startup —
            // state and edition only, never the holder or key. It exists
            // beside the engine, not inside it: the lines below would
            // read exactly the same with this block deleted.
            if let Some(dir) = app_data.as_ref() {
                let lic = services::license::status(dir);
                log::info!(
                    "license: {} (edition {}, machine {})",
                    lic.state,
                    lic.edition.unwrap_or("free"),
                    lic.machine_hint
                );
            }
            let registry = ModelRegistry::new(model_search_dirs(app));
            log::info!(
                "model registry searching {} dir(s); first model {} ({})",
                registry.search_dirs().len(),
                registry.default_model_id(),
                match registry.locate_by_id(registry.default_model_id()) {
                    services::inference::model::ModelState::Ready { .. } => "ready",
                    services::inference::model::ModelState::Missing => "missing",
                    services::inference::model::ModelState::Corrupt { reason } => {
                        log::warn!("model corrupt: {reason}"); // no path detail
                        "corrupt"
                    }
                }
            );
            let out_dir = app_data
                .as_ref()
                .map(|d| service::enhanced_dir(d))
                .unwrap_or_else(|| std::env::temp_dir().join("fovea-enhanced-fallback"));
            // Leftover *.part scratch from an interrupted run dies here.
            service::cleanup_scratch(&out_dir);
            app.manage(EngineState {
                registry: Arc::new(registry),
                jobs: Arc::new(service::JobRegistry::new()),
                config: service::EngineConfig::default(),
                out_dir,
                outputs: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            });

            // Stage 09: the local journal + recent-files store, loaded
            // once (corrupt file → fresh start, logged). Managed as the
            // Arc itself so command state and the batch worker share one.
            let store_dir = app_data
                .clone()
                .unwrap_or_else(|| std::env::temp_dir().join("fovea-store-fallback"));
            app.manage(HistoryStore::open(&store_dir));
            // Stage 08/09: the batch queue session slot. One at a time;
            // replaced (never appended) when a new batch starts.
            app.manage(BatchState {
                session: std::sync::Mutex::new(None),
            });
            // The folder Fovea last wrote an export into, remembered here
            // so "open the folder" reveals a location this side chose
            // instead of one the webview names.
            app.manage(commands::export::LastExport::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the last window: refuse new jobs and cancel the
            // running one so its scratch file is deleted, not orphaned.
            // The batch worker is flagged shut down too — its per-item
            // journal records survive; unfinished items are marked.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<EngineState>() {
                    state.jobs.shutdown();
                }
                commands::batch::shutdown_batch(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Fovea");
}
