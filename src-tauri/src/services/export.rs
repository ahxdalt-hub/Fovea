//! Export service (Stage 06) — turn a committed enhancement result into a
//! file the user chose: format, quality, and folder.
//!
//! Contract points:
//! - The master is always the engine's lossless PNG. PNG export is a
//!   byte-identical copy — zero recompression, the honest best path.
//! - JPEG export flattens alpha onto white (the universal backdrop —
//!   JPEG has no transparency), then encodes at the requested quality.
//! - WebP export keeps alpha and encodes lossy at the requested quality
//!   via libwebp (`webp` crate). Each codec's dimension ceiling is refused
//!   as a named `ExportLimit` before the encoder runs — libwebp's failure
//!   mode is an error the convenience API turns into a panic.
//! - File names never overwrite silently — a collision gains a numeric
//!   suffix. The stem is sanitized so a strange file name can't escape the
//!   destination folder.
//! - No cancel channel: encoding runs on the blocking pool and is seconds,
//!   not the minutes an inference job takes; the command's promise carries
//!   the outcome.

use std::fs;
use std::io::{BufWriter, Cursor, Write};
use std::path::{Path, PathBuf};

use image::{DynamicImage, RgbaImage};
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Export formats the UI may offer — the set Fovea can actually write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Png,
    Jpeg,
    Webp,
}

impl ExportFormat {
    pub fn key(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
            Self::Webp => "webp",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        match key.to_ascii_lowercase().as_str() {
            "png" => Some(Self::Png),
            "jpeg" | "jpg" => Some(Self::Jpeg),
            "webp" => Some(Self::Webp),
            _ => None,
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
        }
    }
}

/// Clamped to the codecs' honest range; the UI slider already bounds it.
pub fn normalize_quality(quality: u8) -> u8 {
    quality.clamp(1, 100)
}

/// libwebp's hard ceiling: no edge above this. Exceeding it is a format
/// limit, not a machine failure, so it is refused before the encoder runs.
const WEBP_MAX_EDGE: u32 = 16383;

/// Result of one export — serialized to the UI (`ExportResultDto`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// The committed file's full path (for the success message).
    pub file_path: PathBuf,
    pub file_name: String,
    /// Folder it landed in (display).
    pub folder: String,
    pub format: &'static str,
    pub bytes: u64,
}

/// Write `master` (the engine's PNG) into `dest_dir` as `format` at
/// `quality`. `stem` is the base file name without extension. Atomic per
/// file: encode to `<name>.<ext>.part` and rename, so an interrupted
/// export never leaves a half-written file the user might trust.
pub fn export_image(
    master: &Path,
    dest_dir: &Path,
    stem: &str,
    format: ExportFormat,
    quality: u8,
) -> AppResult<ExportResult> {
    if !master.is_file() {
        return Err(AppError::FileMissing {
            detail: "enhancement output gone".into(),
        });
    }
    let bytes = fs::read(master).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::FileMissing {
                detail: e.to_string(),
            }
        } else {
            AppError::from(e)
        }
    })?;

    fs::create_dir_all(dest_dir).map_err(AppError::from)?;

    let encoded = match format {
        // PNG is byte-identical: copy the master, zero recompression.
        ExportFormat::Png => bytes,
        ExportFormat::Jpeg | ExportFormat::Webp => {
            let decoded = image::load_from_memory(&bytes)
                .map_err(|e| AppError::unexpected(format!("decode master: {e}")))?;
            encode_lossy(&decoded, format, normalize_quality(quality))?
        }
    };

    let path = collision_safe_path(dest_dir, stem, format.extension());
    let part = path.with_extension(format!("{}.part", format.extension()));
    {
        let file = fs::File::create(&part).map_err(AppError::from)?;
        let mut writer = BufWriter::with_capacity(1 << 16, file);
        writer.write_all(&encoded).map_err(AppError::from)?;
        writer.flush().map_err(AppError::from)?;
    }
    fs::rename(&part, &path).map_err(|e| {
        let _ = fs::remove_file(&part);
        AppError::from(e)
    })?;

    Ok(ExportResult {
        bytes: encoded.len() as u64,
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        folder: dest_dir.to_string_lossy().into_owned(),
        file_path: path,
        format: format.key(),
    })
}

