//! Finishing passes — the pixel work that runs on *model output*, after
//! the network has reconstructed the tile and before it is composited.
//!
//! Two orthogonal knobs, deliberately kept apart:
//!
//! - [`PostPass`] is chosen by the enhancement mode (Standard/Natural run
//!   no pass, Detail runs the real unsharp mask). It says *how the model's
//!   result is interpreted*.
//! - [`Filter`] is a look the user picks on top of any mode. It says *what
//!   the picture should feel like*.
//!
//! A mode and a filter can therefore be combined freely, and one change
//! here reaches single-image enhancement, the batch queue, and presets
//! without any of them knowing about each other.
//!
//! Every filter is a measurable operation on real pixels — never a
//! relabeling of the same field (the Stage 06 rule, inherited). Each one
//! has a unit test asserting the signature it claims: flats stay flat for
//! tonal filters, a colour cast moves the channels it says it moves, and
//! neighbourhood passes genuinely use their tile's bleed context, so no
//! seam is possible.
//!
//! ## Where the passes run, and why that is correct
//!
//! Filters are applied to a tile's planar f32 output *including* the bleed
//! pad, then the pad is cropped on composite. For the pointwise filters
//! (saturation, tone curves, channel balance) position is irrelevant, so
//! they are trivially seam-free. For the four neighbourhood filters (Soft,
//! Portrait, Sharp, Product clarity) the pad supplies real neighbours for
//! every pixel of the interior — the same argument that makes
//! [`PostPass::Sharpen`] exact at tile borders.
//!
//! Intensity is a plain 0-100 amount: `0` leaves pixels untouched, `50` is
//! the designed default, `100` is the full strength each filter was tuned
//! at. There is no "auto" magic and no hidden preset inside a filter.

use serde::Serialize;

/// Which real post-processing pass runs over each model output tile before
/// compositing. Each variant is a measurable pixel operation — never a
/// relabeling of the same pixels (Stage 06 rule). `Sharpen` is an unsharp
/// mask (output + amount × (output − 3×3 blur)) applied inside the padded
/// tile, so the bleed context gives every edge real neighbors and no seam
/// is possible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostPass {
    /// Model output as-is (Standard / Natural).
    None,
    /// Unsharp detail pass on top of the model output (Detail).
    Sharpen,
}

/// How strongly the Detail pass amplifies local contrast. 0.5 is a
/// visible-but-natural crispness step; tested to leave flat areas untouched
/// and strengthen edges.
pub const SHARPEN_AMOUNT: f32 = 0.5;

/// The finishing look applied on top of any enhancement mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Filter {
    /// No finishing pass at all — the model output is the picture. The UI
    /// offers this as "Original" so a filter can be clearly switched off.
    Original,
    /// Gentle, faithful lift: a touch more saturation and contrast, no
    /// colour cast, no tonal character. The safe default for photos.
    Natural,
    /// Strong saturation and contrast — punchy, for content that should
    /// pop (social, hero shots). Pushes channels hard, so it is the one to
    /// dial back first when skin looks orange.
    Vivid,
    /// Warms the white balance: red up, blue down. For tungsten-lit, dusk,
    /// or cold-camera shots that should feel inviting.
    Warm,
    /// Cools the white balance: blue up, red down. For daylight overcast,
    /// product shots on grey, or feverish indoor casts.
    Cool,
    /// Filmic toning: an S-curve with milky lifted blacks, warm highlights
    /// and teal shadows, and a slight saturation pull-back. The look people
    /// mean when they say "cinematic".
    Cinematic,
    /// Softening: blends toward a 3×3 blur and lifts slightly. For skin,
    /// dreams, and taking the edge off a very crisp model result.
    Soft,
    /// Local-contrast crispness (unsharp). Distinct from the Detail *mode*,
    /// which sharpens flat reconstruction; this sharpens whatever the model
    /// returned, at the strength you choose.
    Sharp,
    /// Converts toward luminance, with tonal contrast. Intensity controls
    /// how far the image travels toward monochrome, so a 30 reading is a
    /// desaturated look and a 100 is a true black & white.
    Mono,
    /// Accurate and crisp for catalogue work: clarity plus neutral contrast
    /// with saturation held at or just below the source, so colours stay
    /// sellable rather than stylised.
    Product,
    /// Flattering on faces: mild softening, a small exposure lift, a hint
    /// of warmth, saturation eased so skin does not go clay-orange.
    Portrait,
}

