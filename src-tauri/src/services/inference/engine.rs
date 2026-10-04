//! The image pipeline: preprocess → tiled inference → postprocess →
//! row-streamed output. Pure over the [`Backend`] trait, so the whole
//! geometry/memory contract is testable without ONNX Runtime.
//!
//! Why tiling: a 4× upscale of a 16 MP image would produce a 256 MP
//! tensor; feeding the whole frame at once is hundreds of MB of float
//! *per intermediate activation* and will not fit on a consumer GPU.
//! The reference Real-ESRGAN implementation tiles; we do too.
//!
//! The tile grid is a single column pass per row-band:
//!
//! ```text
//!   for each band of `tile` input rows:
//!     for each tile in the band (left → right):
//!       extract with `pad`-px bleed (clamped at edges) → f32 CHW /255
//!       backend.run_tile → f32 CHW in [0,1]
//!       composite interior (pad cropped off) into the band buffer (u8)
//!     stream the band's output rows into the encoder sink, drop the buffer
//! ```
//!
//! Peak extra memory ≈ one tile's float buffers + one output band —
//! independent of the total image size. The bleed pad gives the network
//! real context at tile borders, so seams are invisible; the pad region
//! is discarded on composite.

use image::RgbImage;

use super::backend::{Backend, CancelToken, EngineError};
use super::finish::{self, Finish};

/// Receives finished output rows, top to bottom, exactly `out_w * 3`
/// bytes each. Implementations stream to disk; nothing here accumulates
/// the full result in memory.
pub trait RowWriter {
    fn write_row(&mut self, rgb: &[u8]) -> Result<(), EngineError>;
}

// Which finishing passes run over each model output tile before it is
// composited lives in `super::finish` — the engine only *applies* them, one
// tile at a time, and never decides which look the product offers.

/// Tile-grid geometry for one job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    pub src_w: usize,
    pub src_h: usize,
    /// Model's upscale factor (model output = input × scale).
    pub scale: usize,
    /// Product upscale factor delivered to the sink (`scale`, or `scale/2`
    /// when the target is smaller — the band is box-resampled by
    /// scale/target before it is written).
    pub target: usize,
    /// Interior tile edge in input px.
    pub tile: usize,
    /// Context bleed around each tile in input px.
    pub pad: usize,
    pub cols: usize,
    pub bands: usize,
}

impl Plan {
    /// Plan for a product scale ≤ model scale that divides it evenly
    /// (`target == scale` is the model-native case).
    pub fn with_target(
        src_w: usize,
        src_h: usize,
        scale: usize,
        target: usize,
        tile: usize,
        pad: usize,
    ) -> Self {
        let tile = tile.max(16);
        debug_assert!(target >= 1 && scale >= target && scale % target == 0);
        Plan {
            src_w,
            src_h,
            scale,
            target,
            tile,
            pad,
            cols: src_w.div_ceil(tile),
            bands: src_h.div_ceil(tile),
        }
    }

    /// Integer box factor between model output and delivered output.
    pub fn resample_factor(&self) -> usize {
        (self.scale / self.target).max(1)
    }

    pub fn out_w(&self) -> usize {
        self.src_w * self.target
    }
    pub fn out_h(&self) -> usize {
        self.src_h * self.target
    }
    pub fn total_tiles(&self) -> usize {
        self.cols * self.bands
    }
}

/// Default tile edge (input px). 256 → 1024 output px at 4×: ~12 MB of
/// float per output tile, comfortable on a 6 GB laptop GPU, and small
/// enough that dozens of progress steps are visible for typical photos.
/// `adaptive_tile` may shrink it on constrained machines (Stage 07).
pub const DEFAULT_TILE: usize = 256;
/// Smallest tile edge the adaptive strategy may use. Below this the
/// per-tile runtime overhead (session call, bleed work) outweighs the
/// memory savings — and the memory floors guarantee 64 px always fits.
pub const MIN_TILE: usize = 64;
/// Default context bleed (input px) — cropped from the output.
pub const DEFAULT_PAD: usize = 8;

