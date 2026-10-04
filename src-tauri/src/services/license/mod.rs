//! Licensing (Stage 13) — the commercial layer, kept deliberately apart
//! from the engine.
//!
//! The chain this module models:
//!
//! ```text
//! Purchase → License issued → Activation → Local license state → Feature access
//! ```
//!
//! Only the middle arrow (issue) touches commerce; everything on the
//! right runs on this machine. A license key is a compact, Ed25519-signed
//! statement issued by the vendor (see `key.rs` and
//! `examples/issue_license.rs`); Fovea's app embeds only *public* keys,
//! so nothing secret ships in the binary and nothing the client says is
//! trusted beyond the signature itself.
//!
//! Coupling rules, enforced by structure:
//! - No inference/export/import path calls into this module. The AI
//!   engine processes images with or without a license — proven by the
//!   fact that no engine service even imports `license`.
//! - Licensing never calls the network. Payment-provider integrations
//!   (whose APIs change and must not be assumed) live on the issuing
//!   side; a future *optional* online check plugs in behind
//!   [`LicenseProvider`] alone. The default provider is offline, and a
//!   provider that cannot reach its service returns
//!   [`Revocation::Unknown`] — activation then stands on the signature.
//!
//! Feature access: [`allows`] answers "does the current edition permit
//! this feature". In this build the answer is yes for every shipped
//! feature — the local engine's capabilities are not paywalled — and the
//! seam exists so a commercial edition policy lands in one table here
//! rather than scattered through commands.

pub mod key;
pub mod keys;
pub mod machine;
pub mod store;

use std::path::Path;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use key::{Edition, KeyRejection, LicensePayload};

pub use store::Backend;

/// How far the clock may wind back below the recorded high-water mark
/// before a stored license is treated as a rollback attempt (an hour
/// absorbs honest time-sync jitter; nothing wider is jitter).
const ROLLBACK_GRACE_SECONDS: u64 = 3600;

// ── Status model ─────────────────────────────────────────────────────

/// The lifecycle answers the UI renders. Every variant is reachable and
/// every one has a human sentence in `error.rs` or the settings page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LicenseState {
    NotActivated,
    Active,
    Expired,
    /// Signature valid, but bound to a different machine.
    WrongMachine,
    /// The key format/bytes no longer verify — edited, truncated, or a
    /// store from a build with different keys.
    Tampered,
    Revoked,
    /// This machine's clock sits meaningfully below the last time Fovea
    /// saw — the classic way to revive an expired license.
    ClockSuspect,
}

impl LicenseState {
    fn as_str(self) -> &'static str {
        match self {
            LicenseState::NotActivated => "not_activated",
            LicenseState::Active => "active",
            LicenseState::Expired => "expired",
            LicenseState::WrongMachine => "wrong_machine",
            LicenseState::Tampered => "tampered",
            LicenseState::Revoked => "revoked",
            LicenseState::ClockSuspect => "clock_suspect",
        }
    }
}

/// Serialized view of the license for the UI (camelCase, like every DTO).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatusDto {
    pub state: &'static str,
    /// `"pro"` | `"studio"` — `None` while unactivated.
    pub edition: Option<&'static str>,
    /// License holder as written on the key (the user's own purchase
    /// information; never sent anywhere).
    pub holder: Option<String>,
    /// Vendor-side license id, for support lookups.
    pub license_id: Option<String>,
    pub issued_at: Option<u64>,
    pub expires_at: Option<u64>,
    pub activated_at: Option<u64>,
    pub machine_bound: bool,
    /// The capabilities the current state grants (see `Feature`).
    pub capabilities: Vec<&'static str>,
    /// This machine's fingerprint, in full — a machine-bound key is issued
    /// with exactly this value. A hash, never a personal identifier.
    pub machine_hint: String,
}

/// What an activation returns: the fresh status plus whether this exact
/// key was already the stored license (idempotent re-activation).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationDto {
    pub status: LicenseStatusDto,
    pub already_active: bool,
}

