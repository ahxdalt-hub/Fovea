//! License verification keys — the public half of the signing pair.
//!
//! Rules, in order of importance:
//! - Only *public* keys ever ship in the app. A public key verifies a
//!   license; it can never issue one. The private half stays with vendor
//!   tooling (`examples/issue_license.rs` takes it as an argument or env
//!   var; release packaging injects the matching public key).
//! - Production public keys are injected at build time by `build.rs` from
//!   the `PIXORA_LICENSE_PUBKEYS` env var (comma-separated hex).
//! - The dev key is compiled in only for debug builds. A release binary
//!   therefore cannot accept a key issued with the (committed) dev seed —
//!   the dev pair is a test fixture, not a skeleton key.

include!(concat!(env!("OUT_DIR"), "/license_pubkeys.rs"));

/// The dev seed and its public key. Test fixture + dev/QA license issuing
/// only. The seed is public knowledge on purpose: debug builds are never
/// distributed, and every test that "issues" a license uses this pair.
#[cfg(debug_assertions)]
pub const DEV_SEED_HEX: &str = "5cc1a5fe1158e4687684994f933f77b426437b7c003badda8767c6c92d9749fd";
#[cfg(debug_assertions)]
pub const DEV_PUBKEY_HEX: &str = "c79464553116722cdff402851971581d1ba15d271baf8c8bbcfe0d642ee21672";

/// Hex (lowercase) of every public key a license signature may be checked
/// against, in order. More than one key = painless key rotation: ship the
/// new key, keep the old one until every field install has re-activated.
pub fn public_keys_hex() -> Vec<String> {
    let mut keys: Vec<String> = INJECTED.iter().map(|k| (*k).to_string()).collect();
    #[cfg(debug_assertions)]
    keys.push(DEV_PUBKEY_HEX.to_string());
    keys
}
