//! Local processing journal + recent files (Stage 09).
//!
//! The promise of this module in one sentence: *a record of work, not a
//! copy of the work*. History entries store paths and measurements —
//! filename, true original/output dimensions, scale, mode, outcome,
//! timestamp, output location — and never image bytes. The originals stay
//! wherever the user put them; the outputs stay in Pixora's output/export
//! folders exactly as the engine/export services wrote them.
//!
//! Storage is a single JSON file in the app-data dir (`history.json`),
//! written atomically (temp file + rename, same discipline as the engine's
//! commit path) after every change: small, human-inspectable, and
//! dead-simple to recover from — a corrupt file means an empty journal,
//! logged and re-created, never a broken app.
//!
//! Two record types share the file:
//! - **Journal entries** — what happened to an image. Capped (`MAX_ENTRIES`),
//!   newest first. Kept even when the source file later disappears: the
//!   journal is history, and the read path marks missing files honestly
//!   (`sourceExists` / `outputExists`) instead of silently dropping rows.
//! - **Recent files** — the short "pick up where you left off" list. These
//!   are live pointers: a recent whose file vanished is *pruned* at read
//!   time, because a recents row that can't be reopened is just decay.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/// Journal cap. Hundreds of rows is already a workflow story; beyond that
/// the journal is an archive, and Pixora is not an archive product.
pub const MAX_ENTRIES: usize = 200;
/// Recent-files cap: a glanceable list, not a file manager.
pub const MAX_RECENTS: usize = 12;

/// How one enhancement run ended. Only honest terminals are recorded:
/// a *user-cancelled* run wrote nothing and is not journal-worthy noise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryStatus {
    Completed,
    Failed,
}

/// Whether the run was a single-image enhancement or a queued batch item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Single,
    Batch,
}

/// One journal row. `camelCase` on the wire (`HistoryEntryDto` in TS).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// Journal-local id (timestamp + sequence).
    pub id: String,
    /// The source file's canonical path — the same id the collection and
    /// the engine use. The file itself is never copied into Pixora.
    pub source_path: String,
    /// Display name only (basename of the source).
    pub file_name: String,
    /// True source dimensions as the job measured them.
    pub original_width: u32,
    pub original_height: u32,
    /// True master dimensions (0 on a failed run — nothing was produced).
    pub output_width: u32,
    pub output_height: u32,
    /// Product scale the run used (2 | 4).
    pub scale: usize,
    /// Enhancement mode key ("standard" | "natural" | "detail").
    pub mode: String,
    pub status: EntryStatus,
    /// User-safe failure message (from `AppError::user_message`), present
    /// exactly when `status == Failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// Unix milliseconds at record time.
    pub created_at: u64,
    pub kind: EntryKind,
    /// Where the result lives (engine master for single runs, exported
    /// copy for batch items); `None` on failures.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
}

/// One recent-file row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    /// Unix milliseconds of the most recent import touching this file.
    pub last_used_at: u64,
}

/// Journal + recents as read back by the UI. Existence flags are computed
/// at *read* time — the file could have moved between any two moments, so
/// the honest answer is "as of this snapshot".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryDto {
    #[serde(flatten)]
    pub entry: HistoryEntry,
    pub source_exists: bool,
    pub output_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFileDto {
    #[serde(flatten)]
    pub file: RecentFile,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    /// Newest first, oldest missing files still present but flagged.
    pub entries: Vec<HistoryEntryDto>,
    /// Newest first, dead pointers already pruned.
    pub recents: Vec<RecentFileDto>,
}

/// On-disk shape. `version` guards the format: a file written by a future
/// or unknown version is treated as corrupt (fresh start), never guessed.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Persisted {
    version: u32,
    entries: Vec<HistoryEntry>,
    recents: Vec<RecentFile>,
}

const STORE_VERSION: u32 = 1;

/// The journal, in memory, backed by `history.json`. Cheap to share
/// (`Arc<Store>` in Tauri managed state); every mutation persists before
/// the call returns.
pub struct Store {
    path: PathBuf,
    inner: Mutex<Persisted>,
}

impl Store {
    /// Load (or create) the store for an app-data directory. Never fails:
    /// an unreadable or malformed file is logged and replaced — losing the
    /// journal is sad; refusing to start is worse.
    pub fn open(app_data: &Path) -> Arc<Store> {
        let path = app_data.join("history.json");
        let persisted = read_or_reset(&path);
        Arc::new(Store {
            path,
            inner: Mutex::new(persisted),
        })
    }

    /// Record one finished (or failed) run. Newest first; the tail falls
    /// off past `MAX_ENTRIES`. Repeated processing of one file appends a
    /// new row — the journal is a journal, not a keyed table.
    pub fn record(&self, mut entry: HistoryEntry) {
        if entry.id.is_empty() {
            entry.id = next_id();
        }
        {
            let mut guard = lock(&self.inner);
            guard.entries.insert(0, entry);
            guard.entries.truncate(MAX_ENTRIES);
        }
        self.save();
    }