impl LicenseStatusDto {
    fn unactivated() -> Self {
        Self::state_only(LicenseState::NotActivated, None)
    }

    /// A status with no verifiable claims: state, the local activation
    /// timestamp if one was recorded, and the unactivated baseline.
    fn state_only(state: LicenseState, activated_at: Option<u64>) -> Self {
        LicenseStatusDto {
            state: state.as_str(),
            edition: None,
            holder: None,
            license_id: None,
            issued_at: None,
            expires_at: None,
            activated_at,
            machine_bound: false,
            capabilities: capabilities_for(None),
            machine_hint: machine::display_id(),
        }
    }

    fn of(state: LicenseState, payload: &LicensePayload, activated_at: Option<u64>) -> Self {
        let edition = payload.edition;
        LicenseStatusDto {
            state: state.as_str(),
            edition: Some(edition.as_str()),
            holder: Some(payload.holder.clone()),
            license_id: Some(payload.license_id.clone()),
            issued_at: Some(payload.issued),
            expires_at: payload.expires,
            activated_at,
            machine_bound: payload.machine.is_some(),
            capabilities: capabilities_for(Some(edition)),
            machine_hint: machine::display_id(),
        }
    }
}

// ── Provider seam (issuance / future online checks) ──────────────────

/// The answer an optional license service can give about a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Revocation {
    /// No answer available (the default offline stance) — the signature
    /// alone decides, so an outage can never lock out a buyer.
    Unknown,
    Accepted,
    Revoked,
}

/// A remote license service would implement this. Nothing in this build
/// calls the network; the trait exists so provider-specific logic (a
/// store's validation API, a revocation list) isolates *here* when a
/// commercial channel is chosen — verified against that provider's
/// current API then, not assumed now.
pub trait LicenseProvider: Send + Sync {
    fn check(&self, license: &LicensePayload) -> Revocation;
}

/// The default (and only) provider: licensing is offline-capable by
/// construction.
pub struct OfflineProvider;

impl LicenseProvider for OfflineProvider {
    fn check(&self, _license: &LicensePayload) -> Revocation {
        Revocation::Unknown
    }
}

pub fn provider() -> &'static dyn LicenseProvider {
    &OfflineProvider
}

// ── Feature access ───────────────────────────────────────────────────

/// Product capabilities a commercial edition could gate. Gating policy
/// lives in [`minimum_edition`] only — commands and UI ask [`allows`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature {
    Enhance,
    Export,
    Batch,
    HistoryJournal,
}

impl Feature {
    pub fn key(self) -> &'static str {
        match self {
            Feature::Enhance => "enhance",
            Feature::Export => "export",
            Feature::Batch => "batch",
            Feature::HistoryJournal => "journal",
        }
    }
}

/// The license edition required for a feature; `None` = available to
/// everyone. Deliberately `None` across the board in this build: the
/// commercial model licenses *terms* (seats, machine binding, support),
/// not the local engine, and Fovea's promise is that image processing
/// runs on your machine whether or not a key is present.
pub fn minimum_edition(_feature: Feature) -> Option<Edition> {
    None
}

/// Does the current license (None = unactivated) permit this feature?
pub fn allows(current: Option<Edition>, feature: Feature) -> bool {
    match minimum_edition(feature) {
        None => true,
        Some(required) => {
            let rank = |e: Edition| match e {
                Edition::Pro => 1,
                Edition::Studio => 2,
            };
            current.is_some_and(|e| rank(e) >= rank(required))
        }
    }
}

/// Capability list for the status DTO (what the UI shows the user owns).
fn capabilities_for(edition: Option<Edition>) -> Vec<&'static str> {
    [
        Feature::Enhance,
        Feature::Export,
        Feature::Batch,
        Feature::HistoryJournal,
    ]
    .into_iter()
    .filter(|f| allows(edition, *f))
    .map(Feature::key)
    .collect()
}

