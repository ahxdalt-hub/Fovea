//! The license key: a compact, human-pasteable, *cryptographically signed*
//! statement about a purchase.
//!
//! Format: `FOVEA1.<base64url(payload JSON)>.<base64url(ed25519 sig)>`
//!
//! Why offline-capable signatures rather than a server round-trip:
//! Fovea's engine makes zero network calls, and the licensing layer must
//! not become the reason it suddenly needs one. A signed key gives the
//! strongest property a local-first app can have — the app trusts the
//! vendor's signature, not anything the user (or a tampered local file,
//! or a captured request) says about the license. Activation then needs
//! no connectivity at all; the *purchase* that produces the key happens
//! wherever the vendor sells (payment-provider logic stays entirely on
//! the issuing side, isolated behind `examples/issue_license.rs`).
//!
//! The signature covers the exact payload bytes; they are verified before
//! being parsed, so no field of an unverified payload is ever read.

use base64::Engine as _;
use ed25519_compact::{PublicKey, Signature};
use serde::{Deserialize, Serialize};

use super::keys;

/// The only key format this build understands. A future format bump adds
/// `FOVEA2` handling beside this one, never a silent reinterpretation.
const KEY_PREFIX: &str = "FOVEA1.";

/// Product identifier embedded in every key — a key issued for a
/// different product is not a Fovea license, whatever it says.
pub const PRODUCT_ID: &str = "fovea";

const MAX_PAYLOAD_BYTES: usize = 4096;
/// Clock tolerance for a freshly issued key (issuing machine slightly
/// ahead of this one). Wider than that, a future-dated key is refused.
const ISSUED_SKEW_SECONDS: u64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edition {
    /// Full commercial license: everything this build ships.
    Pro,
    /// Multi-seat / larger-scope license. Same features in this build —
    /// the distinction is in the license terms, carried in the key.
    Studio,
}

impl Edition {
    pub fn as_str(self) -> &'static str {
        match self {
            Edition::Pro => "pro",
            Edition::Studio => "studio",
        }
    }
}

/// The signed statement itself. Field names are short on purpose: the
/// key is pasted by humans, payload bytes go into its body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicensePayload {
    /// Payload schema version. Anything else refuses to parse forward.
    pub v: u8,
    pub product: String,
    pub edition: Edition,
    /// Vendor-side license identifier — the string support can look up.
    #[serde(rename = "id")]
    pub license_id: String,
    /// Who the license belongs to (email or organisation name).
    pub holder: String,
    /// Issuance time, unix seconds.
    pub issued: u64,
    /// End of validity, unix seconds; `None` = perpetual.
    #[serde(default)]
    pub expires: Option<u64>,
    /// Machine fingerprint this key is bound to; `None` = seat-free key
    /// (usable on any machine the holder owns). When present, it must
    /// equal this machine's id — see `machine.rs`.
    #[serde(default)]
    pub machine: Option<String>,
}

/// Every reason a well-formed key can still be no license.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyRejection {
    /// Not a key at all (wrong shape, bad base64, bad signature,
    /// unsupported format). One variant on purpose: the difference is
    /// the vendor's problem to investigate, never the user's to parse,
    /// and enumerating it would tell a forger which layer failed.
    Malformed,
    /// A key for something other than Fovea.
    WrongProduct,
    /// Signed correctly but for another machine.
    WrongMachine,
    /// Valid key, validity window over. Carries the (signature-verified)
    /// payload so the UI can name the holder and the date.
    Expired(Box<LicensePayload>),
    /// Valid key, but stamped from the future beyond tolerance — either a
    /// broken issuing clock or this machine's clock wound back.
    ClockSuspect,
    /// Schema this build cannot honour (v2+).
    UnsupportedVersion,
}

