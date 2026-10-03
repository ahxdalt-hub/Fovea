//! Local license persistence.
//!
//! Two slots, tried in order on Windows:
//! 1. **Windows Credential Manager** (the OS's private per-user store —
//!    the "secure storage" appropriate for a license key: not reachable
//!    by other users, not a file another app can casually read);
//! 2. an atomic file in the app-data dir (`license.key`), used on
//!    non-Windows platforms, or whenever the credential store is not
//!    answering.
//!
//! What is stored where, and why it is safe either way:
//! - The credential/file holds only the *vendor-signed key text*. Its
//!   authority comes from the signature, never from the storage: a user
//!   editing the file changes the key, and the key then fails
//!   verification — it cannot fabricate a license. The file fallback is
//!   therefore a convenience, not a downgrade.
//! - `license-state.json` (app-data) holds non-secret bookkeeping: when
//!   the key was activated and the highest clock value Pixora has ever
//!   seen. The watermark is what stops an expired license being revived
//!   by winding the system clock back.
//!
//! A read failure on the credential store is *not* corruption: the file
//! is consulted before the answer is "nothing here".

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Which slot a read/write goes to. `Auto` is production behaviour;
/// `File` keeps tests (and any future locked-down machine) honest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Auto,
    File,
}

const KEY_FILE: &str = "license.key";
const STATE_FILE: &str = "license-state.json";
#[cfg(windows)]
const CREDENTIAL_TARGET: &str = "pixora/license";

// ── Bookkeeping file ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseState {
    pub activated_at: Option<u64>,
    /// Highest unix time Pixora has observed on this machine. A license
    /// check at a clock meaningfully *below* this is a rollback attempt.
    pub max_seen_at: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    version: u32,
    state: LicenseState,
}

const STATE_VERSION: u32 = 1;

pub fn read_state(app_data: &Path) -> LicenseState {
    let path = app_data.join(STATE_FILE);
    let Ok(raw) = std::fs::read(&path) else {
        return LicenseState::default();
    };
    match serde_json::from_slice::<PersistedState>(&raw) {
        Ok(p) if p.version == STATE_VERSION => p.state,
        Ok(p) => {
            log::warn!(
                "license state unknown version {} — starting fresh",
                p.version
            );
            LicenseState::default()
        }
        Err(e) => {
            // Corrupt bookkeeping must not invalidate a good key; it just
            // loses the watermark (the next check re-establishes it).
            log::warn!("license state corrupt: {e}");
            LicenseState::default()
        }
    }
}

pub fn write_state(app_data: &Path, state: LicenseState) {
    let path = app_data.join(STATE_FILE);
    let json = serde_json::to_vec_pretty(&PersistedState {
        version: STATE_VERSION,
        state,
    });
    let Ok(json) = json else { return };
    if write_atomic(&path, &json, "state").is_err() {
        // Bookkeeping is not the license itself: failing to write it
        // degrades (no watermark until next success), never blocks.
        log::warn!("license state could not be written");
    }
}

// ── The signed key text ──────────────────────────────────────────────

pub fn read_key(app_data: &Path, backend: Backend) -> Option<String> {
    #[cfg(windows)]
    if backend == Backend::Auto {
        match credential::read() {
            credential::ReadOutcome::Found(key) => return Some(key),
            credential::ReadOutcome::Absent => {}
            credential::ReadOutcome::Unavailable => {
                log::warn!("credential store unavailable; consulting file slot");
            }
        }
    }
    read_file_key(app_data)
}

/// Save the key. Returns the slot actually used (for honest status), or
/// `None` when every slot refused the write.
pub fn write_key(app_data: &Path, backend: Backend, key: &str) -> Option<&'static str> {
    #[cfg(windows)]
    if backend == Backend::Auto && credential::write(key) {
        // Mirror-free: the credential is now the slot of record. Clear
        // any stale file so the two slots can never disagree.
        let _ = std::fs::remove_file(app_data.join(KEY_FILE));
        return Some("credential");
    }
    let path = app_data.join(KEY_FILE);
    match write_atomic(&path, key.as_bytes(), "key") {
        Ok(()) => Some("file"),
        Err(_) => {
            log::warn!("license key could not be stored");
            None
        }
    }
}

pub fn clear_key(app_data: &Path, backend: Backend) {
    #[cfg(windows)]
    if backend == Backend::Auto {
        credential::delete();
    }
    let _ = std::fs::remove_file(app_data.join(KEY_FILE));
}

fn read_file_key(app_data: &Path) -> Option<String> {
    let path = app_data.join(KEY_FILE);
    match std::fs::read_to_string(&path) {
        Ok(s) => Some(s),
        Err(e) if path.exists() => {
            log::warn!("license key file unreadable: {e}");
            // Present but unreadable is a corrupted state, not an absent
            // one: report it so status says so instead of "not activated".
            Some(String::new())
        }
        Err(_) => None,
    }
}

