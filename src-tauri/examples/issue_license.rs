//! Vendor tooling — issues Fovea license keys. NOT part of the app.
//!
//! This is the "License issued" step of the commercial chain, and the
//! only place a *private* signing key is ever used. The private key is
//! taken from `FOVEA_LICENSE_PRIVATE_KEY` (hex seed) or `--seed`; for
//! dev builds `--dev` uses the committed dev seed, which release binaries
//! deliberately cannot verify against (debug-only key, see
//! `services/license/keys.rs`).
//!
//! A payment provider would sit *in front* of this tool (purchase
//! completes → provider calls/renders a key), never inside the desktop
//! app. Provider APIs change and differ; nothing in `src/` assumes one.
//!
//! Usage (debug build):
//!   cargo run --manifest-path src-tauri/Cargo.toml --example issue_license -- \
//!     --dev --holder "ada@example.com" --edition pro --id PL-2026-000001
//!   ... --expires 2027-10-01          # a dated license
//!   ... --machine <fingerprint-hex>   # machine-bound (status shows this machine's)
//!   cargo run ... --example issue_license -- --generate   # new keypair
//!   cargo run ... --example issue_license -- --public     # the public key for
//!     the seed in FOVEA_LICENSE_PRIVATE_KEY — what a build must embed
//!   cargo run ... --example issue_license -- --verify "FOVEA1.…" [--machine <hex>]
//!     # read a key back with this build's verifiers; needs no private key

use std::io::Write as _;

use upscaler_lib::services::license::key::{Edition, LicensePayload, sign_key};
#[cfg(debug_assertions)]
use upscaler_lib::services::license::keys::DEV_SEED_HEX;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |flag: &str| args.iter().any(|a| a == flag);
    let value = |flag: &str| -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };

    if has("--generate") {
        generate();
        return;
    }

    // The read end of the vendor loop: check a key with the *same* verifier the
    // shipped app runs — the public keys this build was packaged with — before
    // it is emailed to anyone, and to answer a support ticket without the
    // private key being involved at all.
    if let Some(raw) = value("--verify") {
        verify(raw.trim(), value("--machine").as_deref());
        return;
    }

    let seed_hex = if has("--dev") {
        dev_seed()
    } else if let Some(s) = value("--seed") {
        s
    } else if let Ok(s) = std::env::var("FOVEA_LICENSE_PRIVATE_KEY") {
        s
    } else {
        die("no seed: pass --dev, --seed <hex>, or FOVEA_LICENSE_PRIVATE_KEY");
    };
    let seed = hex32(&seed_hex);

    // The question packaging itself cannot answer: is the public key baked
    // into a release build the one this guarded seed actually signs with? A
    // mismatch means every customer key fails activation in the field with no
    // clue on the machine. Prints the verifier and stops, so the seed never
    // has to leave the vendor machine.
    if has("--public") {
        use ed25519_compact::{KeyPair, Seed};
        let bytes = <[u8; 32]>::try_from(seed.as_slice()).expect("hex32 checked length");
        println!("{}", hex(KeyPair::from_seed(Seed::from(bytes)).pk.as_ref()));
        return;
    }

    let holder = value("--holder").unwrap_or_else(|| die("--holder is required"));
    let edition = match value("--edition").as_deref() {
        Some("studio") => Edition::Studio,
        _ => Edition::Pro,
    };
    let id = value("--id").unwrap_or_else(|| {
        format!(
            "PL-{}-{}",
            year_now(),
            std::time::SystemTime::now()
                .elapsed()
                .unwrap_or_default()
                .subsec_micros()
        )
    });
    let issued = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let expires = value("--expires")
        .map(|d| parse_date_secs(&d))
        .transpose()
        .unwrap_or_else(|e| die(&e));
    let machine = value("--machine");

    let payload = LicensePayload {
        v: 1,
        product: "fovea".into(),
        edition,
        license_id: id.clone(),
        holder: holder.clone(),
        issued,
        expires,
        machine: machine.clone(),
    };
    let key = sign_key(&payload, &seed).unwrap_or_else(|e| die(&format!("signing failed: {e}")));

    println!("license id : {id}");
    println!("holder     : {holder}");
    println!("edition    : {}", edition.as_str());
    println!(
        "expires    : {}",
        expires
            .map(format_date)
            .unwrap_or_else(|| "perpetual".into())
    );
    println!(
        "machine    : {}",
        machine.unwrap_or_else(|| "unbound".into())
    );
    println!();
    println!("{key}");
}

