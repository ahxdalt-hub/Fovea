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

use std::io::Write as _;

use upscaler_lib::services::license::key::{Edition, LicensePayload, sign_key};
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

    let seed_hex = if has("--dev") {
        DEV_SEED_HEX.to_string()
    } else if let Some(s) = value("--seed") {
        s
    } else if let Ok(s) = std::env::var("FOVEA_LICENSE_PRIVATE_KEY") {
        s
    } else {
        die("no seed: pass --dev, --seed <hex>, or FOVEA_LICENSE_PRIVATE_KEY");
    };
    let seed = hex32(&seed_hex);

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
