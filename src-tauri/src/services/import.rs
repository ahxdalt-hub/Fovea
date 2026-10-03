//! Image import + viewing services — the Stage 03/04 pipeline: validate,
//! measure, preview, serve.
//!
//! Everything here stays on this machine: bytes are read, decoded, and
//! re-encoded as a small local preview or a display-sized view; nothing is
//! sent anywhere. The service never panics on hostile input — every failure
//! maps to an `AppError` whose user message is safe to display.
//!
//! Formats are declared in exactly two places: the `image` crate features
//! in Cargo.toml and [`FormatHint::from_extension`]. Adding a format later
//! (Stage 05+ or TIFF) means touching those and nothing else.

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
/// Quality of re-encoded display views (the original is never recompressed).
const VIEW_JPEG_QUALITY: u8 = 90;

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
/// Returns the decoded image, its sniffed format, and the on-disk size.
/// Public because Stage 05's enhancement service re-runs the *same*
/// ladder on a previously imported path — what can be enhanced is
/// exactly what can be imported, nothing looser.
pub fn decode_validated(path: &Path) -> AppResult<(DynamicImage, u64)> {
    decode_validated_with_limits(path, MAX_PIXELS, MAX_FILE_BYTES)
        .map(|(decoded, _format, size)| (decoded, size))
}

fn decode_validated_with_limits(
    path: &Path,
    max_pixels: u64,
    max_file_bytes: u64,
) -> AppResult<(DynamicImage, ImageFormatLabel, u64)> {
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
    Ok((decoded, format, meta.len()))
}

/// Import one file with production limits. Public so the Stage 08 batch
/// queue can accept native drop/picker paths through *exactly* the same
/// validation ladder the shared collection uses — one bad file still
/// reports its own outcome and never blocks the rest.
pub fn import_one(path: &Path) -> AppResult<ImportedImage> {
    import_one_with_limits(path, MAX_PIXELS, MAX_FILE_BYTES)
}

fn import_one_with_limits(
    path: &Path,
    max_pixels: u64,
    max_file_bytes: u64,
) -> AppResult<ImportedImage> {
    let name = display_name(path);
    let (decoded, format, size_bytes) =
        decode_validated_with_limits(path, max_pixels, max_file_bytes)?;

    // Identity. Canonicalize so the same file dropped under two spellings
    // deduplicates; if that fails (deleted meanwhile), fall back to the
    // given path.
    let canonical = std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned());
    let preview_data_url = build_preview(&decoded).map_err(AppError::unexpected)?;

    // Dimensions were gated pre-decode on the header; the decoded frame
    // cannot disagree (a lying header fails decode above).
    let (width, height) = (decoded.width(), decoded.height());

    Ok(ImportedImage {
        id: canonical,
        name,
        format,
        width,
        height,
        size_bytes,
        preview_data_url,
    })
}

/// Shrink to a thumbnail and encode as a data URL. Opaque images go to
/// JPEG (small); anything with alpha goes to PNG so the UI can render a
/// transparency checkerboard underneath. Encoding a decoded in-memory
/// image essentially cannot fail; the Result keeps the service panic-free
/// regardless.
fn build_preview(img: &DynamicImage) -> Result<String, image::ImageError> {
    let thumb = img.thumbnail(PREVIEW_EDGE, PREVIEW_EDGE);
    let has_alpha = img.color().has_alpha();
    let data: Vec<u8> = if has_alpha {
        let mut out = Cursor::new(Vec::new());
        thumb.write_to(&mut out, ImageFormat::Png)?;
        out.into_inner()
    } else {
        // Opaque sources preview as JPEG regardless of format — smaller.
        let mut out = Cursor::new(Vec::new());
        thumb.into_rgb8().write_to(&mut out, ImageFormat::Jpeg)?;
        out.into_inner()
    };
    Ok(data_url(has_alpha, &data))
}

fn data_url(has_alpha: bool, data: &[u8]) -> String {
    let mime = if has_alpha { "image/png" } else { "image/jpeg" };
    let b64 = base64::engine::general_purpose::STANDARD.encode(data);
    format!("data:{mime};base64,{b64}")
}

// ── Stage 04: image viewing ──────────────────────────────────────────
//
// The viewer never needs the giant original pixels sitting in the
// webview. `load_image_view` returns a display-optimized representation
// of a previously-imported file (its canonical path id):
//
// - If the file is already at or below `max_edge` (a common case — most
//   photos and every screenshot), the *untouched original bytes* are
//   returned. Zero recompression, zero quality loss.
// - Otherwise the image is downscaled to `max_edge` with a Lanczos
//   filter and re-encoded (JPEG at high quality, PNG kept when the
//   source has alpha).
//
// The caller (a later Stage's 1:1/full-fidelity mode) can raise
// `max_edge` toward the true dimensions; passing a value ≥ the image's
// longest edge returns the original bytes.

