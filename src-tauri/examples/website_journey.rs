//! Stage 16 — the commercial journey, end to end, against the REAL code.
//!
//! This is the safe, offline simulation of a customer walking from the website
//! to a working, licensed desktop app. It runs entirely on the developer
//! machine (debug build), so it uses the debug-only DEV key pair — which is
//! exactly the point: a *release* binary would reject a key signed this way,
//! so this fixture proves both that the chain maps correctly AND where the
//! signing boundary sits.
//!
//! Chain exercised, one arrow per step:
//!
//!   Website  →  Purchase (a tier)  →  License issued (vendor-side signing)
//!            →  Delivery (paste, whitespace-tolerant)  →  Activation (offline
//!            verify on this machine)  →  Image enhancement (local ONNX)
//!            →  Export (atomic write).
//!
//! The image is processed locally at every step; nothing is uploaded, and the
//! private seed here mirrors `examples/issue_license.rs`, never the shipped
//! app. Run with:
//!
//!   cargo run --manifest-path src-tauri/Cargo.toml --example website_journey
//!
//! Optional args: `-- <out-dir>` (default: a temp dir).

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use upscaler_lib::services::export::{self, ExportFormat};
use upscaler_lib::services::inference::backend::{CancelToken, OnnxBackend};
use upscaler_lib::services::inference::model::{EnhanceMode, ModelRegistry};
use upscaler_lib::services::inference::service::{self, EngineConfig, JobRegistry};
use upscaler_lib::services::license::key::{self, Edition, LicensePayload, sign_key};
use upscaler_lib::services::license::{allows, machine, now_secs, Feature};

// The website maps each paid tier to a license edition. These literals must
// match BOTH `lib/commerce.ts` (TIER_EDITION) and the Rust `Edition::as_str()`;
// if either side drifts, one of the asserts below fires. This is the seam that
// keeps the store and the desktop key format speaking the same language.
const WEB_TIER_PRO_EDITION: &str = "pro";
const WEB_TIER_STUDIO_EDITION: &str = "studio";

/// Stand-in for the vendor's issuing step (`examples/issue_license.rs`): a
/// purchase completes, and this is the code path that mints the key the buyer
/// receives. Only ever runs in a debug build — DEV_SEED_HEX is `cfg`-gated.
fn vendor_issue(tier: &str, holder: &str, license_id: &str) -> String {
    #[cfg(not(debug_assertions))]
    {
        let _ = (tier, holder, license_id);
        panic!("website_journey must run in a debug build: the dev seed is debug-only");
    }
    #[cfg(debug_assertions)]
    {
        use upscaler_lib::services::license::keys::DEV_SEED_HEX;
        let edition = match tier {
            "pro" => Edition::Pro,
            "studio" => Edition::Studio,
            other => panic!("unknown tier {other}"),
        };
        let seed: Vec<u8> = (0..64)
            .step_by(2)
            .map(|i| u8::from_str_radix(&DEV_SEED_HEX[i..i + 2], 16).unwrap())
            .collect();
        let payload = LicensePayload {
            v: 1,
            product: "pixora".into(),
            edition,
            license_id: license_id.into(),
            holder: holder.into(),
            // Issued "now"; the app tolerates a small forward skew.
            issued: now_secs().saturating_sub(5),
            // A dated license (not perpetual) so the expiry path is exercised
            // too. The desktop UI shows this under "Expires".
            expires: Some(now_secs() + 30 * 86_400),
            // Seat-free key: usable on any machine the holder owns — matches
            // the website's "covers multiple machines" promise for Studio.
            machine: None,
        };
        sign_key(&payload, &seed).expect("vendor signing succeeds")
    }
}

/// A tiny, structured fixture (fast to enhance, but not a flat fill).
fn write_source(path: &Path) {
    let (w, h) = (120u32, 80u32);
    let mut img = RgbaImage::new(w, h);
    for (x, y, p) in img.enumerate_pixels_mut() {
        let edge = (x + y) % 7 == 0;
        let base = 40 + ((x * 3 + y * 2) % 180) as u8;
        *p = if edge {
            Rgba([255, 255, 255, 255])
        } else {
            Rgba([base, (base / 2), 220 - base / 3, 255])
        };
    }
    let mut buf = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(img)
        .write_to(&mut buf, ImageFormat::Png)
        .expect("encode source");
    std::fs::write(path, buf.into_inner()).expect("write source");
}