/// Approximate *model-output* float bytes for one tile of `tile` input px:
/// the runtime materializes ~3·((tile+2·pad)·scale)² f32 for the padded
/// tile. This is the buffer DirectML/the CPU EP must fit in its arena.
pub fn tile_output_bytes(tile: usize, pad: usize, scale: usize) -> usize {
    let side = (tile + 2 * pad) * scale;
    3 * side * side * std::mem::size_of::<f32>()
}

/// Approximate composited-band bytes for one band: `src_w · scale` wide,
/// `tile · scale` tall, u8 RGB. This buffer is Fovea's own (not the
/// runtime's), allocated once per band and freed after streaming.
pub fn band_bytes(src_w: usize, tile: usize, scale: usize) -> usize {
    src_w * scale * tile * scale * 3
}

/// Pick the largest tile edge ≤ `ceiling` whose runtime output *and*
/// per-band composite buffer fit the machine's budgets. Halving keeps the
/// retry ladder predictable; an explicitly configured ceiling below
/// [`MIN_TILE`] (a test's small grid) is honored as-is — adaptivity
/// shrinks for memory, it never grows the caller's choice.
///
/// Returns `(tile, fits)`; `fits == false` means even the smallest tile
/// exceeds a budget (only reachable with absurd inputs on tiny-memory
/// machines — the caller decides whether to proceed or refuse).
pub fn adaptive_tile(
    src_w: usize,
    scale: usize,
    max_tile_bytes: usize,
    max_band_bytes: usize,
    pad: usize,
    ceiling: usize,
) -> (usize, bool) {
    let floor = ceiling.min(MIN_TILE);
    let mut tile = ceiling.max(16);
    let over = |t: usize| {
        tile_output_bytes(t, pad, scale) > max_tile_bytes
            || band_bytes(src_w, t, scale) > max_band_bytes
    };
    while tile > floor && over(tile) {
        tile /= 2;
    }
    (tile, !over(tile))
}