/// Serialized `ImageView` from Rust — the display representation of one
/// file, plus its true dimensions so the UI never has to probe.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageView {
    /// True source width (px) — the view may be smaller.
    pub width: u32,
    /// True source height (px).
    pub height: u32,
    /// Longest edge actually delivered (px). Equals max(width,height)
    /// when the original was served untouched.
    pub delivered_edge: u32,
    /// True when `data_url` is the untouched original file bytes.
    pub original: bool,
    /// Self-contained data URL for the viewer.
    pub data_url: String,
}

/// The path-derived display cap: a view never exceeds this edge.
pub const VIEW_MAX_EDGE: u32 = 2600;

/// Produce the display representation of an imported file.
///
/// `path` is the canonical id from `ImportedImage` — already validated on
/// import and already known to the webview via the picker/drop payloads,
/// so this command adds no new read capability. Still, it re-checks the
/// file against the same ladder so a deleted/mutated file fails honestly.
pub fn load_image_view(path: &Path, max_edge: u32) -> AppResult<ImageView> {
    load_image_view_with_limits(path, max_edge, MAX_PIXELS, MAX_FILE_BYTES)
}

fn load_image_view_with_limits(
    path: &Path,
    max_edge: u32,
    max_pixels: u64,
    max_file_bytes: u64,
) -> AppResult<ImageView> {
    let name = display_name(path);
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::FileMissing { detail: name });
        }
        Err(err) => return Err(AppError::from(err)),
    };
    if bytes.len() as u64 > max_file_bytes {
        return Err(AppError::FileTooLarge {
            detail: format!("{name}: {} bytes on disk", bytes.len()),
        });
    }

    // Reuse the import ladder's sniff+decode: what the viewer can show is
    // exactly what import accepted, nothing looser.
    let guessed = image::guess_format(&bytes).map_err(|_| AppError::InvalidImage {
        detail: format!("{name}: no image header"),
    })?;
    if ImageFormatLabel::from_image_format(guessed).is_none() {
        return Err(AppError::UnsupportedFormat {
            detail: format!("{name}: sniffed {guessed:?}"),
        });
    }
    // Stage 12: the decompression-bomb gate the import ladder applies
    // applies here too. The command accepts any path the webview passes,
    // and a tiny flat-color PNG can declare enormous dimensions — header
    // check first, so the pixel budget is enforced before the decoder
    // allocates, never after.
    let header = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| AppError::InvalidImage {
            detail: format!("{name}: unreadable header"),
        })?;
    let (width, height) = header
        .into_dimensions()
        .map_err(|_| AppError::InvalidImage {
            detail: format!("{name}: bad dimensions"),
        })?;
    if width == 0 || height == 0 {
        return Err(AppError::InvalidImage {
            detail: format!("{name}: zero-sized"),
        });
    }
    let pixels = u64::from(width) * u64::from(height);
    if pixels > max_pixels {
        return Err(AppError::FileTooLarge {
            detail: format!("{name}: {pixels} pixels"),
        });
    }
    let decoded = image::load_from_memory_with_format(&bytes, guessed).map_err(|_| {
        AppError::InvalidImage {
            detail: format!("{name}: decode failed"),
        }
    })?;
    let (width, height) = (decoded.width(), decoded.height());
    let longest = width.max(height);

    // Small enough (or the caller asked for everything): hand back the
    // pristine file bytes. This is the honest path for most imports.
    if longest <= max_edge {
        return Ok(ImageView {
            width,
            height,
            delivered_edge: longest,
            original: true,
            data_url: raw_data_url(&bytes, guessed),
        });
    }

    let view = decoded.thumbnail(max_edge, max_edge);
    let delivered_edge = view.width().max(view.height());
    let has_alpha = view.color().has_alpha();
    let data: Vec<u8> = if has_alpha {
        let mut out = Cursor::new(Vec::new());
        view.write_to(&mut out, ImageFormat::Png)
            .map_err(|e| AppError::unexpected(format!("view encode png: {e}")))?;
        out.into_inner()
    } else {
        let mut out = Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, VIEW_JPEG_QUALITY)
            .encode_image(&view.into_rgb8())
            .map_err(|e| AppError::unexpected(format!("view encode jpeg: {e}")))?;
        out.into_inner()
    };
    Ok(ImageView {
        width,
        height,
        delivered_edge,
        original: false,
        data_url: data_url(has_alpha, &data),
    })
}