/// Decode + cryptographically verify + interpret a key against a fixed
/// instant, returning the payload only when the signature proves it.
/// `this_machine` is `None` when this machine cannot be identified —
/// machine-bound keys then fail closed (WrongMachine), free keys pass.
pub fn verify_key(
    key: &str,
    now: u64,
    this_machine: Option<&str>,
) -> Result<LicensePayload, KeyRejection> {
    let payload_bytes = extract_signed_bytes(key)?;
    if payload_bytes.len() > MAX_PAYLOAD_BYTES {
        return Err(KeyRejection::Malformed);
    }
    let signature = extract_signature(key)?;

    let mut verified = false;
    for pk_hex in keys::public_keys_hex() {
        let Ok(pk_bytes) = hex_bytes(&pk_hex) else {
            continue; // a malformed embedded key is skipped, never fatal
        };
        let Ok(pk) = PublicKey::from_slice(&pk_bytes) else {
            continue;
        };
        if pk.verify(&payload_bytes, &signature).is_ok() {
            verified = true;
            break;
        }
    }
    if !verified {
        return Err(KeyRejection::Malformed);
    }

    // The bytes are provenance-marked now; only now are they parsed.
    let payload: LicensePayload =
        serde_json::from_slice(&payload_bytes).map_err(|_| KeyRejection::Malformed)?;
    if payload.v != 1 {
        return Err(KeyRejection::UnsupportedVersion);
    }
    if payload.product != PRODUCT_ID {
        return Err(KeyRejection::WrongProduct);
    }
    if let Some(bound) = &payload.machine {
        if this_machine != Some(bound.as_str()) {
            return Err(KeyRejection::WrongMachine);
        }
    }
    if payload.issued > now.saturating_add(ISSUED_SKEW_SECONDS) {
        return Err(KeyRejection::ClockSuspect);
    }
    if let Some(expires) = payload.expires {
        if now >= expires {
            return Err(KeyRejection::Expired(Box::new(payload)));
        }
    }
    Ok(payload)
}

/// Convenience for the issuing tool: build a key from a payload and a
/// 32-byte secret seed, signing the exact compact-JSON bytes embedded.
pub fn sign_key(payload: &LicensePayload, seed_bytes: &[u8]) -> Result<String, String> {
    use ed25519_compact::{KeyPair, Seed};
    let Ok(seed_bytes) = <[u8; 32]>::try_from(seed_bytes) else {
        return Err("seed must be exactly 32 bytes".into());
    };
    let pair = KeyPair::from_seed(Seed::from(seed_bytes));
    let body = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    let sig: Signature = pair.sk.sign(&body, None);
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    Ok(format!(
        "{KEY_PREFIX}{}.{}",
        engine.encode(&body),
        engine.encode(sig.as_ref())
    ))
}

/// `FOVEA1.<payload>.<signature>` — exactly two non-empty segments. A key
/// with a third segment is malformed even if a valid signature happens to
/// sit at either end of it.
fn segments(key: &str) -> Result<(String, String), KeyRejection> {
    let trimmed: String = key.chars().filter(|c| !c.is_whitespace()).collect();
    let body = trimmed
        .strip_prefix(KEY_PREFIX)
        .ok_or(KeyRejection::Malformed)?;
    let (payload, signature) = body.split_once('.').ok_or(KeyRejection::Malformed)?;
    if payload.is_empty()
        || signature.is_empty()
        || signature.contains('.')
        || signature.contains('-')
            && !signature
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(KeyRejection::Malformed);
    }
    Ok((payload.to_string(), signature.to_string()))
}

fn extract_signed_bytes(key: &str) -> Result<Vec<u8>, KeyRejection> {
    let (payload_part, _) = segments(key)?;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let bytes = engine
        .decode(payload_part)
        .map_err(|_| KeyRejection::Malformed)?;
    if std::str::from_utf8(&bytes).is_err() {
        return Err(KeyRejection::Malformed);
    }
    Ok(bytes)
}

fn extract_signature(key: &str) -> Result<Signature, KeyRejection> {
    let (_, sig_part) = segments(key)?;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let bytes = engine
        .decode(sig_part)
        .map_err(|_| KeyRejection::Malformed)?;
    Signature::from_slice(&bytes).map_err(|_| KeyRejection::Malformed)
}

fn hex_bytes(hex: &str) -> Result<Vec<u8>, ()> {
    if hex.len() % 2 != 0 {
        return Err(());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|_| ()))
        .collect()
}