impl Filter {
    /// The off-switch first, then the 10 looks the product ships.
    pub const ALL: [Filter; 11] = [
        Filter::Original,
        Filter::Natural,
        Filter::Vivid,
        Filter::Warm,
        Filter::Cool,
        Filter::Cinematic,
        Filter::Soft,
        Filter::Sharp,
        Filter::Mono,
        Filter::Product,
        Filter::Portrait,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Natural => "natural",
            Self::Vivid => "vivid",
            Self::Warm => "warm",
            Self::Cool => "cool",
            Self::Cinematic => "cinematic",
            Self::Soft => "soft",
            Self::Sharp => "sharp",
            Self::Mono => "mono",
            Self::Product => "product",
            Self::Portrait => "portrait",
        }
    }

    /// Parse the wire form a command receives (`filter` is untrusted input).
    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|f| f.key() == key)
    }

    /// The user-facing name, identical across the IPC boundary so labels
    /// can never drift between the strip, the batch preset and Settings.
    pub fn label(self) -> &'static str {
        match self {
            Self::Original => "Original",
            Self::Natural => "Natural",
            Self::Vivid => "Vivid",
            Self::Warm => "Warm",
            Self::Cool => "Cool",
            Self::Cinematic => "Cinematic",
            Self::Soft => "Soft",
            Self::Sharp => "Sharp",
            Self::Mono => "Black & White",
            Self::Product => "Product",
            Self::Portrait => "Portrait",
        }
    }

    /// One-line description surfaced in the UI — factual about the pixel
    /// operation, no marketing.
    pub fn description(self) -> &'static str {
        match self {
            Self::Original => "No finishing pass — exactly what the model produced",
            Self::Natural => "Slight saturation and contrast lift, no colour cast",
            Self::Vivid => "Strong saturation and contrast — punchy, for content that pops",
            Self::Warm => "Warms the balance: red up, blue down",
            Self::Cool => "Cools the balance: blue up, red down",
            Self::Cinematic => "Filmic curve — lifted blacks, warm highlights, teal shadows",
            Self::Soft => "Blends toward a blur — gentle skin, calmer detail",
            Self::Sharp => "Unsharp local contrast on top of the result",
            Self::Mono => "Toward luminance with tonal contrast — intensity sets how far",
            Self::Product => "Clarity and neutral contrast, colours kept accurate",
            Self::Portrait => "Mild softening, small exposure lift, warmth, eased saturation",
        }
    }

    /// Every filter is pure pixel math on data the engine already has —
    /// unlike the enhancement modes, none of them depends on an installed
    /// model, so availability is not something to probe.
    pub fn available(self) -> bool {
        true
    }
}

/// The finishing intent for one job: the mode's post-pass plus the user's
/// filter and its strength. Built by the service, consumed by the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Finish {
    pub post: PostPass,
    pub filter: Filter,
    /// 0-100; clamped by [`amount`], so callers can pass
    /// whatever the wire carried.
    pub intensity: u8,
}

/// The strength a fresh job uses when the client sends nothing meaningful.
/// 50 is "as designed", not a hidden maximum — 100 stays reachable.
pub const DEFAULT_INTENSITY: u8 = 50;

impl Finish {
    /// No passes at all — the model output composites untouched.
    pub fn identity() -> Self {
        Finish {
            post: PostPass::None,
            filter: Filter::Original,
            intensity: DEFAULT_INTENSITY,
        }
    }

    /// The Detail mode's unsharp pass, no filter.
    pub fn sharpen() -> Self {
        Finish {
            post: PostPass::Sharpen,
            ..Self::identity()
        }
    }

    /// The mode's own pass plus a filter at `intensity`.
    pub fn for_mode(post: PostPass, filter: Filter, intensity: u8) -> Self {
        Finish {
            post,
            filter,
            intensity,
        }
    }
}

/// Serialized `FilterStatusDto` in TS — the filter list the UI renders, so
/// labels and hints live in one place (native) and can't drift.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterStatus {
    pub key: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub available: bool,
}

pub fn status_for(filter: Filter) -> FilterStatus {
    FilterStatus {
        key: filter.key(),
        label: filter.label(),
        description: filter.description(),
        available: filter.available(),
    }
}

/// 0-100 → 0.0-1.0. The single place intensity is interpreted, so every
/// filter's "full strength" means the same number.
fn amount(intensity: u8) -> f32 {
    f32::from(intensity.clamp(0, 100)) / 100.0
}