/// Wrap already-encoded file bytes in a data URL without re-encoding.
fn raw_data_url(bytes: &[u8], format: ImageFormat) -> String {
    let mime = match format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png => "image/png",
        ImageFormat::WebP => "image/webp",
        other => {
            debug_assert!(false, "raw_data_url called with unsupported {other:?}");
            "application/octet-stream"
        }
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{b64}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

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

    // ── Stage 04: load_image_view ────────────────────────────────────

    #[test]
    fn view_serves_small_files_untouched() {
        let bytes = png_bytes(1200, 800);
        let path = temp_file("small.png", &bytes);
        let view = load_image_view(&path, VIEW_MAX_EDGE).expect("view");
        assert_eq!((view.width, view.height), (1200, 800));
        assert!(view.original);
        assert_eq!(view.delivered_edge, 1200);
        // Untouched means byte-identical: the base64 of the original file.
        let expected = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        );
        assert_eq!(view.data_url, expected);
    }

    #[test]
    fn view_downsamples_large_files() {
        let path = temp_file("huge.png", &png_bytes(5000, 3000));
        let view = load_image_view(&path, 1600).expect("view");
        assert_eq!((view.width, view.height), (5000, 3000), "true size kept");
        assert!(!view.original);
        assert_eq!(view.delivered_edge, 1600);
        assert!(view.data_url.starts_with("data:image/jpeg;base64,")); // opaque → JPEG
    }

    #[test]
    fn view_preserves_alpha_as_png() {
        let mut rgba = RgbaImage::new(3000, 2000);
        for (x, y, px) in rgba.enumerate_pixels_mut() {
            *px = Rgba([
                (x % 255) as u8,
                (y % 255) as u8,
                128,
                if x > y { 255 } else { 10 },
            ]);
        }
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(rgba)
            .write_to(&mut out, ImageFormat::Png)
            .expect("encode");
        let path = temp_file("alpha.png", &out.into_inner());
        let view = load_image_view(&path, 1000).expect("view");
        assert!(!view.original);
        assert!(
            view.data_url.starts_with("data:image/png;base64,"),
            "alpha sources stay PNG"
        );
    }

    #[test]
    fn view_reports_missing_file() {
        let path =
            std::env::temp_dir().join(format!("pixora-view-missing-{}.png", std::process::id()));
        let err = load_image_view(&path, VIEW_MAX_EDGE).expect_err("must fail");
        assert_eq!(err.code(), "file_missing");
    }

    #[test]
    fn view_rejects_non_image_bytes() {
        let path = temp_file("junk.png", b"definitely not an image");
        let err = load_image_view(&path, VIEW_MAX_EDGE).expect_err("must fail");
        assert_eq!(err.code(), "invalid_image");
    }

    #[test]
    fn view_respects_a_full_size_request() {
        let path = temp_file("full.png", &png_bytes(2500, 1200));
        // A later 1:1 mode raises the cap to the true longest edge.
        let view = load_image_view(&path, 2500).expect("view");
        assert!(view.original);
        assert_eq!(view.delivered_edge, 2500);
    }

    #[test]
    fn view_rejects_oversized_pixels_with_test_limits() {
        // 5000×3000 = 15 MP against a 10 MP budget: the header gate fires
        // before the decoder allocates, exactly like the import ladder.
        let path = temp_file("viewbig.png", &png_bytes(5000, 3000));
        let err = load_image_view_with_limits(&path, VIEW_MAX_EDGE, 10_000_000, MAX_FILE_BYTES)
            .expect_err("must fail");
        assert_eq!(err.code(), "file_too_large");
    }

    /// CRC-32 (IEEE/zlib, the PNG chunk checksum).
    fn crc32(data: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFF_FFFF;
        for &b in data {
            crc ^= u32::from(b);
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    /// A ~70-byte PNG that *declares* 40000×40000 (1.6 gigapixels): the
    /// classic decompression bomb. Only the header is real — decoding it
    /// blind would allocate GBs. (Chunk CRCs cover type + data; a dummy
    /// IDAT is required for the header reader to finish parsing.)
    fn bomb_png() -> Vec<u8> {
        let mut png = Vec::new();
        png.extend_from_slice(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']);
        push_chunk(&mut png, b"IHDR", &bomb_ihdr_data());
        push_chunk(&mut png, b"IDAT", &[0u8; 4]); // placeholder stream data
        push_chunk(&mut png, b"IEND", &[]);
        png
    }

    /// IHDR payload: 40000×40000, 8-bit RGB, no interlace.
    fn bomb_ihdr_data() -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&40_000u32.to_be_bytes());
        data.extend_from_slice(&40_000u32.to_be_bytes());
        data.extend_from_slice(&[8, 2, 0, 0, 0]);
        data
    }

    /// Append one PNG chunk: length, type, data, CRC(type+data).
    fn push_chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        png.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut crc_input = kind.to_vec();
        crc_input.extend_from_slice(data);
        png.extend_from_slice(&crc_input);
        png.extend_from_slice(&crc32(&crc_input).to_be_bytes());
    }

    #[test]
    fn view_rejects_a_decompression_bomb_header() {
        let bomb = bomb_png();
        assert!(bomb.len() < 100, "fixture is tiny by construction");
        let path = temp_file("bomb.png", &bomb);
        let err = load_image_view(&path, VIEW_MAX_EDGE).expect_err("bomb must be refused");
        assert_eq!(err.code(), "file_too_large");
    }
}
