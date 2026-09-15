//! Generates Stage 03 manual-QA fixtures: valid JPG/PNG/WebP, an
//! unsupported file, a corrupt image, and an oversized image.
//!
//! Run with:
//!   cargo run --manifest-path src-tauri/Cargo.toml --example import_fixtures

use std::io::Cursor;
use std::path::Path;

use image::{DynamicImage, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};

fn save(img: &DynamicImage, path: &Path, fmt: ImageFormat) {
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, fmt).expect("encode");
    std::fs::write(path, out.into_inner()).expect("write");
    println!("{}", path.display());
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("pixora-fixtures"));
    std::fs::create_dir_all(&dir).expect("fixtures dir");

    // A soft vertical gradient so previews/thumbnails look like a photo.
    let mut rgb = RgbImage::new(900, 600);
    for (x, y, pixel) in rgb.enumerate_pixels_mut() {
        let t = x as f32 / 900.0;
        *pixel = Rgb([(120.0 - 80.0 * t) as u8, (60.0 + 140.0 * t) as u8, 190u8]);
        if (x / 40 + y / 40) % 7 == 0 {
            *pixel = Rgb([250, 245, 235]);
        }
    }
    let gradient = DynamicImage::ImageRgb8(rgb);
    save(&gradient, &dir.join("sunset.jpg"), ImageFormat::Jpeg);
    save(&gradient, &dir.join("photo.png"), ImageFormat::Png);

    let mut rgba = RgbaImage::new(400, 400);
    for (x, y, pixel) in rgba.enumerate_pixels_mut() {
        let a = if (x + y) % 200 < 100 { 255 } else { 40 };
        *pixel = Rgba([90, 160, 240, a]);
    }
    save(
        &DynamicImage::ImageRgba8(rgba),
        &dir.join("sticker.webp"),
        ImageFormat::WebP,
    );

    std::fs::write(dir.join("notes.txt"), b"just a text file").expect("write");
    std::fs::write(
        dir.join("corrupt.png"),
        b"\x89PNG\r\n\x1a\n rest of this file is not a PNG",
    )
    .expect("write");

    // 8100 x 8100 = 65.6 MP > the 64 MP import cap (small file on disk:
    // uniform color compresses well; the gate is checked before decode).
    let big = DynamicImage::ImageRgb8(RgbImage::from_pixel(8100, 8100, Rgb([10, 10, 10])));
    save(&big, &dir.join("huge.png"), ImageFormat::Png);

    println!("fixtures ready in {}", dir.display());
}