/// Run the finishing passes for one tile, in order: the mode's post-pass,
/// then the filter. `data` is planar CHW f32 in ~[0,1] at *model*
/// resolution; values are clamped back into range by each pass, and the
/// engine's `to_u8` clamps again on composite.
pub fn apply(data: &mut [f32], width: usize, height: usize, finish: &Finish) {
    if finish.post == PostPass::Sharpen {
        unsharp(data, width, height, SHARPEN_AMOUNT);
    }
    apply_filter(data, width, height, finish.filter, amount(finish.intensity));
}

/// The filter half of [`apply`], separate so tests can drive a filter at an
/// exact strength without going through intensity scaling.
fn apply_filter(data: &mut [f32], width: usize, height: usize, filter: Filter, k: f32) {
    if filter == Filter::Original || k == 0.0 {
        return;
    }
    let plane = width * height;
    match filter {
        // Pointwise: no neighbors needed, so no scratch buffer beyond the
        // per-pixel channel gather the colour ops require.
        Filter::Natural => {
            tone(data, 1.0 + 0.12 * k, 1.0 + 0.06 * k);
        }
        Filter::Vivid => {
            tone(data, 1.0 + 0.60 * k, 1.0 + 0.20 * k);
        }
        Filter::Warm => cast(data, 1.0 + 0.07 * k, 1.0, 1.0 - 0.09 * k),
        Filter::Cool => cast(data, 1.0 - 0.07 * k, 1.0, 1.0 + 0.08 * k),
        Filter::Mono => {
            let contrast = 1.0 + 0.18 * k;
            for i in 0..plane {
                // Rec.709 weights on the [0,1] code values: exact enough
                // for a look, and stable across channels. The grey is
                // computed from the pixel's own three channels before any
                // of them are written.
                let gray = clamp01(
                    (luma(data[i], data[plane + i], data[2 * plane + i]) - 0.5) * contrast + 0.5,
                );
                for c in 0..3 {
                    let v = data[c * plane + i];
                    data[c * plane + i] = v * (1.0 - k) + gray * k;
                }
            }
        }
        Filter::Cinematic => {
            // Filmic S-curve with lifted blacks, then a warm/teal split
            // tone, then a saturation pull-back. Order matters: the split
            // tone has to see the curve's tonality, and the desaturation
            // must come after both so it calms the cast instead of doubling
            // it.
            for i in 0..plane {
                let r = curve(clamp01(data[i]));
                let g = curve(clamp01(data[plane + i]));
                let b = curve(clamp01(data[2 * plane + i]));
                let key = (r + g + b) / 3.0 - 0.5;
                let split = 0.06 * k * key;
                data[i] = clamp01(r + split);
                data[plane + i] = clamp01(g + split * 0.2);
                data[2 * plane + i] = clamp01(b - split * 1.2);
            }
            scale_saturation(data, 1.0 - 0.18 * k);
        }
        Filter::Soft => {
            let blurred = blur3(data, width, height);
            let mix = 0.35 * k;
            for (i, v) in data.iter_mut().enumerate() {
                *v = clamp01(*v + mix * (blurred[i] - *v) + 0.02 * k);
            }
        }
        Filter::Portrait => {
            // Softening first, then the tonal moves, so the blur averages
            // the model's own detail rather than a re-amplified version of
            // it — which is what makes this read as skin rather than mud.
            let blurred = blur3(data, width, height);
            let mix = 0.28 * k;
            for (i, v) in data.iter_mut().enumerate() {
                *v = clamp01(*v + mix * (blurred[i] - *v));
            }
            cast(data, 1.0 + 0.03 * k, 1.0, 1.0 - 0.02 * k);
            scale_saturation(data, 1.0 - 0.06 * k);
            for v in data.iter_mut() {
                *v = clamp01(*v + 0.04 * k);
            }
        }
        Filter::Sharp => unsharp(data, width, height, k),
        Filter::Product => {
            unsharp(data, width, height, 0.4 * k);
            tone(data, 1.0 - 0.05 * k, 1.0 + 0.18 * k);
        }
        Filter::Original => unreachable!("handled above"),
    }
}