/// Run the whole pipeline. `progress(done, total)` is called after every
/// completed tile with *measured* counts (tiles finished / tiles planned)
/// — never an invented estimate. `passes` selects the real post-processing
/// and filter passes applied to each tile's f32 output before compositing.
pub fn run<B: Backend, W: RowWriter>(
    backend: &mut B,
    src: &RgbImage,
    plan: &Plan,
    passes: &Finish,
    sink: &mut W,
    cancel: &CancelToken,
    mut progress: impl FnMut(u32, u32),
) -> Result<(), EngineError> {
    if cancel.is_cancelled() {
        return Err(EngineError::Cancelled);
    }
    let scale = plan.scale;
    let out_w_model = plan.src_w * scale;
    let total = plan.total_tiles() as u32;
    let mut done: u32 = 0;

    for band in 0..plan.bands {
        let band_y0 = band * plan.tile;
        let band_h = plan.tile.min(plan.src_h - band_y0);
        // Composite buffer for this band's interior, at *model* resolution
        // in finished u8 RGB (resampling to the target happens on stream).
        let band_buf_h = band_h * scale;
        // Fallible allocation: a plan whose band still exceeds what the OS
        // will hand us (real pressure beyond the modeled budget) surfaces
        // as OutOfMemory so the service ladder can shrink the tile — a
        // raw `vec![]` here would abort the process instead.
        let mut band_buf = Vec::new();
        let band_len = out_w_model * band_buf_h * 3;
        if band_buf.try_reserve_exact(band_len).is_err() {
            return Err(EngineError::OutOfMemory(format!(
                "band buffer {band_len} B"
            )));
        }
        band_buf.resize(band_len, 0u8);

        for col in 0..plan.cols {
            if cancel.is_cancelled() {
                return Err(EngineError::Cancelled);
            }
            let x0 = col * plan.tile;
            let tile_w = plan.tile.min(plan.src_w - x0);

            // ── Preprocess: extract the padded region as CHW f32 [0,1] ──
            let ex0 = x0.saturating_sub(plan.pad);
            let ey0 = band_y0.saturating_sub(plan.pad);
            let ex1 = (x0 + tile_w + plan.pad).min(plan.src_w);
            let ey1 = (band_y0 + band_h + plan.pad).min(plan.src_h);
            let ew = ex1 - ex0;
            let eh = ey1 - ey0;
            let mut chw = Vec::new();
            let chw_len = 3 * ew * eh;
            if chw.try_reserve_exact(chw_len).is_err() {
                return Err(EngineError::OutOfMemory(format!(
                    "tile input {chw_len} f32"
                )));
            }
            chw.resize(chw_len, 0f32);
            for (c, plane) in chw.chunks_exact_mut(ew * eh).enumerate() {
                for (i, v) in plane.iter_mut().enumerate() {
                    let (y, x) = ((i / ew), (i % ew));
                    *v = src.get_pixel((ex0 + x) as u32, (ey0 + y) as u32)[c] as f32 / 255.0;
                }
            }

            // ── Inference ────────────────────────────────────────────────
            let mut out = backend.run_tile(chw, ew, eh, cancel)?;
            if out.width != ew * scale || out.height != eh * scale {
                return Err(EngineError::Failed(format!(
                    "backend returned {}x{} for {ew}x{eh}@{scale}x",
                    out.width, out.height
                )));
            }
            // Mode pass + filter, over the whole padded tile (see `finish`).
            finish::apply(&mut out.data, out.width, out.height, passes);

            // ── Postprocess + composite the interior (pad cropped) ───────
            let ow = out.width;
            for oy in 0..out.height {
                let sy = ey0 + oy / scale;
                // Rows in the pad above/below the band interior are dropped.
                if sy < band_y0 || sy >= band_y0 + band_h {
                    continue;
                }
                let dst_row = (sy - band_y0) * scale + oy % scale;
                let dst_base = dst_row * out_w_model * 3;
                let src_row = oy * ow;
                for ox in 0..ow {
                    let sx = ex0 + ox / scale;
                    if sx < x0 || sx >= x0 + tile_w {
                        continue;
                    }
                    let dst_col = sx * scale + ox % scale;
                    let dst = dst_base + dst_col * 3;
                    for c in 0..3 {
                        let v = out.data[c * out.height * ow + src_row + ox];
                        band_buf[dst + c] = to_u8(v);
                    }
                }
            }

            done += 1;
            progress(done, total);
        }

        // ── Stream the finished band rows out (box-resampled when the
        //    product target is smaller than the model factor). A band only
        //    exists in model resolution in memory; the target row buffer is
        //    one row — peak stays bounded either way. ──
        let f = plan.resample_factor();
        let out_w = plan.out_w();
        if f == 1 {
            for r in 0..band_buf_h {
                let row = &band_buf[r * out_w_model * 3..(r + 1) * out_w_model * 3];
                sink.write_row(row)?;
            }
        } else {
            let mut row_buf = vec![0u8; out_w * 3];
            for r in 0..band_h * plan.target {
                resample_box_row(&band_buf, out_w_model, r, f, &mut row_buf);
                sink.write_row(&row_buf)?;
            }
        }
    }
    Ok(())
}