/// `--dev` is a debug affordance: the committed dev pair does not exist as a
/// verifier in a release build, so a release-built tool has no business
/// signing with it. Keeping the branch honest in both configurations means the
/// example compiles — and refuses — the same way whichever profile built it.
#[cfg(debug_assertions)]
fn dev_seed() -> String {
    DEV_SEED_HEX.to_string()
}

#[cfg(not(debug_assertions))]
fn dev_seed() -> ! {
    die(
        "--dev signs with the debug-only dev pair, which a release build cannot verify; \
         pass --seed or FOVEA_LICENSE_PRIVATE_KEY",
    )
}

fn generate() {
    use ed25519_compact::{KeyPair, Seed};
    let pair = KeyPair::from_seed(Seed::generate());
    println!("seed (private, guard this) : {}", hex(pair.sk.as_ref()));
    println!("public key (build-time env): {}", hex(pair.pk.as_ref()));
    println!(
        "→ rebuild the app with FOVEA_LICENSE_PUBKEYS=\"{}\"",
        hex(pair.pk.as_ref())
    );
}

/// Read a key back exactly as the app would: same verifier list, same clock
/// rule, same machine binding. Anything this prints is what a customer's
/// Fovea will conclude about that key.
fn verify(raw: &str, machine: Option<&str>) {
    use upscaler_lib::services::license::key::verify_key;
    use upscaler_lib::services::license::{keys, now_secs};
    match verify_key(raw, now_secs(), machine) {
        Ok(payload) => {
            println!(
                "signature  : verifies against this build's keys — {}",
                keys::public_keys_hex().join(", ")
            );
            println!("license id : {}", payload.license_id);
            println!("holder     : {}", payload.holder);
            println!("edition    : {}", payload.edition.as_str());
            println!(
                "expires    : {}",
                payload
                    .expires
                    .map(format_date)
                    .unwrap_or_else(|| "perpetual".into())
            );
            println!(
                "machine    : {}",
                payload.machine.as_deref().unwrap_or("unbound")
            );
        }
        Err(reason) => die(&format!("rejected: {reason:?}")),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex32(s: &str) -> Vec<u8> {
    let s = s.trim();
    if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        die("seed must be 64 hex characters (32 bytes)");
    }
    (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex checked"))
        .collect()
}

fn year_now() -> u16 {
    (parse_date_secs_epoch(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_secs(),
    )
    .0) as u16
}

/// Days-from-civil inverse for YYYY-MM-DD; returns unix seconds at 00:00 UTC.
fn parse_date_secs(s: &str) -> Result<u64, String> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 {
        return Err(format!("bad date: {s} (want YYYY-MM-DD)"));
    }
    let y: i64 = parts[0].parse().map_err(|_| "bad year".to_string())?;
    let m: i64 = parts[1].parse().map_err(|_| "bad month".to_string())?;
    let d: i64 = parts[2].parse().map_err(|_| "bad day".to_string())?;
    Ok(days_from_civil(y, m, d) as u64 * 86_400)
}

/// Howard Hinnant's days_from_civil, public-domain algorithm.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn parse_date_secs_epoch(secs: u64) -> (i64, i64, i64) {
    let z = secs / 86_400;
    civil_from_days(z as i64)
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn format_date(secs: u64) -> String {
    let (y, m, d) = parse_date_secs_epoch(secs);
    format!("{y:04}-{m:02}-{d:02}")
}

fn die(msg: &str) -> ! {
    let _ = writeln!(std::io::stderr(), "{msg}");
    std::process::exit(2);
}
