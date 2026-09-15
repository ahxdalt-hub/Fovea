//! Image import service — the Stage 03 pipeline: validate, measure, preview.
//!
//! Everything here stays on this machine: bytes are read, decoded, and
//! re-encoded as a small local preview; nothing is sent anywhere. The
//! service never panics on hostile input — every failure maps to an
//! `AppError` whose user message is safe to display.
//!
//! Formats are declared in exactly two places: the `image` crate features
//! in Cargo.toml and [`FormatHint::from_extension`]. Adding a format later
//! (Stage 04+ or TIFF) means touching those and nothing else.

use std::io::Cursor;
use std::path::Path;

use base64::Engine as _;
use image::{DynamicImage, ImageFormat, ImageReader};
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Longest edge (px) of the imported image allowed by default: 64 MP.
pub const MAX_PIXELS: u64 = 64_000_000;
/// Largest on-disk file allowed by default: 200 MB.
pub const MAX_FILE_BYTES: u64 = 200 * 1024 * 1024;
/// The preview thumbnail never exceeds this longest edge (px).
const PREVIEW_EDGE: u32 = 480;

/// Supported image formats, in the vocabulary the UI displays.
/// Serde names are the conventional all-caps acronyms; Rust names follow
/// clippy's casing rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ImageFormatLabel {
    #[serde(rename = "JPEG")]
    Jpeg,
    #[serde(rename = "PNG")]
    Png,
    #[serde(rename = "WebP")]
    WebP,
}

impl ImageFormatLabel {
    fn from_image_format(fmt: ImageFormat) -> Option<Self> {
        match fmt {
            ImageFormat::Jpeg => Some(Self::Jpeg),
            ImageFormat::Png => Some(Self::Png),
            ImageFormat::WebP => Some(Self::WebP),
            _ => None,
        }
    }
}

/// What we know about a file from its extension, before opening it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FormatHint {
    Jpeg,
    Png,
    WebP,
}

impl FormatHint {
    /// Normalize an extension to a supported hint. Unknown → `None`, which
    /// the caller turns into "unsupported file type" — no case sensitivity,
    /// no alias guessing beyond jpg/jpeg.
    fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "png" => Some(Self::Png),
            "webp" => Some(Self::WebP),
            _ => None,
        }
    }

    fn image_format(self) -> ImageFormat {
        match self {
            Self::Jpeg => ImageFormat::Jpeg,
            Self::Png => ImageFormat::Png,
            Self::WebP => ImageFormat::WebP,
        }
    }
}

/// A successfully imported image: metadata plus a small local preview.
///
/// `id` is the canonical path. It doubles as the deduplication key (the
/// frontend's collection is keyed by it, so the same file dropped twice
/// appears once) and as the handle later stages pass back into native
/// commands to load the full-resolution file. Paths already reach the
/// webview via drag-drop payloads and the picker, so exposing the
/// canonicalized form leaks nothing new.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    pub id: String,
    /// Display name only (file name).
    pub name: String,
    pub format: ImageFormatLabel,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    /// Self-contained data URL for the local preview thumbnail.
    pub preview_data_url: String,
}

/// Per-file result of an import batch. A batch never fails as a whole:
/// each dropped file reports its own outcome so one bad file can't hide
/// the good ones.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ImportOutcome {
    Imported { image: ImportedImage },
    Failed { name: String, error: UserError },
}

/// The flat, user-safe half of `AppError` for embedding in outcomes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserError {
    pub code: &'static str,
    pub message: &'static str,
}

impl From<&AppError> for UserError {
    fn from(err: &AppError) -> Self {
        UserError {
            code: err.code(),
            message: err.user_message(),
        }
    }
}