/// Box-average one band row from model resolution to target resolution.
/// `f` is the integer factor (model px per target px, both axes); exact
/// because the model band is always an integer multiple of the target.
fn resample_box_row(band: &[u8], model_w: usize, out_row: usize, f: usize, dst: &mut [u8]) {
    debug_assert_eq!(dst.len(), model_w / f * 3);
    let inv = 1.0 / (f * f) as f32;
    for ox in 0..model_w / f {
        let mut acc = [0u32; 3];
        for dy in 0..f {
            let mrow = (out_row * f + dy) * model_w * 3;
            for dx in 0..f {
                let base = mrow + (ox * f + dx) * 3;
                for c in 0..3 {
                    acc[c] += band[base + c] as u32;
                }
            }
        }
        let o = ox * 3;
        for c in 0..3 {
            dst[o + c] = ((acc[c] as f32) * inv + 0.5) as u8;
        }
    }
}

/// f32 [0,1] → u8 with rounding. Values outside [0,1] (models can ring)
/// clamp — the honest reconstruction, not a wrap.
#[inline]
fn to_u8(v: f32) -> u8 {
    if v <= 0.0 {
        0
    } else if v >= 1.0 {
        255
    } else {
        (v * 255.0 + 0.5) as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::inference::backend::TileOutput;
    use image::{Rgb, RgbImage};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Nearest-neighbor backend: deterministic, so tests can assert exact
    /// pixel reconstruction; counts calls; can fail on schedule. Honors
    /// the cancel token like a real runtime.
    struct FakeUpscaler {
        scale: usize,
        calls: AtomicUsize,
        fail_after: Option<usize>,
    }

    impl FakeUpscaler {
        fn new(scale: usize) -> Self {
            FakeUpscaler {
                scale,
                calls: AtomicUsize::new(0),
                fail_after: None,
            }
        }
    }

    impl Backend for FakeUpscaler {
        fn device_name(&self) -> &'static str {
            "fake"
        }
        fn run_tile(
            &mut self,
            chw: Vec<f32>,
            width: usize,
            height: usize,
            cancel: &CancelToken,
        ) -> Result<TileOutput, EngineError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if cancel.is_cancelled() {
                return Err(EngineError::Cancelled);
            }
            if self.fail_after == Some(n) {
                return Err(EngineError::Failed("injected failure".into()));
            }
            let (ow, oh) = (width * self.scale, height * self.scale);
            let mut data = vec![0f32; 3 * oh * ow];
            for c in 0..3 {
                for y in 0..oh {
                    for x in 0..ow {
                        data[c * oh * ow + y * ow + x] =
                            chw[c * height * width + (y / self.scale) * width + x / self.scale];
                    }
                }
            }
            Ok(TileOutput {
                width: ow,
                height: oh,
                data,
            })
        }
    }

    /// Collects rows so tests can assert exact geometry + ordering.
    struct CollectSink {
        out_w: usize,
        rows: Vec<Vec<u8>>,
    }

    impl RowWriter for CollectSink {
        fn write_row(&mut self, rgb: &[u8]) -> Result<(), EngineError> {
            assert_eq!(rgb.len(), self.out_w * 3, "row must be the full width");
            self.rows.push(rgb.to_vec());
            Ok(())
        }
    }

    /// Gradient image: every pixel differs by position, so any tiling or
    /// compositing bug changes pixels somewhere.
    fn gradient(w: u32, h: u32) -> RgbImage {
        let mut img = RgbImage::new(w, h);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = Rgb([
                ((x + y) % 255) as u8,
                (x * 3 % 251) as u8,
                (y * 7 % 249) as u8,
            ]);
        }
        img
    }

    fn assert_exact_upscale(src: &RgbImage, scale: usize, tile: usize, pad: usize) {
        assert_exact_upscale_target(src, scale, scale, tile, pad)
    }

    /// Round-trip a plan whose *model* factor is `scale` and whose product
    /// target is `target` (≤ scale, dividing it). The nearest fake doubles
    /// pixels without inventing any, so a box downsample from scale to
    /// target must land exactly on source pixels: the 2× path and the 4×
    /// path share identical geometry guarantees.
    fn assert_exact_upscale_target(
        src: &RgbImage,
        scale: usize,
        target: usize,
        tile: usize,
        pad: usize,
    ) {
        let plan = Plan::with_target(
            src.width() as usize,
            src.height() as usize,
            scale,
            target,
            tile,
            pad,
        );
        let mut sink = CollectSink {
            out_w: plan.out_w(),
            rows: Vec::new(),
        };
        let mut progress = Vec::new();
        let mut backend = FakeUpscaler::new(scale);
        run(
            &mut backend,
            src,
            &plan,
            &Finish::identity(),
            &mut sink,
            &CancelToken::new(),
            |d, t| progress.push((d, t)),
        )
        .expect("pipeline must succeed");
        let total = plan.total_tiles() as u32;
        assert_eq!(sink.rows.len(), plan.out_h());
        assert_eq!(progress.last().copied(), Some((total, total)));
        assert!(
            progress.windows(2).all(|w2| w2[0].0 + 1 == w2[1].0),
            "progress must count every tile once, in order"
        );
        // Every output pixel equals its source pixel (nearest fake; box
        // averaging identical values is exact) → the tiling/compositing/
        // resampling round-trip is pixel-exact for any grid.
        for (y, row) in sink.rows.iter().enumerate() {
            for (x, px) in row.chunks(3).enumerate() {
                let s = src.get_pixel((x / target) as u32, (y / target) as u32);
                assert_eq!(px, [s[0], s[1], s[2]], "mismatch at output ({x},{y})");
            }
        }
    }

    #[test]
    fn single_tile_roundtrip_is_pixel_exact() {
        assert_exact_upscale(&gradient(48, 32), 2, 256, 8);
    }

    #[test]
    fn multi_band_multi_column_roundtrip_is_pixel_exact() {
        // 3 bands × 3 cols, non-divisible remainder sizes.
        assert_exact_upscale(&gradient(100, 90), 2, 40, 8);
    }

    #[test]
    fn pad_clamps_at_edges_without_changing_pixels() {
        // A pad larger than the image still composites correctly.
        assert_exact_upscale(&gradient(30, 20), 3, 16, 64);
    }

    #[test]
    fn tiles_odd_sizes_with_scale_four() {
        assert_exact_upscale(&gradient(61, 33), 4, 24, 8);
    }

    #[test]
    fn half_target_resamples_the_model_band_exactly() {
        // The Stage 06 2× path: a 4× model band box-averaged to 2×.
        assert_exact_upscale_target(&gradient(61, 33), 4, 2, 24, 8);
        assert_exact_upscale_target(&gradient(100, 90), 4, 2, 40, 8);
        assert_exact_upscale_target(&gradient(48, 32), 2, 2, 256, 8);
    }

    /// The engine's own contract: whatever [`Finish`] says must actually be
    /// applied to the tile output before compositing. Identity leaves every
    /// pixel exactly as the fake backend returned it (covered by the
    /// round-trip tests above); a real filter must change pixels without
    /// changing geometry by one row or column.
    #[test]
    fn finish_passes_reach_the_composite_and_never_move_geometry() {
        let src = gradient(70, 50);
        let plan = Plan::with_target(70, 50, 2, 2, 32, 8);
        let run_with = |passes: Finish| {
            let mut sink = CollectSink {
                out_w: plan.out_w(),
                rows: Vec::new(),
            };
            let mut backend = FakeUpscaler::new(2);
            run(
                &mut backend,
                &src,
                &plan,
                &passes,
                &mut sink,
                &CancelToken::new(),
                |_, _| {},
            )
            .expect("pipeline must succeed");
            sink.rows
        };
        let clean = run_with(Finish::identity());
        let vivid = run_with(Finish {
            filter: finish::Filter::Vivid,
            intensity: 100,
            ..Finish::identity()
        });
        assert_eq!(clean.len(), vivid.len(), "same rows");
        assert!(
            clean
                .iter()
                .zip(&vivid)
                .all(|(a, b)| a.len() == b.len() && a.len() == plan.out_w() * 3),
            "same width"
        );
        // A 1.6× saturation push on a per-position gradient cannot leave
        // every pixel where it was — if it did, the pass is not wired in.
        let changed = clean
            .iter()
            .zip(&vivid)
            .flat_map(|(a, b)| a.iter().zip(b))
            .filter(|(x, y)| x != y)
            .count();
        assert!(
            changed > 1000,
            "filter must move pixels (changed {changed})"
        );
        // The Detail mode's pass still lands where it always did.
        let detail = run_with(Finish::sharpen());
        assert_ne!(clean, detail, "Sharpen post-pass must reach output");
    }

    #[test]
    fn to_u8_clamps_model_ringing_instead_of_wrapping() {
        assert!(to_u8(-0.2) == 0 && to_u8(1.4) == 255 && to_u8(0.5) == 128);
    }

    /// A backend that cancels the job right after its first successful
    /// tile — the pipeline must stop cleanly and report Cancelled.
    struct CancelAfterFirst {
        inner: FakeUpscaler,
        fired: bool,
        cancel: Arc<CancelToken>,
    }

    impl Backend for CancelAfterFirst {
        fn device_name(&self) -> &'static str {
            "fake-cancel"
        }
        fn run_tile(
            &mut self,
            chw: Vec<f32>,
            w: usize,
            h: usize,
            c: &CancelToken,
        ) -> Result<TileOutput, EngineError> {
            let out = self.inner.run_tile(chw, w, h, c);
            if out.is_ok() && !self.fired {
                self.fired = true;
                self.cancel.cancel();
            }
            out
        }
    }

    #[test]
    fn cancellation_between_tiles_stops_immediately() {
        let src = gradient(120, 60);
        let plan = Plan::with_target(120, 60, 2, 2, 40, 8);
        let mut sink = CollectSink {
            out_w: plan.out_w(),
            rows: Vec::new(),
        };
        let cancel = Arc::new(CancelToken::new());
        let mut backend = CancelAfterFirst {
            inner: FakeUpscaler::new(2),
            fired: false,
            cancel: Arc::clone(&cancel),
        };
        let mut progress_log: Vec<u32> = Vec::new();
        let err = run(
            &mut backend,
            &src,
            &plan,
            &Finish::identity(),
            &mut sink,
            &cancel,
            |d, _t| progress_log.push(d),
        );
        assert!(matches!(err, Err(EngineError::Cancelled)));
        assert_eq!(
            progress_log.len(),
            1,
            "exactly one tile completed before stop"
        );
    }

    #[test]
    fn pre_cancelled_run_does_nothing() {
        let src = gradient(60, 40);
        let plan = Plan::with_target(60, 40, 2, 2, 40, 8);
        let mut sink = CollectSink {
            out_w: plan.out_w(),
            rows: Vec::new(),
        };
        let cancel = CancelToken::new();
        cancel.cancel();
        let mut backend = FakeUpscaler::new(2);
        let err = run(
            &mut backend,
            &src,
            &plan,
            &Finish::identity(),
            &mut sink,
            &cancel,
            |_, _| {},
        );
        assert!(matches!(err, Err(EngineError::Cancelled)));
        assert_eq!(
            backend.calls.load(Ordering::SeqCst),
            0,
            "a cancelled job must never touch the runtime"
        );
    }

    #[test]
    fn backend_failure_propagates_and_writes_nothing_from_the_failed_band() {
        let src = gradient(100, 60);
        let plan = Plan::with_target(100, 60, 2, 2, 40, 8); // 3 cols → band 0 = tiles 0..2
        let mut sink = CollectSink {
            out_w: plan.out_w(),
            rows: Vec::new(),
        };
        let mut backend = FakeUpscaler::new(2);
        backend.fail_after = Some(2); // the 3rd tile (last of band 0) fails
        let err = run(
            &mut backend,
            &src,
            &plan,
            &Finish::identity(),
            &mut sink,
            &CancelToken::new(),
            |_, _| {},
        );
        assert!(matches!(err, Err(EngineError::Failed(_))));
        // A band is only streamed once every tile in it finished — the
        // failed band writes no rows.
        assert!(sink.rows.is_empty(), "no rows written when the band failed");
    }

    #[test]
    fn plan_geometry() {
        let p = Plan::with_target(100, 90, 4, 4, 40, 8);
        assert_eq!((p.cols, p.bands, p.total_tiles()), (3, 3, 9));
        assert_eq!((p.out_w(), p.out_h()), (400, 360));
        // Tile floors at 16 so a nonsense config can't make one tile per pixel.
        assert_eq!(Plan::with_target(64, 64, 2, 2, 1, 8).tile, 16);
    }

    // ── Stage 07: adaptive tiling math ───────────────────────────────

    #[test]
    fn adaptive_tile_keeps_the_ceiling_when_budgets_are_generous() {
        // 4× model, 256 px tile → 3·((256+16)·4)²·4 B ≈ 14 MB of output
        // floats. A 2 GB tile budget keeps the 256 ceiling untouched.
        let (tile, fits) = adaptive_tile(4000, 4, 2 << 30, 2 << 30, 8, DEFAULT_TILE);
        assert_eq!((tile, fits), (256, true));
        // The estimate is monotonic in tile size — sanity for the ladder.
        assert!(tile_output_bytes(128, 8, 4) < tile_output_bytes(256, 8, 4));
    }

    #[test]
    fn adaptive_tile_shrinks_to_fit_the_runtime_budget() {
        // Budget just above a 64 px tile's footprint → ladder lands on 64.
        let need64 = tile_output_bytes(64, 8, 4);
        let (tile, fits) = adaptive_tile(4000, 4, need64 + 1024, 512 << 20, 8, 256);
        assert_eq!((tile, fits), (64, true));
        // A budget that fits 128 but not 256 → 128.
        let need128 = tile_output_bytes(128, 8, 4);
        let (tile, fits) = adaptive_tile(4000, 4, need128, 512 << 20, 8, 256);
        assert_eq!((tile, fits), (128, true));
    }

    #[test]
    fn adaptive_tile_shrinks_to_fit_the_band_budget_too() {
        // Wide source: the composite band (src_w·scale × tile·scale × 3 B)
        // is the constraint, not the runtime tile. 8000·4 wide × 256·4 tall
        // × 3 ≈ 98 MB → a 60 MB band budget forces 128 px tiles (49 MB).
        let band_256 = band_bytes(8000, 256, 4);
        let band_128 = band_bytes(8000, 128, 4);
        assert!(band_256 > 60 << 20 && band_128 < 60 << 20, "fixture math");
        let (tile, fits) = adaptive_tile(8000, 4, 512 << 20, 60 << 20, 8, 256);
        assert_eq!((tile, fits), (128, true));
    }

    #[test]
    fn adaptive_tile_reports_when_even_the_floor_busts() {
        // A band budget smaller than any tile can fit: the ladder stops at
        // the 64 px floor and says so — the caller decides whether to
        // proceed (try_reserve makes the final allocation call honestly)
        // or refuse.
        let (tile, fits) = adaptive_tile(16000, 4, 512 << 20, 1 << 20, 8, 256);
        assert_eq!(tile, 64);
        assert!(!fits, "16000·4 × 64·4 × 3 B is way over 1 MB");
    }

    #[test]
    fn adaptive_tile_honors_small_explicit_ceilings() {
        // A test/QA config with tile=40 is below MIN_TILE: adaptivity
        // never *grows* the caller's grid, and generous budgets leave it
        // exactly where it was set.
        let (tile, fits) = adaptive_tile(100, 2, 512 << 20, 512 << 20, 8, 40);
        assert_eq!((tile, fits), (40, true));
    }
}