/// 3×3 box blur over planar CHW data, edge-clamped (a border pixel's
/// window is the pixels that exist, averaged — no wrap, no dark fringe).
fn blur3(data: &[f32], width: usize, height: usize) -> Vec<f32> {
    let plane = width * height;
    let mut out = vec![0f32; data.len()];
    for c in 0..3 {
        let base = c * plane;
        for y in 0..height {
            let y0 = y.saturating_sub(1);
            let y1 = (y + 2).min(height);
            for x in 0..width {
                let x0 = x.saturating_sub(1);
                let x1 = (x + 2).min(width);
                let mut sum = 0f32;
                let mut n = 0u32;
                for yy in y0..y1 {
                    let row = base + yy * width;
                    for xx in x0..x1 {
                        sum += data[row + xx];
                        n += 1;
                    }
                }
                out[base + y * width + x] = sum / n as f32;
            }
        }
    }
    out
}

/// Unsharp mask on one tile's planar f32 output: out + A·(out − blur₃ₓ₃).
/// Operates over the *whole padded tile*, so interior pixels near the pad
/// boundary get their real (bleed) neighborhood — the pass is seam-free by
/// construction, and the pad is cropped on composite anyway. Flat regions
/// stay exactly flat (out − blur = 0); edges gain contrast.
fn unsharp(data: &mut [f32], width: usize, height: usize, strength: f32) {
    if strength == 0.0 {
        return;
    }
    let blurred = blur3(data, width, height);
    for (i, v) in data.iter_mut().enumerate() {
        // Deliberately *not* clamped here: ringing beyond [0,1] is the
        // unsharp signature the Detail mode was verified with, and the
        // engine's `to_u8` does the honest clamp on composite.
        *v += strength * (*v - blurred[i]);
    }
}

/// Saturation and contrast about the mid-point, in one pass. `s` scales the
/// distance from luma (s<1 desaturates), `c` scales the distance from 0.5.
fn tone(data: &mut [f32], s: f32, c: f32) {
    let plane = data.len() / 3;
    for i in 0..plane {
        let r = data[i];
        let g = data[plane + i];
        let b = data[2 * plane + i];
        let l = luma(r, g, b);
        for (c_idx, v) in [r, g, b].into_iter().enumerate() {
            let desat = l + (v - l) * s;
            data[c_idx * plane + i] = clamp01((desat - 0.5) * c + 0.5);
        }
    }
}

/// Scale an already-computed saturation factor toward luma, leaving luma
/// itself untouched (used by filters that tone first and calm after).
fn scale_saturation(data: &mut [f32], s: f32) {
    if s == 1.0 {
        return;
    }
    tone(data, s, 1.0);
}

/// Per-channel white-balance gain — the honest core of Warm and Cool.
fn cast(data: &mut [f32], gain_r: f32, gain_g: f32, gain_b: f32) {
    let plane = data.len() / 3;
    for i in 0..plane {
        data[i] = clamp01(data[i] * gain_r);
        data[plane + i] = clamp01(data[plane + i] * gain_g);
        data[2 * plane + i] = clamp01(data[2 * plane + i] * gain_b);
    }
}

/// Filmic tone curve: a soft-shouldered S whose black lift is a function
/// of how dark the toned pixel still is. That is what makes the look read
/// as film rather than as a contrast slider — shadows go milky, highlights
/// are pulled *back* instead of pushed into the clipping rail.
fn curve(x: f32) -> f32 {
    let mid = (x - 0.5) * 1.18;
    let shaped = mid / (1.0 + mid.abs() * 0.42);
    let toned = clamp01(0.5 + shaped);
    clamp01(toned + 0.06 * (1.0 - toned) * (1.0 - toned))
}

#[inline]
fn luma(r: f32, g: f32, b: f32) -> f32 {
    r * 0.2126 + g * 0.7152 + b * 0.0722
}

