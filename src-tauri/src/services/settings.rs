//! Engine-relevant settings (Stage 10) — the native projection of the
//! user's preferences.
//!
//! The Settings page is owned by the frontend (localStorage is the full
//! record). But three preferences change what the *engine and services*
//! must do — including before the first frame ever renders a window:
//!
//! - `cpuOnly` — never touch the GPU path (the honest off-switch a user
//!   can reach from Settings, mirroring `GpuPreference::CpuOnly`);
//! - `fullPower` — let CPU-bound work use every logical processor
//!   instead of capping at the physical cores;
//! - `recordRecents` — whether imports feed the recent-files list.
//!
//! Those three are mirrored here as `settings.json` in the app-data dir:
//! atomic save (temp + rename, the journal's discipline), corrupt file →
//! defaults with a log line, unknown version → same. The frontend re-
//! syncs on every change *and* at boot, so this file is a cache that
//! outlives the UI it describes — never a second source of truth to
//! disagree with.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

/// The projection of user settings the native side honours.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineHints {
    /// Force the CPU inference path (skip the DirectML attempt entirely).
    pub cpu_only: bool,
    /// Let CPU-bound work claim every logical processor.
    pub full_power: bool,
    /// Record imported files in the recent-files list.
    pub record_recents: bool,
}

impl Default for EngineHints {
    fn default() -> Self {
        EngineHints {
            cpu_only: false,
            full_power: false,
            record_recents: true,
        }
    }
}

/// On-disk shape. `version` guards the format, same discipline as the
/// journal: a file from a future version is never guessed at.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    version: u32,
    hints: EngineHints,
}

const STORE_VERSION: u32 = 1;

static CPU_ONLY: AtomicBool = AtomicBool::new(false);
static FULL_POWER: AtomicBool = AtomicBool::new(false);
static RECORD_RECENTS: AtomicBool = AtomicBool::new(true);
/// App-data dir, captured at startup so updates can persist themselves.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