/// Import every path, reporting per-file outcomes. Ordering is preserved.
pub fn import_many(paths: &[String]) -> Vec<ImportOutcome> {
    paths
        .iter()
        .map(|p| {
            let name = display_name(Path::new(p));
            match import_one(Path::new(p)) {
                Ok(image) => ImportOutcome::Imported { image },
                Err(err) => {
                    // Log internal detail once per file; the UI only ever
                    // sees the user-safe half.
                    err.log();
                    ImportOutcome::Failed {
                        name,
                        error: UserError::from(&err),
                    }
                }
            }
        })
        .collect()
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// The full validation ladder for one file. Cheap checks first (extension,
/// existence, size) so obviously wrong inputs never touch the decoder.
fn import_one_with_limits(
    path: &Path,
    max_pixels: u64,
    max_file_bytes: u64,
) -> AppResult<ImportedImage> {
    let name = display_name(path);
    if name.is_empty() || name.contains('\0') {
        return Err(AppError::FileMissing { detail: name });
    }

    // 1. Extension gate: reject unknown types before spending any I/O.
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .and_then(FormatHint::from_extension)
        .ok_or_else(|| AppError::UnsupportedFormat {
            detail: format!("extension rejected for {name}"),
        })?;

    // 2. Existence and readability.
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::FileMissing { detail: name });
        }
        Err(err) => return Err(AppError::from(err)),
    };
    if meta.is_dir() {
        return Err(AppError::UnsupportedFormat {
            detail: "folder dropped".into(),
        });
    }
    if meta.len() > max_file_bytes {
        return Err(AppError::FileTooLarge {
            detail: format!("{name}: {} bytes on disk", meta.len()),
        });
    }

    // 3. Read the whole file once; it is capped above.
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::FileMissing { detail: name });
        }
        Err(err) => return Err(AppError::from(err)),
    };

    // 4. Content sniff: the bytes must agree with the extension. Bytes that
    //    match no image header at all are corrupt-by-lie (InvalidImage); a
    //    .png that is really a GIF is an unsupported *image*
    //    (UnsupportedFormat). `guess_format` errors on unrecognized data.
    let guessed = image::guess_format(&bytes).map_err(|_| AppError::InvalidImage {
        detail: format!("{name}: no image header"),
    })?;
    let format = ImageFormatLabel::from_image_format(guessed).ok_or_else(|| {
        AppError::UnsupportedFormat {
            detail: format!("{name}: sniffed {guessed:?}"),
        }
    })?;
    if guessed != ext.image_format() {
        return Err(AppError::UnsupportedFormat {
            detail: format!("{name}: extension says {ext:?}, bytes say {guessed:?}"),
        });
    }

    // 5. Dimensions gate *before* decoding, so a crafted "decompression
    //    bomb" is rejected on its header, not on an OOM.
    let reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| AppError::InvalidImage {
            detail: format!("{name}: unreadable header"),
        })?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| AppError::InvalidImage {
            detail: format!("{name}: bad dimensions"),
        })?;
    let pixels = u64::from(width) * u64::from(height);
    if width == 0 || height == 0 {
        return Err(AppError::InvalidImage {
            detail: format!("{name}: zero-sized"),
        });
    }
    if pixels > max_pixels {
        return Err(AppError::FileTooLarge {
            detail: format!("{name}: {pixels} pixels"),
        });
    }

    // 6. Decode. Anything that got this far and still fails is genuinely
    //    corrupt.
    let decoded = image::load_from_memory_with_format(&bytes, guessed).map_err(|_| {
        AppError::InvalidImage {
            detail: format!("{name}: decode failed"),
        }
    })?;

    // 7. Preview + identity. Canonicalize so the same file dropped under
    //    two spellings deduplicates; if that fails (deleted meanwhile),
    //    fall back to the given path.
    let canonical = std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned());
    let preview_data_url = build_preview(&decoded).map_err(AppError::unexpected)?;

    Ok(ImportedImage {
        id: canonical,
        name,
        format,
        width,
        height,
        size_bytes: meta.len(),
        preview_data_url,
    })
}

/// Import a single file with production limits.
pub fn import_one(path: &Path) -> AppResult<ImportedImage> {
    import_one_with_limits(path, MAX_PIXELS, MAX_FILE_BYTES)
}