/// Encode the whole frame for a lossy target. Memory: one decoded frame —
/// the same tier the viewer ladder already materializes for display; a
/// streaming re-encode is a later-stage optimization with a measured need.
fn encode_lossy(img: &DynamicImage, format: ExportFormat, quality: u8) -> AppResult<Vec<u8>> {
    match format {
        ExportFormat::Jpeg => {
            // Baseline JPEG's own ceiling (the encoder errors past it, but
            // a named limit beats a generic "encode failed").
            if img.width().max(img.height()) > 65535 {
                return Err(AppError::ExportLimit {
                    detail: "jpeg edge over 65535".into(),
                });
            }
            // JPEG has no alpha channel: composite onto white so
            // transparency reads as the same white any viewer would show.
            let rgb = flatten_on_white(img).to_rgb8();
            let mut out = Cursor::new(Vec::new());
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
                .encode_image(&rgb)
                .map_err(|e| AppError::unexpected(format!("jpeg encode: {e}")))?;
            Ok(out.into_inner())
        }
        ExportFormat::Webp => {
            // libwebp refuses any edge over 16383 px, and the crate's
            // convenience `encode()` answers that refusal by panicking on
            // an internal unwrap. A 4× master from a 4100 px source used to
            // kill the app mid-save. Name the ceiling here, and use the
            // error-returning encoder for everything else.
            let longest = img.width().max(img.height());
            if longest > WEBP_MAX_EDGE {
                return Err(AppError::ExportLimit {
                    detail: format!("webp edge {longest} > {WEBP_MAX_EDGE}"),
                });
            }
            let q = quality as f32;
            let mem = if img.color().has_alpha() {
                let rgba = img.to_rgba8();
                webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height())
                    .encode_simple(false, q)
                    .map_err(|e| AppError::InsufficientResources {
                        detail: format!("webp encode: {e:?}"),
                    })?
            } else {
                let rgb = img.to_rgb8();
                webp::Encoder::from_rgb(rgb.as_raw(), rgb.width(), rgb.height())
                    .encode_simple(false, q)
                    .map_err(|e| AppError::InsufficientResources {
                        detail: format!("webp encode: {e:?}"),
                    })?
            };
            Ok(mem.to_vec())
        }
        ExportFormat::Png => unreachable!("handled by the copy path"),
    }
}

/// Composite RGBA onto white, return an opaque RGB image.
fn flatten_on_white(img: &DynamicImage) -> DynamicImage {
    if !img.color().has_alpha() {
        return img.clone();
    }
    let rgba: RgbaImage = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let mut out = image::RgbImage::new(w, h);
    for (x, y, px) in rgba.enumerate_pixels() {
        let a = px[3] as u32;
        let blend = |c: u8| (((c as u32 * a) + (255 * (255 - a))) / 255) as u8;
        out.put_pixel(x, y, image::Rgb([blend(px[0]), blend(px[1]), blend(px[2])]));
    }
    DynamicImage::ImageRgb8(out)
}