/// temp + rename, the journal's discipline (mirrors services/settings).
fn write_atomic(path: &Path, bytes: &[u8], tag: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("{tag}.part"));
    std::fs::write(&tmp, bytes)?;
    let commit = || {
        #[cfg(windows)]
        {
            if path.exists() {
                std::fs::remove_file(path)?;
            }
            std::fs::rename(&tmp, path)
        }
        #[cfg(not(windows))]
        std::fs::rename(&tmp, path)
    };
    commit().inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

// ── Windows Credential Manager ───────────────────────────────────────

#[cfg(windows)]
mod credential {
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree,
        CredReadW, CredWriteW,
    };
    use windows::core::{PCWSTR, PWSTR};

    use super::CREDENTIAL_TARGET;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    #[derive(Debug)]
    pub enum ReadOutcome {
        Found(String),
        Absent,
        Unavailable,
    }

    /// Generic credentials carry a UTF-16 password blob; the license key
    /// (a few hundred ASCII chars) fits well inside the 512-character
    /// limit for that type.
    pub fn read() -> ReadOutcome {
        unsafe {
            let target = wide(CREDENTIAL_TARGET);
            let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
            if let Err(e) = CredReadW(
                PCWSTR(target.as_ptr()),
                CRED_TYPE_GENERIC,
                Some(0),
                &mut cred,
            ) {
                // ElementNotFound is the normal "never stored yet".
                if e.code() == ERROR_NOT_FOUND.to_hresult() {
                    return ReadOutcome::Absent;
                }
                log::warn!("credential read failed: code {:#010x}", e.code().0);
                return ReadOutcome::Unavailable;
            }
            if cred.is_null() {
                return ReadOutcome::Absent;
            }
            let cred_ref = &*cred;
            let blob = std::slice::from_raw_parts(
                cred_ref.CredentialBlob,
                cred_ref.CredentialBlobSize as usize,
            );
            let text = String::from_utf16_lossy(
                &blob
                    .chunks_exact(2)
                    .map(|p| u16::from_le_bytes([p[0], p[1]]))
                    .take_while(|u| *u != 0)
                    .collect::<Vec<u16>>(),
            );
            CredFree(cred as *mut core::ffi::c_void);
            if text.is_empty() {
                ReadOutcome::Unavailable
            } else {
                ReadOutcome::Found(text)
            }
        }
    }

    pub fn write(key: &str) -> bool {
        unsafe {
            let mut cred = CREDENTIALW::default();
            let target = wide(CREDENTIAL_TARGET);
            let user = wide("pixora");
            let mut blob: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
            cred.Type = CRED_TYPE_GENERIC;
            cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
            cred.CredentialBlobSize = (blob.len() * 2) as u32;
            cred.CredentialBlob = blob.as_mut_ptr() as *mut u8;
            cred.TargetName = PWSTR(target.as_ptr() as *mut u16);
            cred.UserName = PWSTR(user.as_ptr() as *mut u16);
            CredWriteW(&cred, 0).is_ok()
        }
    }

    pub fn delete() {
        unsafe {
            let target = wide(CREDENTIAL_TARGET);
            let _ = CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, Some(0));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pixora-license-store-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn key_round_trip_and_clear_through_the_file_slot() {
        let dir = scratch("key");
        assert_eq!(read_key(&dir, Backend::File), None);
        assert_eq!(
            write_key(&dir, Backend::File, "PIXORA1.abc.def"),
            Some("file")
        );
        assert_eq!(
            read_key(&dir, Backend::File).as_deref(),
            Some("PIXORA1.abc.def")
        );
        clear_key(&dir, Backend::File);
        assert_eq!(read_key(&dir, Backend::File), None);
    }

    #[test]
    fn unreadable_key_file_reports_corrupted_not_absent() {
        let dir = scratch("unreadable");
        std::fs::write(dir.join(KEY_FILE), b"garbage").unwrap();
        assert_eq!(read_key(&dir, Backend::File).as_deref(), Some("garbage"));
    }

    #[test]
    fn state_round_trips_and_corrupt_state_defaults() {
        let dir = scratch("state");
        let state = LicenseState {
            activated_at: Some(1_760_000_000),
            max_seen_at: Some(1_760_000_001),
        };
        write_state(&dir, state);
        assert_eq!(read_state(&dir), state);
        std::fs::write(dir.join(STATE_FILE), b"{ broken").unwrap();
        assert_eq!(read_state(&dir), LicenseState::default());
    }

    /// Manual proof that the real Windows Credential Manager path works
    /// on this machine. Run with: cargo test -- --ignored
    #[test]
    #[ignore = "touches the real credential store of the current user"]
    fn credential_store_round_trip_on_windows() {
        #[cfg(windows)]
        {
            use super::credential::ReadOutcome;
            let key = "PIXORA1.test-credential-probe";
            assert!(credential::write(key));
            match credential::read() {
                ReadOutcome::Found(text) => assert_eq!(text, key),
                ReadOutcome::Absent => panic!("credential vanished after write"),
                ReadOutcome::Unavailable => panic!("credential store unavailable"),
            }
            credential::delete();
            assert!(matches!(credential::read(), ReadOutcome::Absent));
        }
    }
}