    /// Touch the recent-files queue: dedupe by path, move to the front,
    /// cap. Called for every *successfully imported* file.
    pub fn note_recent(&self, path: &str, name: &str) {
        let now = now_ms();
        {
            let mut guard = lock(&self.inner);
            guard.recents.retain(|r| r.path != path);
            guard.recents.insert(
                0,
                RecentFile {
                    path: path.to_string(),
                    name: name.to_string(),
                    last_used_at: now,
                },
            );
            guard.recents.truncate(MAX_RECENTS);
        }
        self.save();
    }

    /// The UI snapshot: existence flags computed now, dead recents pruned
    /// (and persisted when the prune changed anything). Journal rows are
    /// never silently dropped here — they are flagged, because history of
    /// a moved file is still history.
    pub fn snapshot(&self) -> HistorySnapshot {
        let entries = {
            let guard = lock(&self.inner);
            guard
                .entries
                .iter()
                .map(|e| HistoryEntryDto {
                    entry: e.clone(),
                    source_exists: Path::new(&e.source_path).exists(),
                    output_exists: e
                        .output_path
                        .as_deref()
                        .is_some_and(|p| Path::new(p).exists()),
                })
                .collect::<Vec<_>>()
        };
        let before = lock(&self.inner).recents.len();
        // Prune dead pointers in the *store* (rebuild, not truncate — a
        // truncated prefix could keep a dead entry and drop a live one).
        let recents_dto: Vec<RecentFileDto> = {
            let mut guard = lock(&self.inner);
            guard.recents.retain(|r| Path::new(&r.path).exists());
            guard
                .recents
                .iter()
                .map(|f| RecentFileDto {
                    exists: true,
                    file: f.clone(),
                })
                .collect()
        };
        if recents_dto.len() != before {
            // Dead pointers decay out of the store, not just the view.
            self.save();
        }
        HistorySnapshot {
            entries,
            recents: recents_dto,
        }
    }

    /// Empty the journal and the recents list (user-initiated reset).
    pub fn clear(&self) {
        {
            let mut guard = lock(&self.inner);
            guard.entries.clear();
            guard.recents.clear();
        }
        self.save();
    }

    /// Atomic persistence: serialize under the lock, write temp + rename
    /// outside it. A failed write is logged, never fatal — the in-memory
    /// journal stays correct for this session and the next change retries.
    fn save(&self) {
        let json = {
            let guard = lock(&self.inner);
            let data = Persisted {
                version: STORE_VERSION,
                entries: guard.entries.clone(),
                recents: guard.recents.clone(),
            };
            serde_json::to_vec_pretty(&data)
        };
        let json = match json {
            Ok(j) => j,
            Err(e) => {
                log::warn!("history serialize failed: {e}");
                return;
            }
        };
        let tmp = self.path.with_extension("json.part");
        let write = std::fs::write(&tmp, &json).and_then(|()| {
            #[cfg(windows)]
            {
                // A plain rename refuses to replace an existing file on
                // Windows; the journal replaces its own previous version.
                if self.path.exists() {
                    std::fs::remove_file(&self.path)?;
                }
                std::fs::rename(&tmp, &self.path)
            }
            #[cfg(not(windows))]
            std::fs::rename(&tmp, &self.path)
        });
        if let Err(e) = write {
            let _ = std::fs::remove_file(&tmp);
            log::warn!("history save failed: {e}");
        }
    }
}

/// Read the store file; any failure mode (missing, corrupt, unknown
/// version) lands on `Default` with a log line. The damaged original is
/// left as `.json.corrupt` once so nothing vanishes without a trace.
fn read_or_reset(path: &Path) -> Persisted {
    let raw = match std::fs::read(path) {
        Ok(r) => r,
        Err(e) if path.exists() => {
            log::warn!("history file unreadable: {e}");
            quarantine(path);
            return Persisted::default();
        }
        Err(_) => return Persisted::default(), // first run — no file yet
    };
    match serde_json::from_slice::<Persisted>(&raw) {
        Ok(p) if p.version == STORE_VERSION => p,
        Ok(p) => {
            log::warn!(
                "history file has unknown version {} — starting fresh",
                p.version
            );
            quarantine(path);
            Persisted::default()
        }
        Err(e) => {
            log::warn!("history file corrupt: {e}");
            quarantine(path);
            Persisted::default()
        }
    }
}

fn quarantine(path: &Path) {
    let bad = path.with_extension("json.corrupt");
    let _ = std::fs::rename(path, bad);
}

/// Unix milliseconds now — the journal's clock, exposed crate-wide so
/// every recording site stamps the same way.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn next_id() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "h-{}-{}",
        now_ms(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    )
}