/// Shrink to a thumbnail and encode as a data URL. Opaque images go to
/// JPEG (small); anything with alpha goes to PNG so the UI can render a
/// transparency checkerboard underneath. Encoding a decoded in-memory
/// image essentially cannot fail; the Result keeps the service panic-free
/// regardless.
fn build_preview(img: &DynamicImage) -> Result<String, image::ImageError> {
    let thumb = img.thumbnail(PREVIEW_EDGE, PREVIEW_EDGE);
    let (mime, data): (&str, Vec<u8>) = if img.color().has_alpha() {
        let mut out = Cursor::new(Vec::new());
        thumb.write_to(&mut out, ImageFormat::Png)?;
        ("image/png", out.into_inner())
    } else {
        // Opaque sources preview as JPEG regardless of format — smaller.
        let mut out = Cursor::new(Vec::new());
        thumb.into_rgb8().write_to(&mut out, ImageFormat::Jpeg)?;
        ("image/jpeg", out.into_inner())
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    /// Write temp bytes with a given name and return the path.
    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pixora-import-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("write temp");
        path
    }

    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let img = RgbImage::from_pixel(w, h, Rgb([10, 200, 60]));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut out, ImageFormat::Png)
            .expect("encode png");
        out.into_inner()
    }

    fn jpeg_bytes(w: u32, h: u32) -> Vec<u8> {
        let img = RgbImage::from_pixel(w, h, Rgb([200, 30, 30]));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut out, ImageFormat::Jpeg)
            .expect("encode jpeg");
        out.into_inner()
    }

    fn webp_bytes(w: u32, h: u32) -> Vec<u8> {
        let img = RgbImage::from_pixel(w, h, Rgb([30, 30, 200]));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut out, ImageFormat::WebP)
            .expect("encode webp");
        out.into_inner()
    }

    #[test]
    fn imports_valid_png() {
        let path = temp_file("photo.png", &png_bytes(120, 90));
        let img = import_one(&path).expect("import");
        assert_eq!(img.name, "photo.png");
        assert_eq!(img.format, ImageFormatLabel::Png);
        assert_eq!((img.width, img.height), (120, 90));
        assert!(img.size_bytes > 0);
        assert!(img.preview_data_url.starts_with("data:image/"));
    }

    #[test]
    fn imports_jpeg_with_jpg_alias() {
        let path = temp_file("pic.JPG", &jpeg_bytes(64, 64));
        let img = import_one(&path).expect("import");
        assert_eq!(img.format, ImageFormatLabel::Jpeg);
        // Opaque sources preview as JPEG for size.
        assert!(img.preview_data_url.starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn imports_webp() {
        let path = temp_file("shot.webp", &webp_bytes(100, 50));
        let img = import_one(&path).expect("import");
        assert_eq!(img.format, ImageFormatLabel::WebP);
    }

    #[test]
    fn rejects_unsupported_extension() {
        let path = temp_file("notes.txt", b"just text");
        let err = import_one(&path).expect_err("must fail");
        assert_eq!(err.code(), "unsupported_format");
        // The user message never contains the path.
        assert!(!err.user_message().contains("notes.txt"));
        assert!(!err.user_message().contains("temp"));
    }

    #[test]
    fn rejects_corrupt_image() {
        let path = temp_file(
            "broken.png",
            b"\x89PNG\r\n\x1a\n then garbage garbage garbage",
        );
        let err = import_one(&path).expect_err("must fail");
        assert_eq!(err.code(), "invalid_image");
    }

    #[test]
    fn rejects_non_image_disguised_as_png() {
        let path = temp_file("fake.png", b"not an image at all");
        let err = import_one(&path).expect_err("must fail");
        assert_eq!(err.code(), "invalid_image");
    }

    #[test]
    fn rejects_unsupported_image_bytes_in_supported_container() {
        // GIF header behind a .png name: an image, but not a supported one.
        let mut gif = Vec::new();
        gif.extend_from_slice(b"GIF89a");
        gif.extend_from_slice(&[0u8; 32]);
        let path = temp_file("anim.png", &gif);
        let err = import_one(&path).expect_err("must fail");
        assert_eq!(err.code(), "unsupported_format");
    }

    #[test]
    fn reports_missing_file() {
        let path = std::env::temp_dir().join(format!(
            "pixora-definitely-missing-{}.png",
            std::process::id()
        ));
        let err = import_one(&path).expect_err("must fail");
        assert_eq!(err.code(), "file_missing");
    }

    #[test]
    fn rejects_oversized_pixels_with_test_limits() {
        let path = temp_file("big.png", &png_bytes(20, 20));
        // A 10-pixel budget against a 400-pixel image.
        let err = import_one_with_limits(&path, 10, MAX_FILE_BYTES).expect_err("must fail");
        assert_eq!(err.code(), "file_too_large");
    }

    #[test]
    fn rejects_oversized_file_with_test_limits() {
        let path = temp_file("heavy.png", &png_bytes(20, 20));
        let err = import_one_with_limits(&path, MAX_PIXELS, 8).expect_err("must fail");
        assert_eq!(err.code(), "file_too_large");
    }

    #[test]
    fn batch_keeps_good_files_and_reports_bad_ones_in_order() {
        let good = temp_file("good.png", &png_bytes(30, 30));
        let bad = temp_file("bad.txt", b"nope");
        let outcomes = import_many(&[
            good.to_string_lossy().into_owned(),
            bad.to_string_lossy().into_owned(),
        ]);
        assert_eq!(outcomes.len(), 2);
        match &outcomes[0] {
            ImportOutcome::Imported { image } => assert_eq!(image.name, "good.png"),
            other => panic!("expected imported first, got {other:?}"),
        }
        match &outcomes[1] {
            ImportOutcome::Failed { name, error } => {
                assert_eq!(name, "bad.txt");
                assert_eq!(error.code, "unsupported_format");
            }
            other => panic!("expected failure second, got {other:?}"),
        }
    }

    #[test]
    fn outcome_serializes_without_internal_detail() {
        let path = temp_file("bad2.txt", b"nope");
        let outcomes = import_many(&[path.to_string_lossy().into_owned()]);
        let json = serde_json::to_string(&outcomes).expect("serialize");
        // File name is allowed; internal detail (full path) is not.
        assert!(json.contains("bad2.txt"));
        assert!(json.contains("unsupported_format"));
        let tmp = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(!json.contains(&tmp));
    }
}