/// `<dir>/<stem>.<ext>`, gaining `-2`, `-3`, … until free. The engine's
/// own enhanced dir can never be a destination.
fn collision_safe_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let sanitize = |s: &str| -> String {
        s.chars()
            .map(|c| match c {
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
                c => c,
            })
            .collect()
    };
    let stem = sanitize(stem);
    let stem = stem.trim().trim_matches('.');
    let stem = if stem.is_empty() { "fovea" } else { stem };
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    for n in 2u32..1000 {
        let candidate = dir.join(format!("{stem}-{n}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // 999 collisions is not a real export workflow; fall back to a
    // timestamped name rather than loop forever.
    dir.join(format!("{stem}-{}.{}", unix_millis(), ext))
}

fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgba, RgbaImage};

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fovea-export-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    /// Gradient PNG with sharp color steps — every encoder must preserve
    /// the structure, and it distinguishes formats by size.
    fn master_png(dir: &Path, w: u32, h: u32, alpha: bool) -> PathBuf {
        let mut img = RgbaImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = Rgba([
                (x * 7 % 256) as u8,
                (y * 11 % 256) as u8,
                ((x + y) * 3 % 256) as u8,
                if alpha && (x + y) % 2 == 0 { 128 } else { 255 },
            ]);
        }
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(img)
            .write_to(&mut out, ImageFormat::Png)
            .expect("encode");
        let path = dir.join("master.png");
        fs::write(&path, out.into_inner()).expect("write master");
        path
    }

    #[test]
    fn png_export_is_byte_identical() {
        let root = scratch("png");
        let master = master_png(&root, 64, 48, false);
        let dest = root.join("out");
        let result =
            export_image(&master, &dest, "sunset 2x", ExportFormat::Png, 90).expect("export");
        let written = fs::read(&result.file_path).expect("written");
        assert_eq!(
            written,
            fs::read(&master).expect("master"),
            "PNG copy is lossless"
        );
        assert_eq!(result.file_name, "sunset 2x.png");
    }

    #[test]
    fn jpeg_export_encodes_at_quality_and_shrinks() {
        let root = scratch("jpeg");
        let master = master_png(&root, 256, 192, false);
        let result = export_image(&master, &root, "photo", ExportFormat::Jpeg, 90).expect("export");
        assert_eq!(result.file_name, "photo.jpg");
        assert_eq!(result.format, "jpeg");
        let written = fs::read(&result.file_path).expect("written");
        assert!(written.starts_with(&[0xFF, 0xD8]), "valid JPEG header");
        // Re-encoding the gradient must decode at the same dimensions.
        let back = image::load_from_memory(&written).expect("decode");
        assert_eq!((back.width(), back.height()), (256, 192));
        // Quality 90 is smaller than the lossless master on this content.
        assert!(result.bytes < master.metadata().unwrap().len());
    }

    #[test]
    fn lower_quality_is_smaller() {
        let root = scratch("quality");
        let master = master_png(&root, 256, 192, false);
        let high = export_image(&master, &root, "hi", ExportFormat::Jpeg, 95).expect("q95");
        let low = export_image(&master, &root, "lo", ExportFormat::Jpeg, 30).expect("q30");
        assert!(low.bytes < high.bytes, "quality slider is real");
    }

    #[test]
    fn webp_export_round_trips_and_keeps_alpha() {
        let root = scratch("webp");
        let master = master_png(&root, 120, 80, true);
        let result = export_image(&master, &root, "art", ExportFormat::Webp, 80).expect("webp");
        assert_eq!(result.file_name, "art.webp");
        let written = fs::read(&result.file_path).expect("written");
        assert_eq!(&written[0..4], b"RIFF");
        assert_eq!(&written[8..12], b"WEBP");
        // The image crate's webp decoder reads lossy VP8 back — dimensions
        // must survive the round trip (pixel-level fidelity is a visual
        // matter, verified in the real-app QA pass).
        let back = image::load_from_memory(&written).expect("decode webp");
        assert_eq!((back.width(), back.height()), (120, 80));
        assert!(back.color().has_alpha(), "alpha kept");
    }

    /// libwebp's 16383 px edge ceiling has to be a named refusal, never the
    /// crate's panic-on-error: a 4× master from a 4100 px source is an
    /// ordinary phone-photo workflow.
    #[test]
    fn webp_refuses_an_over_ceiling_master_instead_of_panicking() {
        let root = scratch("webpceil");
        let master = master_png(&root, 17_000, 8, false);
        let err = export_image(&master, &root, "wide", ExportFormat::Webp, 80)
            .expect_err("over ceiling must fail");
        assert_eq!(err.code(), "export_limit");
        assert!(export_image(&master, &root, "wide", ExportFormat::Png, 80).is_ok());
        assert!(export_image(&master, &root, "wide", ExportFormat::Jpeg, 80).is_ok());
    }

    #[test]
    fn jpeg_export_flattens_alpha_on_white() {
        let root = scratch("flatten");
        let master = master_png(&root, 64, 64, true);
        let result = export_image(&master, &root, "cut", ExportFormat::Jpeg, 95).expect("export");
        let decoded = image::load_from_memory(&fs::read(&result.file_path).unwrap())
            .expect("decode")
            .into_rgb8();
        // The checkerboard alpha (128 over gradient+white) is a blend, not
        // black — bright side of every blended pixel stays bright.
        let p = decoded.get_pixel(0, 0).0; // alpha 128 over (0,0,0)→ 127ish
        assert!(
            p.iter().all(|&v| v > 100 && v < 160),
            "white blend, got {p:?}"
        );
    }

    #[test]
    fn collisions_gain_numeric_suffix_never_overwrite() {
        let root = scratch("collide");
        let master = master_png(&root, 32, 32, false);
        fs::write(root.join("same.png"), b"original bytes").expect("pre-existing");
        let result = export_image(&master, &root, "same", ExportFormat::Png, 90).expect("export");
        assert_eq!(result.file_name, "same-2.png");
        // The pre-existing file is untouched.
        assert_eq!(fs::read(root.join("same.png")).unwrap(), b"original bytes");
    }

    #[test]
    fn missing_master_is_file_missing() {
        let root = scratch("missing");
        let err = export_image(&root.join("gone.png"), &root, "x", ExportFormat::Png, 90)
            .expect_err("must fail");
        assert_eq!(err.code(), "file_missing");
    }

    #[test]
    fn hostile_stems_are_sanitized_not_injected() {
        let root = scratch("sanitize");
        let master = master_png(&root, 16, 16, false);
        let result =
            export_image(&master, &root, r"..\evil", ExportFormat::Png, 90).expect("export");
        assert!(result.file_path.starts_with(&root));
        assert!(!result.file_name.contains('\\'));
        let dots = export_image(&master, &root, "...", ExportFormat::Png, 90).expect("dots export");
        assert!(dots.file_name.starts_with("fovea")); // empty-after-trim → safe fallback
    }

    #[test]
    fn quality_is_clamped_into_codec_range() {
        assert_eq!(normalize_quality(0), 1);
        assert_eq!(normalize_quality(250), 100);
        assert_eq!(normalize_quality(82), 82);
    }
}