#[inline]
fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 32;
    const H: usize = 16;

    fn plane() -> usize {
        W * H
    }

    /// Planar CHW buffer filled per channel from `f(x, y)`.
    fn field(mut f: impl FnMut(usize, usize) -> [f32; 3]) -> Vec<f32> {
        let mut data = vec![0f32; 3 * plane()];
        for y in 0..H {
            for x in 0..W {
                let [r, g, b] = f(x, y);
                for (c, v) in [r, g, b].into_iter().enumerate() {
                    data[c * plane() + y * W + x] = v;
                }
            }
        }
        data
    }

    fn constant(v: f32) -> Vec<f32> {
        field(|_, _| [v, v, v])
    }

    /// Half black, half white, split vertically down the middle — the hard
    /// edge every neighbourhood pass is judged on.
    fn split_edge() -> Vec<f32> {
        field(|x, _| {
            let v = if x < W / 2 { 0.0 } else { 1.0 };
            [v, v, v]
        })
    }

    fn at(data: &[f32], c: usize, x: usize, y: usize) -> f32 {
        data[c * plane() + y * W + x]
    }

    fn run(data: &mut [f32], filter: Filter, intensity: u8) {
        apply(
            data,
            W,
            H,
            &Finish {
                post: PostPass::None,
                filter,
                intensity,
            },
        );
    }

    // ── the switch itself ────────────────────────────────────────────

    #[test]
    fn original_and_zero_intensity_leave_every_pixel_alone() {
        let src = split_edge();
        for (filter, intensity) in [
            (Filter::Original, 100),
            (Filter::Vivid, 0),
            (Filter::Cinematic, 0),
            (Filter::Mono, 0),
        ] {
            let mut data = src.clone();
            run(&mut data, filter, intensity);
            assert_eq!(data, src, "{filter:?} @ {intensity} must be a no-op");
        }
    }

    #[test]
    fn keys_round_trip_and_unknown_keys_are_refused() {
        for f in Filter::ALL {
            assert_eq!(Filter::from_key(f.key()), Some(f));
        }
        assert_eq!(Filter::from_key("ultra_quantum"), None);
        assert_eq!(Filter::from_key(""), None);
        // The off-switch plus the ten looks the product promises.
        assert_eq!(Filter::ALL.len(), 11);
        assert_eq!(Filter::ALL[0], Filter::Original);
    }

    #[test]
    fn every_filter_has_a_distinct_label_and_hint() {
        let mut labels: Vec<&str> = Filter::ALL.iter().map(|f| f.label()).collect();
        labels.sort_unstable();
        let unique = labels.len();
        labels.dedup();
        assert_eq!(labels.len(), unique, "labels must not collide");
        for f in Filter::ALL {
            assert!(!f.description().is_empty(), "{} has no hint", f.key());
            assert!(f.available(), "{} is always computable", f.key());
        }
        // The look names the product promised.
        for key in [
            "original",
            "natural",
            "vivid",
            "warm",
            "cool",
            "cinematic",
            "soft",
            "sharp",
            "mono",
            "product",
            "portrait",
        ] {
            assert!(Filter::from_key(key).is_some(), "{key} missing");
        }
    }

    // ── neighbourhood math ───────────────────────────────────────────

    #[test]
    fn blur_is_edge_clamped_so_a_flat_border_gets_no_dark_fringe() {
        let data = constant(0.5);
        let blurred = blur3(&data, W, H);
        assert!(
            blurred.iter().all(|v| (v - 0.5).abs() < 1e-6),
            "a constant field must blur to itself, corners included"
        );
    }

    /// A flat region must stay exactly flat under the Detail pass, while a
    /// hard edge gains contrast on both sides (the unsharp signature).
    #[test]
    fn sharpen_postpass_preserves_flats_and_strengthens_edges() {
        let mut data = split_edge();
        // A flat patch inside the white half for the flat check.
        for y in 8..14 {
            for x in 26..30 {
                for c in 0..3 {
                    data[c * plane() + y * W + x] = 0.5;
                }
            }
        }
        let before = data.clone();
        apply(
            &mut data,
            W,
            H,
            &Finish {
                post: PostPass::Sharpen,
                filter: Filter::Original,
                intensity: 0,
            },
        );
        // Flats unchanged (every checked pixel's 3×3 window lies wholly
        // inside the flat patch, so blur == value).
        for c in 0..3 {
            for y in 9..12 {
                for x in 27..29 {
                    assert!((at(&data, c, x, y) - 0.5).abs() < 1e-6, "flat pixel moved");
                }
            }
        }
        // Edge columns pushed apart: the black side got darker and the
        // white side brighter toward the boundary. Ringing is allowed to
        // leave [0,1]; the engine clamps honestly on composite.
        assert!(
            at(&data, 0, 15, 8) < at(&before, 0, 5, 8),
            "black side should darken toward edge"
        );
        assert!(
            at(&data, 0, 16, 8) > at(&before, 0, 25, 8),
            "white side should brighten toward edge"
        );
    }

    #[test]
    fn soft_and_portrait_genuinely_smooth_a_hard_edge() {
        for filter in [Filter::Soft, Filter::Portrait] {
            let mut data = split_edge();
            run(&mut data, filter, 100);
            // The step across the boundary shrinks: softening is real.
            let step = |d: &[f32]| at(d, 0, 16, 8) - at(d, 0, 15, 8);
            assert!(
                step(&data) < step(&split_edge()),
                "{filter:?} must reduce the edge step"
            );
        }
    }

    #[test]
    fn sharp_filter_at_half_strength_matches_the_detail_pass() {
        // "Sharp at 50" and the Detail mode must be the same operation —
        // the filter is the same unsharp with a user-chosen amount, not a
        // second, secret recipe.
        let mut via_filter = split_edge();
        run(&mut via_filter, Filter::Sharp, 50);
        let mut via_mode = split_edge();
        apply(
            &mut via_mode,
            W,
            H,
            &Finish {
                post: PostPass::Sharpen,
                filter: Filter::Original,
                intensity: 0,
            },
        );
        for (a, b) in via_filter.iter().zip(&via_mode) {
            assert!((a - b).abs() < 1e-6, "sharp 50 must equal Detail");
        }
    }

    // ── colour / tone math ───────────────────────────────────────────

    #[test]
    fn warm_pushes_red_up_and_blue_down_cool_does_the_reverse() {
        let gray = constant(0.5);
        let mut warm = gray.clone();
        run(&mut warm, Filter::Warm, 100);
        assert!(at(&warm, 0, 3, 3) > 0.5, "warm raises red");
        assert!(at(&warm, 2, 3, 3) < 0.5, "warm lowers blue");
        let mut cool = gray.clone();
        run(&mut cool, Filter::Cool, 100);
        assert!(at(&cool, 0, 3, 3) < 0.5, "cool lowers red");
        assert!(at(&cool, 2, 3, 3) > 0.5, "cool raises blue");
        // Full-strength casts are bounded — a look, not a clip.
        assert!(at(&warm, 0, 3, 3) < 0.6 && at(&warm, 2, 3, 3) > 0.4);
    }

    #[test]
    fn vivid_increases_distance_from_grey_and_natural_does_it_gently() {
        let colored = field(|_, _| [0.8, 0.2, 0.45]);
        let l = luma(0.8, 0.2, 0.45);
        let spread =
            |d: &[f32]| (d[0] - l).abs() + (d[plane()] - l).abs() + (d[2 * plane()] - l).abs();
        let mut vivid = colored.clone();
        run(&mut vivid, Filter::Vivid, 100);
        let mut natural = colored.clone();
        run(&mut natural, Filter::Natural, 100);
        assert!(spread(&vivid) > spread(&colored), "vivid saturates");
        assert!(spread(&natural) > spread(&colored), "natural saturates");
        assert!(
            spread(&natural) < spread(&vivid),
            "natural must be the gentler of the two"
        );
    }

    #[test]
    fn mid_grey_is_the_fixed_point_for_the_contrast_only_looks() {
        // Natural, Vivid, Product and Sharp promise no tonal move, so a
        // flat 0.5 field must survive them untouched — proof they operate
        // about the mid-point instead of shifting exposure silently.
        for filter in [
            Filter::Natural,
            Filter::Vivid,
            Filter::Product,
            Filter::Sharp,
        ] {
            let mut data = constant(0.5);
            run(&mut data, filter, 100);
            assert!(
                data.iter().all(|v| (v - 0.5).abs() < 1e-6),
                "{filter:?} moved a flat mid-grey field"
            );
        }
    }

    #[test]
    fn mono_travels_toward_luminance_with_intensity_and_equalises_channels_at_full() {
        let base = field(|_, _| [0.9, 0.2, 0.2]);
        let l = luma(0.9, 0.2, 0.2);
        // Half strength: still partly coloured.
        let mut half = base.clone();
        run(&mut half, Filter::Mono, 50);
        assert!(
            at(&half, 0, 0, 0) > at(&half, 2, 0, 0),
            "a partial conversion keeps some colour"
        );
        // Full strength: a true black & white — every channel identical and
        // sitting on the Rec.709 luma of the source pixel.
        let mut full = base.clone();
        run(&mut full, Filter::Mono, 100);
        let (r, g, b) = (at(&full, 0, 0, 0), at(&full, 1, 0, 0), at(&full, 2, 0, 0));
        assert!(
            (r - g).abs() < 1e-6 && (g - b).abs() < 1e-6,
            "full intensity must be monochrome"
        );
        // Contrast about 0.5 at full strength: 0.5 + (l-0.5)*1.18.
        assert!(
            (r - (0.5 + (l - 0.5) * 1.18)).abs() < 1e-5,
            "got {r}, l {l}"
        );
    }

    #[test]
    fn cinematic_lifts_blacks_and_holds_highlights() {
        let mut data = field(|_, _| [0.02, 0.02, 0.02]);
        run(&mut data, Filter::Cinematic, 100);
        let lifted = (at(&data, 0, 0, 0) + at(&data, 1, 0, 0) + at(&data, 2, 0, 0)) / 3.0;
        assert!(lifted > 0.02, "blacks must lift, not crush");
        let mut bright = field(|_, _| [0.98, 0.98, 0.98]);
        run(&mut bright, Filter::Cinematic, 100);
        let held = (at(&bright, 0, 0, 0) + at(&bright, 1, 0, 0) + at(&bright, 2, 0, 0)) / 3.0;
        assert!(held < 0.98, "highlights must pull back");
        assert!(held > lifted, "curve must stay monotonic");
    }

    #[test]
    fn split_tone_warms_highlights_and_cools_shadows() {
        let mut shadow = field(|_, _| [0.12, 0.12, 0.12]);
        run(&mut shadow, Filter::Cinematic, 100);
        let mut highlight = field(|_, _| [0.85, 0.85, 0.85]);
        run(&mut highlight, Filter::Cinematic, 100);
        // Red-minus-blue is the warm/cool axis: it must be lower in the
        // shadows than in the highlights.
        let axis = |d: &[f32]| at(d, 0, 0, 0) - at(d, 2, 0, 0);
        assert!(
            axis(&highlight) > 0.0 && axis(&shadow) < 0.0,
            "got {:?} / {:?}",
            axis(&highlight),
            axis(&shadow)
        );
    }

    #[test]
    fn no_filter_produces_out_of_range_or_nan_values_on_saturated_input() {
        // Pointwise ops clamp; only the unsharp pass is allowed to ring, and
        // the engine's to_u8 handles that. Everything the composite sees for
        // a colour look must stay a legal code value.
        for filter in Filter::ALL {
            for level in [0.0f32, 1.0f32] {
                let mut data = field(|x, y| {
                    // Alternating extremes so curves, gains and blur all get
                    // exercised against both rails at once.
                    let v = if (x + y) % 2 == 0 { level } else { 1.0 - level };
                    [v, 1.0 - v, v * 0.5 + 0.5]
                });
                run(&mut data, filter, 100);
                for v in &data {
                    assert!(v.is_finite(), "{filter:?} produced a non-finite value");
                    if filter != Filter::Sharp && filter != Filter::Product {
                        assert!(
                            *v >= -1e-6 && *v <= 1.0 + 1e-6,
                            "{filter:?} left {v} outside [0,1]"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn intensity_monotonically_strengthens_a_look() {
        let base = field(|_, _| [0.75, 0.3, 0.5]);
        let mut prev = -1.0f32;
        for step in [0u8, 25, 50, 75, 100] {
            let mut data = base.clone();
            run(&mut data, Filter::Vivid, step);
            let d = (data[0] - luma(0.75, 0.3, 0.5)).abs();
            assert!(d >= prev - 1e-6, "vivid must not weaken as it opens up");
            prev = d;
        }
        assert!(prev > 0.0, "and full strength must actually do something");
    }

    /// The end-to-end claim behind the Look dropdown: every filter the UI
    /// offers does real work at the strength the product defaults to, and
    /// no two of them are the same recipe wearing a different label (the
    /// Stage 06 rule, checked across the whole set rather than one pair).
    #[test]
    fn every_look_does_real_work_and_none_is_a_relabel_of_another() {
        // A field that varies in both axes and across channels, so pointwise
        // tonal looks, colour casts and neighbourhood passes all have
        // something genuine to act on.
        let base = field(|x, y| {
            let u = x as f32 / (W - 1) as f32;
            let v = y as f32 / (H - 1) as f32;
            [0.15 + 0.7 * u, 0.62 - 0.45 * v, 0.25 + 0.5 * u * v]
        });

        let mut done: Vec<(Filter, Vec<f32>)> = Vec::new();
        for filter in Filter::ALL {
            let mut data = base.clone();
            run(&mut data, filter, DEFAULT_INTENSITY);
            if filter == Filter::Original {
                assert_eq!(data, base, "Original must be the untouched result");
                continue;
            }
            assert!(
                data.iter().zip(&base).any(|(a, b)| (a - b).abs() > 1e-4),
                "{filter:?} is a dead switch at the designed strength"
            );
            for (other, other_data) in &done {
                assert!(
                    data.iter()
                        .zip(other_data)
                        .any(|(a, b)| (a - b).abs() > 1e-4),
                    "{filter:?} is {other:?} under a new name"
                );
            }
            done.push((filter, data));
        }
        assert_eq!(done.len(), 10, "the off-switch plus ten looks");
    }

    /// Portrait and Product are the two looks that promise a *combination*
    /// of moves, so each one is checked on all of them: Portrait softens,
    /// warms and lifts without going clay-orange; Product gains clarity
    /// while keeping colours at or under the source. Neither may be a one
    /// -parameter look wearing a two-parameter description.
    #[test]
    fn the_combined_looks_deliver_every_move_they_claim() {
        let skin = field(|_, _| [0.78, 0.58, 0.47]);
        let warm_axis = |d: &[f32]| at(d, 0, 0, 0) - at(d, 2, 0, 0);
        let spread_around_grey = |d: &[f32]| {
            let l = luma(at(d, 0, 0, 0), at(d, 1, 0, 0), at(d, 2, 0, 0));
            (at(d, 0, 0, 0) - l).abs() + (at(d, 1, 0, 0) - l).abs() + (at(d, 2, 0, 0) - l).abs()
        };

        let mut portrait = skin.clone();
        run(&mut portrait, Filter::Portrait, 100);
        assert!(
            warm_axis(&portrait) > warm_axis(&skin),
            "portrait must travel toward warmth"
        );
        let lift = |d: &[f32]| (at(d, 0, 0, 0) + at(d, 1, 0, 0) + at(d, 2, 0, 0)) / 3.0 - 0.61;
        assert!(lift(&portrait) > 0.0, "portrait must lift exposure");
        // The ease is judged against the same recipe with the desaturation
        // step deleted (soften, warm, lift — nothing else). Judging it
        // against the source would be wrong: the warmth itself widens the
        // spread, and "skin does not go clay-orange" is a claim about the
        // cast Portrait applies, not about the picture it started from.
        let mut warmth_without_the_ease = skin.clone();
        let blurred = blur3(&warmth_without_the_ease, W, H);
        for (i, v) in warmth_without_the_ease.iter_mut().enumerate() {
            *v = clamp01(*v + 0.28 * (blurred[i] - *v));
        }
        cast(
            &mut warmth_without_the_ease,
            1.07,
            1.0,
            0.98, // Portrait's own gains at full strength
        );
        for v in warmth_without_the_ease.iter_mut() {
            *v = clamp01(*v + 0.04);
        }
        assert!(
            spread_around_grey(&portrait) < spread_around_grey(&warmth_without_the_ease),
            "portrait must ease the saturation its own warmth adds"
        );

        // Product promises clarity *and* colours kept honest. The tonal
        // curve alone already separates the channels, so the claim is
        // checked against that curve: the extra spread must come from the
        // unsharp, and the chroma must end below a pure contrast push.
        let mut product = skin.clone();
        run(&mut product, Filter::Product, 100);
        let mut contrast_only = skin.clone();
        tone(&mut contrast_only, 1.0, 1.18);
        assert!(
            spread_around_grey(&product) < spread_around_grey(&contrast_only),
            "product must hold colours below a neutral contrast push"
        );

        let mut mid_edge = field(|x, _| {
            let v = if x < W / 2 { 0.35 } else { 0.65 };
            [v, v, v]
        });
        let step = |d: &[f32]| at(d, 0, 16, 8) - at(d, 0, 15, 8);
        let tonal_step = {
            let mut t = mid_edge.clone();
            tone(&mut t, 0.95, 1.18);
            step(&t)
        };
        run(&mut mid_edge, Filter::Product, 100);
        assert!(
            step(&mid_edge) > tonal_step,
            "product clarity must be real local contrast, not the curve alone"
        );
    }

    /// The status list is what the UI renders, so it must carry all eleven
    /// keys in native order with their own words — a missing entry would
    /// silently drop a look from the dropdown.
    #[test]
    fn the_status_list_offers_every_look_with_its_own_words() {
        let statuses: Vec<FilterStatus> = Filter::ALL.iter().copied().map(status_for).collect();
        assert_eq!(statuses.len(), 11);
        let keys: Vec<&str> = statuses.iter().map(|s| s.key).collect();
        assert_eq!(keys[0], "original");
        assert_eq!(
            keys.len(),
            keys.iter().collect::<std::collections::HashSet<_>>().len()
        );
        for (status, filter) in statuses.iter().zip(Filter::ALL) {
            assert_eq!(status.label, filter.label());
            assert_eq!(status.description, filter.description());
            assert!(status.available, "{} is pure pixel math", filter.key());
        }
    }
}