// ── Service API ──────────────────────────────────────────────────────

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The local license state, re-verified from the stored signature on
/// every call — the parsed claims are never cached or trusted from disk.
pub fn status(app_data: &Path) -> LicenseStatusDto {
    status_with(app_data, Backend::Auto, now_secs(), provider())
}

fn status_with(
    app_data: &Path,
    backend: Backend,
    now: u64,
    prov: &dyn LicenseProvider,
) -> LicenseStatusDto {
    let bookkeeping = store::read_state(app_data);
    let Some(raw) = store::read_key(app_data, backend) else {
        return LicenseStatusDto::unactivated();
    };
    // Clock rollback is checked against the stored high-water mark for
    // any stored key, before anything else about that key is decided.
    let rolled_back = bookkeeping
        .max_seen_at
        .is_some_and(|seen| now.saturating_add(ROLLBACK_GRACE_SECONDS) < seen);
    match key::verify_key(&raw, now, machine::id()) {
        Ok(payload) if rolled_back => LicenseStatusDto::of(
            LicenseState::ClockSuspect,
            &payload,
            bookkeeping.activated_at,
        ),
        Ok(payload) => match prov.check(&payload) {
            Revocation::Revoked => {
                LicenseStatusDto::of(LicenseState::Revoked, &payload, bookkeeping.activated_at)
            }
            Revocation::Unknown | Revocation::Accepted => {
                advance_watermark(app_data, bookkeeping, now);
                LicenseStatusDto::of(
                    LicenseState::Active,
                    &payload,
                    bookkeeping.activated_at.or(Some(now)),
                )
            }
        },
        Err(KeyRejection::Expired(payload)) => {
            LicenseStatusDto::of(LicenseState::Expired, &payload, bookkeeping.activated_at)
        }
        Err(KeyRejection::WrongMachine) => {
            LicenseStatusDto::state_only(LicenseState::WrongMachine, bookkeeping.activated_at)
        }
        Err(KeyRejection::ClockSuspect) => {
            LicenseStatusDto::state_only(LicenseState::ClockSuspect, bookkeeping.activated_at)
        }
        // Everything else that once verified and no longer does — or that
        // never did — lands as tampered: the store's bytes are not a key
        // this build can honour. Which sub-reason it was is a log line,
        // not a user puzzle.
        Err(other) => {
            log::warn!("stored license rejected: {other:?}");
            LicenseStatusDto::state_only(LicenseState::Tampered, bookkeeping.activated_at)
        }
    }
}

/// Activate a pasted key. Fully offline-capable: the signature is the
/// proof, and the local store just remembers it across restarts.
pub fn activate(app_data: &Path, pasted_key: &str) -> AppResult<ActivationDto> {
    activate_with(app_data, Backend::Auto, pasted_key, now_secs(), provider())
}

fn activate_with(
    app_data: &Path,
    backend: Backend,
    pasted_key: &str,
    now: u64,
    prov: &dyn LicenseProvider,
) -> AppResult<ActivationDto> {
    let normalized: String = pasted_key.chars().filter(|c| !c.is_whitespace()).collect();
    if normalized.is_empty() {
        return Err(AppError::LicenseInvalid {
            detail: "empty key".into(),
        });
    }
    let payload = key::verify_key(&normalized, now, machine::id()).map_err(rejection_to_error)?;
    match prov.check(&payload) {
        Revocation::Revoked => {
            return Err(AppError::LicenseRevoked {
                detail: payload.license_id,
            });
        }
        Revocation::Unknown | Revocation::Accepted => {}
    }

    let existing = store::read_key(app_data, backend);
    let already = existing.as_deref() == Some(normalized.as_str());
    if !already && store::write_key(app_data, backend, &normalized).is_none() {
        return Err(AppError::LicenseStoreUnavailable {
            detail: "neither slot accepted the key".into(),
        });
    }
    let mut bookkeeping = store::read_state(app_data);
    if !already {
        bookkeeping.activated_at = Some(now);
    }
    bookkeeping.max_seen_at = Some(bookkeeping.max_seen_at.unwrap_or(0).max(now));
    store::write_state(app_data, bookkeeping);

    Ok(ActivationDto {
        status: LicenseStatusDto::of(LicenseState::Active, &payload, Some(now)),
        already_active: already,
    })
}