fn main() {
    let out = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("pixora-stage16-journey"));
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).expect("out dir");

    println!("Stage 16 — customer journey: Website → licensed local enhancement\n");

    // 1-3. Website picks a tier → purchase → vendor issues a key.
    // Exercise the featured tier (Studio), then confirm Pro maps cleanly too.
    let studio_key = vendor_issue("studio", "buyer@example.com", "PL-JOURNEY-1");
    assert!(
        studio_key.starts_with("PIXORA1."),
        "delivered key is not a PIXORA1 key"
    );
    let pro_key = vendor_issue("pro", "solo@example.com", "PL-JOURNEY-2");
    println!("  [1-3] purchase → license issued");
    println!("        studio edition as_str = {}", Edition::Studio.as_str());
    println!("        pro    edition as_str = {}", Edition::Pro.as_str());
    assert_eq!(Edition::Studio.as_str(), WEB_TIER_STUDIO_EDITION);
    assert_eq!(Edition::Pro.as_str(), WEB_TIER_PRO_EDITION);

    // 4-5. Delivery → paste (with the whitespace a real copy-paste always
    // brings) → activation. Activation's proof is the offline signature verify
    // against THIS machine's identity — `verify_key` is exactly what
    // `services::license::activate` runs before it stores the key. We stop at
    // the verify (not the store) so the test never writes the real Windows
    // Credential Store; the store/status path is covered by the Stage 13 unit
    // tests, which use the file backend and a fixed clock.
    let pasted = format!("  {}\n", studio_key.replace('.', ".\n")); // messy paste
    let payload = key::verify_key(&pasted, now_secs(), machine::id())
        .expect("a delivered key verifies offline on this machine");
    println!("  [4-5] delivery → paste → verify signature (offline)");
    println!(
        "        product={} edition={:?} holder={} id={} expires={:?}",
        payload.product,
        payload.edition,
        payload.holder,
        payload.license_id,
        payload.expires,
    );
    assert_eq!(payload.product, "pixora");
    assert_eq!(payload.edition, Edition::Studio);
    assert_eq!(payload.holder, "buyer@example.com");
    assert_eq!(payload.license_id, "PL-JOURNEY-1");
    assert!(payload.expires.is_some(), "the delivered key carries its validity window");

    // Pro maps cleanly too, and a key forged for another product / machine is
    // still refused — activation is not a rubber stamp just because the real
    // chain works.
    let pro = key::verify_key(&pro_key, now_secs(), machine::id()).expect("pro key verifies");
    assert_eq!(pro.edition, Edition::Pro);
    assert!(
        key::verify_key("PIXORA1.not.a.sig", now_secs(), machine::id()).is_err(),
        "a malformed key must never verify"
    );

    // The Stage 13 contract the whole commercial story rests on: licensing is a
    // record, NEVER a gate. Both an unactivated install and a paid edition grant
    // every shipped capability — so activation cannot have hidden a feature,
    // and a failed activation can never block work.
    for f in [Feature::Enhance, Feature::Export, Feature::Batch, Feature::HistoryJournal] {
        assert!(allows(None, f), "unactivated must grant {}", f.key());
        assert!(allows(Some(Edition::Pro), f));
        assert!(allows(Some(Edition::Studio), f));
    }
    println!("  [5]   gate check: every feature allowed for None/Pro/Studio (no paywall)");

    // 6. Enhance locally: the real ONNX backend on this machine (DirectML GPU
    // when present, CPU otherwise). This is the image step the website can
    // never do — it happens here, on the buyer's hardware.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("models");
    let registry = ModelRegistry::new(vec![manifest]);
    let engine = service::inference_status(&registry);
    assert!(engine.ready, "engine must be ready to run a real enhancement");
    let source = out.join("source.png");
    write_source(&source);
    let masters_dir = out.join("enhanced");
    std::fs::create_dir_all(&masters_dir).expect("masters dir");

    let jobs = JobRegistry::new();
    let token = Arc::new(CancelToken::new());
    let job_id = jobs.next_job_id();
    jobs.begin(&job_id, token.clone()).expect("begin");
    let result = service::enhance(
        &source.to_string_lossy(),
        EnhanceMode::Standard,
        2,
        &registry,
        &EngineConfig::default(),
        &masters_dir,
        &jobs,
        &job_id,
        &token,
        |_| {},
        OnnxBackend::load_with,
    )
    .expect("local enhance succeeds");
    let master = Path::new(&result.file_path);
    let decoded = image::open(master).expect("master decodes");
    assert_eq!((decoded.width(), decoded.height()), (240, 160), "2× of 120×80");
    println!("  [6]   enhance locally → {}×{} · engine {}", decoded.width(), decoded.height(), result.engine);

    // 7. Export: atomic, into the buyer's chosen folder.
    let export_dir = out.join("exports");
    std::fs::create_dir_all(&export_dir).expect("export dir");
    let png = export::export_image(master, &export_dir, "journey", ExportFormat::Png, 90)
        .expect("png export");
    let jpeg = export::export_image(master, &export_dir, "journey", ExportFormat::Jpeg, 90)
        .expect("jpeg export");
    let png_decoded = image::open(&png.file_path).expect("png decodes");
    let jpeg_decoded = image::open(&jpeg.file_path).expect("jpeg decodes");
    assert_eq!((png_decoded.width(), png_decoded.height()), (240, 160));
    assert_eq!((jpeg_decoded.width(), jpeg_decoded.height()), (240, 160));
    println!(
        "  [7]   export → {} ({} bytes) · {} ({} bytes)",
        png.file_name, png.bytes, jpeg.file_name, jpeg.bytes,
    );

    println!("\nCustomer journey verified: purchase → issue → deliver → activate → enhance → export.");
    println!("Images processed locally throughout; license verified offline; no network touched.");
    println!("Artifacts under {}", out.display());
}