fn file_in(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

/// Load the persisted hints and put them in effect. Called once during
/// setup, *before* the engine config derives its budgets, so a user who
/// chose the processor path gets CPU-sized budgets from the first run.
pub fn hydrate(app_data: &Path) -> EngineHints {
    let _ = DATA_DIR.set(app_data.to_path_buf());
    let hints = read(app_data);
    apply(hints);
    hints
}

fn read(app_data: &Path) -> EngineHints {
    let path = file_in(app_data);
    let raw = match std::fs::read(&path) {
        Ok(r) => r,
        Err(e) if path.exists() => {
            log::warn!("settings file unreadable: {e}");
            return EngineHints::default();
        }
        Err(_) => return EngineHints::default(), // first run — no file yet
    };
    match serde_json::from_slice::<Persisted>(&raw) {
        Ok(p) if p.version == STORE_VERSION => p.hints,
        Ok(p) => {
            log::warn!(
                "settings file has unknown version {} — using defaults",
                p.version
            );
            EngineHints::default()
        }
        Err(e) => {
            log::warn!("settings file corrupt: {e}");
            EngineHints::default()
        }
    }
}

fn apply(hints: EngineHints) {
    CPU_ONLY.store(hints.cpu_only, Ordering::Relaxed);
    FULL_POWER.store(hints.full_power, Ordering::Relaxed);
    RECORD_RECENTS.store(hints.record_recents, Ordering::Relaxed);
}

/// Take effect immediately and persist to the app-data file. A failed
/// write is logged, never fatal — the in-memory hints stay correct for
/// this session, and the frontend re-syncs (and re-writes) at next boot.
pub fn update(app_data: Option<&Path>, hints: EngineHints) {
    apply(hints);
    let Some(dir) = app_data.or(DATA_DIR.get().map(PathBuf::as_path)) else {
        log::warn!("settings: no app-data dir; hints apply to this run only");
        return;
    };
    if let Err(e) = save(dir, hints) {
        log::warn!("settings save failed: {e}");
    }
}

fn save(app_data: &Path, hints: EngineHints) -> std::io::Result<()> {
    std::fs::create_dir_all(app_data)?;
    let path = file_in(app_data);
    let json = serde_json::to_vec_pretty(&Persisted {
        version: STORE_VERSION,
        hints,
    })
    .map_err(|e| std::io::Error::other(e.to_string()))?;
    let tmp = path.with_extension("json.part");
    std::fs::write(&tmp, &json)?;
    let commit = || {
        #[cfg(windows)]
        {
            // A plain rename refuses to replace an existing file on
            // Windows; the store replaces its own previous version.
            if path.exists() {
                std::fs::remove_file(&path)?;
            }
            std::fs::rename(&tmp, &path)
        }
        #[cfg(not(windows))]
        std::fs::rename(&tmp, &path)
    };
    commit().inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

// ── Live reads (atomics: every service check is a single load) ──────

pub fn cpu_only() -> bool {
    CPU_ONLY.load(Ordering::Relaxed)
}

pub fn full_power() -> bool {
    FULL_POWER.load(Ordering::Relaxed)
}

pub fn record_recents() -> bool {
    RECORD_RECENTS.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pixora-settings-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn missing_file_hydrates_to_defaults() {
        let dir = scratch("missing");
        let hints = read(&dir);
        assert_eq!(hints, EngineHints::default());
        assert!(!file_in(&dir).exists()); // reading creates nothing
    }

    #[test]
    fn round_trip_survives_restart() {
        // "Restart" is a new read of the same file — the persistence
        // half only, so the process-global hint atomics are untouched.
        let dir = scratch("restart");
        let chosen = EngineHints {
            cpu_only: true,
            full_power: false,
            record_recents: false,
        };
        save(&dir, chosen).expect("save");
        assert_eq!(read(&dir), chosen);
    }

    #[test]
    fn hydrate_reads_applies_and_returns_the_stored_hints() {
        // What startup does: read the file, put the hints in effect,
        // return them for logging. The live window is kept to back-to-
        // back statements (the atomics are process-global — see the
        // update test above for the same discipline).
        let dir = scratch("hydrate");
        let chosen = EngineHints {
            cpu_only: true,
            full_power: true,
            record_recents: false,
        };
        save(&dir, chosen).expect("save");
        let got = hydrate(&dir);
        let live = (cpu_only(), full_power(), record_recents());
        apply(EngineHints::default());
        assert_eq!(got, chosen);
        assert_eq!(live, (true, true, false)); // applied, not just returned
    }

    #[test]
    fn corrupt_and_unknown_version_fall_back_to_defaults() {
        let dir = scratch("corrupt");
        std::fs::write(file_in(&dir), b"{ definitely not json").unwrap();
        assert_eq!(read(&dir), EngineHints::default());
        std::fs::write(
            file_in(&dir),
            br#"{"version": 99, "hints": {"cpuOnly": true, "fullPower": true, "recordRecents": false}}"#,
        )
        .unwrap();
        assert_eq!(read(&dir), EngineHints::default());
    }

    #[test]
    fn update_applies_live_and_persists_when_dir_known() {
        // The hint statics are process-global and concurrent engine
        // tests read them through `force_cpu()`, so the live check
        // applies non-default values for nanoseconds, then restores.
        let chosen = EngineHints {
            cpu_only: true,
            full_power: true,
            record_recents: true,
        };
        apply(chosen);
        let live = (cpu_only(), full_power(), record_recents());
        apply(EngineHints::default());
        assert_eq!(live, (true, true, true));
        assert!(!cpu_only());
        assert!(!full_power());
        assert!(record_recents());

        // The persistence half, with no live side effects at all.
        let dir = scratch("live");
        save(&dir, chosen).expect("save");
        assert_eq!(read(&dir), chosen);
    }

    #[test]
    fn update_persists_via_known_dir_and_applies_defaults_safely() {
        // `update` is what the command calls: apply + (if a dir is set)
        // save. Exercised with defaults so the global atomics are
        // already default — a no-op for any concurrent reader.
        let dir = scratch("persist");
        update(Some(&dir), EngineHints::default());
        assert!(file_in(&dir).exists());
        assert_eq!(read(&dir), EngineHints::default());
    }
}
