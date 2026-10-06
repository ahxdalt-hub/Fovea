//! This machine's fingerprint — for machine-bound license keys, and as the
//! install id the free plan's monthly allowance is counted under.
//!
//! Derivation order (Windows):
//! 1. SHA-256 of the OS `MachineGuid` (the same value every Windows
//!    install tool treats as the machine identity) — stable across app
//!    reinstalls, survives a corrupted local license store.
//! 2. Fallback: SHA-256 of the computer name, so a machine that somehow
//!    hides its GUID still has *a* consistent identity.
//! 3. If neither exists, this machine reports `None` and bound keys fail
//!    closed — an unidentified machine never satisfies a binding.
//!
//! Nothing personal is used and the value is a hash: the raw GUID is never
//! stored or displayed. It does leave the process in exactly one place —
//! [`crate::services::quota`] sends it as `install_id`, so the server can
//! count a month per machine — and nowhere else. A hash of a machine
//! identifier identifies a machine, not a person.

use std::sync::OnceLock;

use sha2::{Digest as _, Sha256};

fn hash(label: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(label.as_bytes());
    let digest = hasher.finalize();
    // Shortened: 128 bits of hash is plenty to compare machine identity.
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(windows)]
fn raw_identity() -> Option<String> {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        HKEY, HKEY_LOCAL_MACHINE, KEY_READ, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
    };
    use windows::core::PCWSTR;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    unsafe {
        let mut hkey = HKEY::default();
        let path = wide("SOFTWARE\\Microsoft\\Cryptography");
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(path.as_ptr()),
            None,
            KEY_READ,
            &mut hkey,
        ) != ERROR_SUCCESS
        {
            return fallback_identity();
        }
        let name = wide("MachineGuid");
        let mut buf = [0u8; 256];
        let mut len = buf.len() as u32;
        let guid = if RegQueryValueExW(
            hkey,
            PCWSTR(name.as_ptr()),
            None,
            None,
            Some(buf.as_mut_ptr()),
            Some(&mut len),
        ) == ERROR_SUCCESS
        {
            let units: Vec<u16> = buf[..len as usize]
                .chunks_exact(2)
                .map(|p| u16::from_le_bytes([p[0], p[1]]))
                .take_while(|u| *u != 0)
                .collect();
            String::from_utf16_lossy(&units).trim().to_string()
        } else {
            String::new()
        };
        let _ = RegCloseKey(hkey);
        if guid.is_empty() {
            fallback_identity()
        } else {
            Some(guid)
        }
    }
}

#[cfg(not(windows))]
fn raw_identity() -> Option<String> {
    fallback_identity()
}

fn fallback_identity() -> Option<String> {
    let name = std::env::var("COMPUTERNAME")
        .ok()
        .filter(|n| !n.trim().is_empty())
        .or_else(hostname_of)
        .map(|n| format!("name:{n}"))?;
    Some(name)
}

#[cfg(unix)]
fn hostname_of() -> Option<String> {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
}
#[cfg(not(unix))]
fn hostname_of() -> Option<String> {
    None
}

/// The fingerprint for this machine, computed once per process.
/// `None` = unidentified; machine-bound keys then fail closed.
pub fn id() -> Option<&'static str> {
    static ID: OnceLock<Option<String>> = OnceLock::new();
    ID.get_or_init(|| raw_identity().map(|r| hash(&r)))
        .as_deref()
}

/// The fingerprint shown in the license panel. It is the *whole* id on
/// purpose: a machine-bound key is issued with `--machine <this string>`,
/// so a truncated label would look like the vendor's requirement and be
/// unusable. Still a one-way hash — it identifies a machine, not a person.
pub fn display_id() -> String {
    id().unwrap_or("unidentified").to_string()
}