fn lock(inner: &Mutex<Persisted>) -> std::sync::MutexGuard<'_, Persisted> {
    inner.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pixora-history-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn entry(name: &str, status: EntryStatus) -> HistoryEntry {
        HistoryEntry {
            id: String::new(),
            source_path: format!("C:/pics/{name}"),
            file_name: name.to_string(),
            original_width: 1000,
            original_height: 800,
            output_width: if status == EntryStatus::Completed {
                4000
            } else {
                0
            },
            output_height: if status == EntryStatus::Completed {
                3200
            } else {
                0
            },
            scale: 4,
            mode: "standard".into(),
            status,
            error_message: (status == EntryStatus::Failed)
                .then(|| "Processing failed.".to_string()),
            created_at: now_ms(),
            kind: EntryKind::Single,
            output_path: (status == EntryStatus::Completed).then(|| format!("C:/out/{name}.png")),
        }
    }

    #[test]
    fn records_newest_first_and_caps_the_journal() {
        let dir = scratch("cap");
        let store = Store::open(&dir);
        for i in 0..(MAX_ENTRIES + 30) {
            store.record(entry(&format!("img{i}.png"), EntryStatus::Completed));
        }
        let snap = store.snapshot();
        assert_eq!(snap.entries.len(), MAX_ENTRIES);
        // Newest first: the last recorded file is the first row.
        assert_eq!(
            snap.entries[0].entry.file_name,
            format!("img{}.png", MAX_ENTRIES + 29)
        );
    }

    #[test]
    fn survives_restart_round_trip() {
        let dir = scratch("restart");
        let recent = dir.join("b.png");
        std::fs::write(&recent, b"x").unwrap();
        {
            let store = Store::open(&dir);
            store.record(entry("a.png", EntryStatus::Failed));
            store.record(entry("b.png", EntryStatus::Completed));
            store.note_recent(&recent.to_string_lossy(), "b.png");
        }
        let reopened = Store::open(&dir);
        let snap = reopened.snapshot();
        assert_eq!(snap.entries.len(), 2);
        assert_eq!(snap.entries[0].entry.file_name, "b.png");
        assert_eq!(snap.entries[0].entry.status, EntryStatus::Completed);
        assert_eq!(
            snap.entries[1].entry.error_message.as_deref(),
            Some("Processing failed.")
        );
        assert_eq!(snap.recents.len(), 1);
    }

    #[test]
    fn corrupt_file_starts_fresh_and_is_quarantined() {
        let dir = scratch("corrupt");
        std::fs::write(dir.join("history.json"), b"{ not json at all").unwrap();
        let store = Store::open(&dir);
        store.record(entry("a.png", EntryStatus::Completed));
        assert_eq!(store.snapshot().entries.len(), 1);
        assert!(dir.join("history.json.corrupt").exists());
    }

    #[test]
    fn missing_files_are_flagged_not_dropped_and_recents_decay() {
        let dir = scratch("missing");
        let live = dir.join("live.png");
        std::fs::write(&live, b"x").unwrap();
        let store = Store::open(&dir);
        store.record(HistoryEntry {
            source_path: live.to_string_lossy().into_owned(),
            file_name: "live.png".into(),
            ..entry("live.png", EntryStatus::Completed)
        });
        store.record(entry("gone.png", EntryStatus::Completed));
        store.note_recent(&live.to_string_lossy(), "live.png");
        store.note_recent("C:/pics/deleted.png", "deleted.png");

        let snap = store.snapshot();
        // Journal keeps the vanished file, honestly flagged.
        assert_eq!(snap.entries.len(), 2);
        let vanished = snap
            .entries
            .iter()
            .find(|e| e.entry.file_name == "gone.png")
            .unwrap();
        assert!(!vanished.source_exists);
        assert!(!vanished.output_exists);
        let kept = snap
            .entries
            .iter()
            .find(|e| e.entry.file_name == "live.png")
            .unwrap();
        assert!(kept.source_exists);
        // Recents drop the dead pointer — from the view *and* the store.
        assert_eq!(snap.recents.len(), 1);
        assert!(snap.recents[0].exists);
        let again = Store::open(&dir).snapshot();
        assert_eq!(again.recents.len(), 1);
    }

    #[test]
    fn recents_dedupe_and_move_to_front() {
        let dir = scratch("recents");
        let store = Store::open(&dir);
        let a = dir.join("a.png");
        let b = dir.join("b.png");
        std::fs::write(&a, b"x").unwrap();
        std::fs::write(&b, b"x").unwrap();
        store.note_recent(&a.to_string_lossy(), "a.png");
        store.note_recent(&b.to_string_lossy(), "b.png");
        store.note_recent(&a.to_string_lossy(), "a.png");
        let snap = store.snapshot();
        assert_eq!(snap.recents.len(), 2);
        assert!(snap.recents[0].file.path.ends_with("a.png"));
    }

    #[test]
    fn clear_empties_both_lists_and_persists() {
        let dir = scratch("clear");
        let store = Store::open(&dir);
        store.record(entry("a.png", EntryStatus::Completed));
        store.note_recent("C:/pics/a.png", "a.png");
        store.clear();
        assert!(store.snapshot().entries.is_empty());
        assert!(Store::open(&dir).snapshot().entries.is_empty());
    }
}