/// Deactivate: forget the key locally. The watermark deliberately stays —
/// forgetting a license must not rewind the anti-rollback clock.
pub fn deactivate(app_data: &Path) -> LicenseStatusDto {
    deactivate_with(app_data, Backend::Auto)
}

fn deactivate_with(app_data: &Path, backend: Backend) -> LicenseStatusDto {
    store::clear_key(app_data, backend);
    let bookkeeping = store::read_state(app_data);
    store::write_state(
        app_data,
        store::LicenseState {
            activated_at: None,
            max_seen_at: bookkeeping.max_seen_at,
        },
    );
    status_with(app_data, backend, now_secs(), provider())
}

fn advance_watermark(app_data: &Path, bookkeeping: store::LicenseState, now: u64) {
    let recorded = bookkeeping.max_seen_at.unwrap_or(0);
    if now > recorded {
        store::write_state(
            app_data,
            store::LicenseState {
                activated_at: bookkeeping.activated_at,
                max_seen_at: Some(now),
            },
        );
    }
}

fn rejection_to_error(rejection: KeyRejection) -> AppError {
    match rejection {
        KeyRejection::Malformed => AppError::LicenseInvalid {
            detail: "signature/format check failed".into(),
        },
        KeyRejection::WrongProduct => AppError::LicenseInvalid {
            detail: "key issued for a different product".into(),
        },
        KeyRejection::UnsupportedVersion => AppError::LicenseUnsupportedVersion {
            detail: "payload version is newer than this build".into(),
        },
        KeyRejection::WrongMachine => AppError::LicenseWrongMachine {
            detail: String::new(),
        },
        KeyRejection::Expired(payload) => AppError::LicenseExpired {
            detail: format!(
                "id {} expired at {}",
                payload.license_id,
                payload.expires.unwrap_or(0)
            ),
        },
        KeyRejection::ClockSuspect => AppError::LicenseClockSuspect {
            detail: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Fixed instant every test drives the state machine at, so the
    /// suites never depend on the wall clock.
    const T0: u64 = 1_760_000_000; // 2025-10-09
    const DAY: u64 = 86_400;

    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn dev_seed() -> Vec<u8> {
        hex_to_bytes(keys::DEV_SEED_HEX)
    }

    fn payload_at(issued: u64) -> LicensePayload {
        LicensePayload {
            v: 1,
            product: "fovea".into(),
            edition: Edition::Pro,
            license_id: "PL-TEST-1".into(),
            holder: "ada@example.com".into(),
            issued,
            expires: None,
            machine: None,
        }
    }

    /// The test's stand-in for the vendor's issuing side — exactly what
    /// `examples/issue_license.rs` does, with the dev seed.
    fn issue(p: &LicensePayload) -> String {
        key::sign_key(p, &dev_seed()).expect("sign")
    }

    struct Fixed(Revocation);
    impl LicenseProvider for Fixed {
        fn check(&self, _license: &LicensePayload) -> Revocation {
            self.0
        }
    }
    const OK: Fixed = Fixed(Revocation::Unknown);

    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("fovea-license-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn activate_ok(dir: &Path, key: &str) -> ActivationDto {
        activate_with(dir, Backend::File, key, T0, &OK).expect("activation")
    }

    // ── the required scenario matrix ────────────────────────────────

    #[test]
    fn valid_key_activates_and_reports_a_full_status() {
        let dir = scratch("valid");
        let key = issue(&payload_at(T0 - 10));
        let res = activate_ok(&dir, &key);
        assert_eq!(res.status.state, "active");
        assert_eq!(res.status.edition, Some("pro"));
        assert_eq!(res.status.holder.as_deref(), Some("ada@example.com"));
        assert_eq!(res.status.license_id.as_deref(), Some("PL-TEST-1"));
        assert_eq!(res.status.expires_at, None); // perpetual
        assert!(!res.status.machine_bound);
        assert!(!res.already_active);
        assert_eq!(
            res.status.capabilities,
            vec!["enhance", "export", "batch", "journal"]
        );
        // Restart = a fresh read. Nothing is cached in the process, so a
        // new status sees the stored key again, re-verified.
        let after_restart = status_with(&dir, Backend::File, T0 + DAY, &OK);
        assert_eq!(after_restart.state, "active");
        assert_eq!(after_restart.holder.as_deref(), Some("ada@example.com"));
    }

    #[test]
    fn pasted_keys_tolerate_whitespace_and_newlines() {
        let dir = scratch("whitespace");
        let key = issue(&payload_at(T0 - 10));
        let messy = format!("  {}\n", key.replace('.', ".\n"));
        let res = activate_ok(&dir, &messy);
        assert_eq!(res.status.state, "active");
        // The normalized form is what got stored.
        assert_eq!(
            store::read_key(&dir, Backend::File).as_deref(),
            Some(key.as_str())
        );
    }

    #[test]
    fn garbage_and_tampered_keys_are_rejected_humanely() {
        let dir = scratch("invalid");
        for pasted in ["not-a-key", "FOVEA1.abc.def"] {
            let err = activate_with(&dir, Backend::File, pasted, T0, &OK).expect_err("must reject");
            assert_eq!(err.code(), "license_invalid", "pasted: {pasted}");
        }
        // A single payload character flipped under a real signature:
        // rejected as invalid, and the error never leaks verification
        // internals. Flip a *middle* character: trailing base64url
        // characters carry unused bits that decode identically, which is
        // a property of the encoding, not a licensing hole (verification
        // is over the decoded bytes, and those must match the signature).
        let key = issue(&payload_at(T0 - 10));
        let parts: Vec<&str> = key.split('.').collect();
        let mut payload_part = parts[1].to_string();
        let mid = payload_part.len() / 2;
        payload_part.replace_range(
            mid..mid + 1,
            if &payload_part[mid..mid + 1] == "A" {
                "B"
            } else {
                "A"
            },
        );
        let tampered = format!("{}.{}.{}", parts[0], payload_part, parts[2]);
        let err = activate_with(&dir, Backend::File, &tampered, T0, &OK).expect_err("tamper");
        assert_eq!(err.code(), "license_invalid");
        assert_eq!(
            serde_json::to_string(&err).unwrap(),
            r#"{"code":"license_invalid","message":"That doesn't read as a Fovea license key. Copy it again from your purchase email and try once more."}"#
        );
    }

    #[test]
    fn key_for_a_different_product_is_not_a_fovea_license() {
        let dir = scratch("wrong-product");
        let mut p = payload_at(T0 - 10);
        p.product = "other-app".into();
        let err = activate_with(&dir, Backend::File, &issue(&p), T0, &OK).expect_err("must reject");
        assert_eq!(err.code(), "license_invalid");
    }

    #[test]
    fn future_dated_keys_suspect_the_clock_not_the_user() {
        let dir = scratch("future");
        let err = activate_with(&dir, Backend::File, &issue(&payload_at(T0 + 3600)), T0, &OK)
            .expect_err("must reject");
        assert_eq!(err.code(), "license_clock_suspect");
    }

    #[test]
    fn payload_versions_this_build_cannot_honour_are_named() {
        let dir = scratch("version");
        let mut p = payload_at(T0 - 10);
        p.v = 2;
        let err = activate_with(&dir, Backend::File, &issue(&p), T0, &OK).expect_err("must reject");
        assert_eq!(err.code(), "license_unsupported_version");
    }

    #[test]
    fn expired_keys_fail_activation_and_report_expired_state() {
        let dir = scratch("expired");
        let mut p = payload_at(T0 - 2 * DAY);
        p.expires = Some(T0 - DAY); // lapsed yesterday
        let err = activate_with(&dir, Backend::File, &issue(&p), T0, &OK).expect_err("expired");
        assert_eq!(err.code(), "license_expired");

        // A key that WAS valid when stored and has since lapsed: the
        // status shows who held it and when it died — honest detail from
        // the signature-verified payload.
        let mut expiring = payload_at(T0 - 2 * DAY);
        expiring.expires = Some(T0 + DAY);
        activate_ok(&dir, &issue(&expiring));
        let later = status_with(&dir, Backend::File, T0 + 2 * DAY, &OK);
        assert_eq!(later.state, "expired");
        assert_eq!(later.holder.as_deref(), Some("ada@example.com"));
        assert_eq!(later.expires_at, Some(T0 + DAY));
    }

    #[test]
    fn revoked_keys_are_refused_by_providers_and_shown_as_revoked() {
        let dir = scratch("revoked");
        let key = issue(&payload_at(T0 - 10));
        let revoked = Fixed(Revocation::Revoked);
        let err = activate_with(&dir, Backend::File, &key, T0, &revoked).expect_err("revoked");
        assert_eq!(err.code(), "license_revoked");
        // If a key went active and a (future) online check later reports
        // revocation, status reflects it; offline checks never do.
        activate_ok(&dir, &key);
        let now_revoked = status_with(&dir, Backend::File, T0 + DAY, &revoked);
        assert_eq!(now_revoked.state, "revoked");
        assert_eq!(
            status_with(&dir, Backend::File, T0 + DAY, &OK).state,
            "active",
            "absence of an answer must never look like a revocation"
        );
    }

    #[test]
    fn re_activating_the_same_key_is_idempotent() {
        let dir = scratch("already");
        let key = issue(&payload_at(T0 - 10));
        activate_ok(&dir, &key);
        let again = activate_ok(&dir, &key);
        assert!(again.already_active);
        assert_eq!(again.status.state, "active");
        // A different valid key replaces cleanly (upgrade path).
        let mut upgraded = payload_at(T0 - 5);
        upgraded.license_id = "PL-TEST-2".into();
        upgraded.edition = Edition::Studio;
        let res = activate_ok(&dir, &issue(&upgraded));
        assert!(!res.already_active);
        assert_eq!(res.status.edition, Some("studio"));
    }

    #[test]
    fn machine_bound_keys_follow_this_machines_identity() {
        let dir = scratch("machine");
        let Some(this) = machine::id() else {
            return; // unidentified host: nothing to bind against here
        };
        let mut p = payload_at(T0 - 10);
        p.machine = Some(this.to_string());
        let res = activate_ok(&dir, &issue(&p));
        assert_eq!(res.status.state, "active");
        assert!(res.status.machine_bound);

        let flipped: String = hex_to_bytes(this)
            .iter()
            .map(|b| format!("{:02x}", b ^ 0xff))
            .collect();
        let mut other = payload_at(T0 - 10);
        other.machine = Some(flipped);
        let err = activate_with(&dir, Backend::File, &issue(&other), T0, &OK).expect_err("bound");
        assert_eq!(err.code(), "license_wrong_machine");
    }

    #[test]
    fn corrupt_local_state_is_tampered_not_absent() {
        let dir = scratch("corrupt");
        store::write_key(&dir, Backend::File, "ejected into the slot by hand").unwrap();
        assert_eq!(status_with(&dir, Backend::File, T0, &OK).state, "tampered");
        // Recovery is re-activation, which overwrites the bad slot.
        activate_ok(&dir, &issue(&payload_at(T0 - 10)));
        assert_eq!(status_with(&dir, Backend::File, T0, &OK).state, "active");
    }

    #[test]
    fn corrupt_bookkeeping_degrades_without_losing_a_good_key() {
        let dir = scratch("corrupt-state");
        activate_ok(&dir, &issue(&payload_at(T0 - 10)));
        std::fs::write(dir.join("license-state.json"), b"{ not json").unwrap();
        let s = status_with(&dir, Backend::File, T0, &OK);
        assert_eq!(
            s.state, "active",
            "watermark loss must not evict a valid license"
        );
        // A valid stored key without a recorded activation stamp gets a
        // fresh one from this check — honest bookkeeping, not a lie.
        assert_eq!(s.activated_at, Some(T0));
    }

    #[test]
    fn wound_back_clock_freezes_a_stored_license_until_time_catches_up() {
        let dir = scratch("rollback");
        activate_ok(&dir, &issue(&payload_at(T0 - 10)));
        // Two hours behind the recorded high-water mark, past any grace.
        let s = status_with(&dir, Backend::File, T0 - 2 * 3600, &OK);
        assert_eq!(s.state, "clock_suspect");
        // Small jitter inside the grace window stays tolerated.
        assert_eq!(
            status_with(&dir, Backend::File, T0 - 60, &OK).state,
            "active"
        );
        // And time moving forward (the honest fix) resolves it.
        assert_eq!(
            status_with(&dir, Backend::File, T0 + DAY, &OK).state,
            "active"
        );
    }

    #[test]
    fn deactivation_forgets_locally_and_a_re_pasted_key_restores() {
        let dir = scratch("deactivate");
        activate_ok(&dir, &issue(&payload_at(T0 - 10)));
        let after = deactivate_with(&dir, Backend::File);
        assert_eq!(after.state, "not_activated");
        // Re-pasting the same key re-activates it — the vendor's issuance
        // is unaffected by a local forget.
        let res = activate_ok(&dir, &issue(&payload_at(T0 - 10)));
        assert_eq!(res.status.state, "active");
    }

    #[test]
    fn empty_key_is_invalid_not_unhandled() {
        let dir = scratch("empty");
        assert_eq!(
            activate_with(&dir, Backend::File, "   ", T0, &OK)
                .expect_err("empty")
                .code(),
            "license_invalid"
        );
    }

    // ── serialization + the feature-access seam ─────────────────────

    #[test]
    fn status_serializes_camelcase_for_the_bridge() {
        let dir = scratch("dto");
        let res = activate_ok(&dir, &issue(&payload_at(T0 - 10)));
        let json = serde_json::to_value(&res.status).unwrap();
        assert_eq!(json["state"], "active");
        assert_eq!(json["licenseId"], "PL-TEST-1");
        assert_eq!(json["machineBound"], false);
        assert_eq!(json["capabilities"].as_array().unwrap().len(), 4);
        assert_eq!(serde_json::to_value(&res).unwrap()["alreadyActive"], false);
    }

    #[test]
    fn unactivated_still_grants_every_shipped_capability() {
        // The Stage 13 contract: licensing never gates the local engine.
        let s = LicenseStatusDto::unactivated();
        assert_eq!(s.state, "not_activated");
        assert_eq!(s.edition, None);
        assert!(s.capabilities.contains(&"enhance"));
        for f in [
            Feature::Enhance,
            Feature::Export,
            Feature::Batch,
            Feature::HistoryJournal,
        ] {
            assert!(allows(None, f));
            assert!(allows(Some(Edition::Pro), f));
        }
    }

    #[test]
    fn signing_and_verifying_agree_on_exact_payload_bytes() {
        // A payload re-serialized with different whitespace must fail:
        // the signature covers the embedded bytes, not an equivalent
        // object model.
        let key = issue(&payload_at(T0 - 10));
        let parts: Vec<&str> = key.split('.').collect();
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let decoded = base64::Engine::decode(&engine, parts[1]).unwrap();
        let pretty: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
        let reserialized = serde_json::to_vec_pretty(&pretty).unwrap();
        let remade = format!(
            "FOVEA1.{}.{}",
            base64::Engine::encode(&engine, &reserialized),
            parts[2]
        );
        assert_eq!(
            key::verify_key(&remade, T0, machine::id()).err(),
            Some(KeyRejection::Malformed)
        );
    }
}
