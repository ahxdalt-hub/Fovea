/**
 * Viewer math — pure functions for the image workspace.
 *
 * A view is a scale plus a translation in *stage pixels* (the viewport the
 * image lives in), applied as `translate(x, y) scale(s)` with origin 0 0.
 * The image element itself is laid out at natural pixel size inside that
 * wrapper, so every calculation here is plain affine math — no DOM, easy
 * to test, reusable by fit / wheel-zoom / drag-pan / reset.
 *
 * Invariants the UI relies on:
 * - A fitted image is centered with a small breathing margin.
 * - When zoomed out below stage size, the image stays centered (no gaps
 *   you can drag into).
 * - When zoomed in past stage size, edges never show: the offset is
 *   clamped so the image always covers the stage.
 */

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Point {
  readonly x: number
  readonly y: number
}

export interface View {
  readonly scale: number
  readonly x: number
  readonly y: number
}

/** Never let the user zoom past these — sane for 200 MP files to 8× crops. */
export const MIN_SCALE = 0.02
export const MAX_SCALE = 32

/** Breathing room (per side) when fitting an image to the stage. */
export const FIT_PADDING = 28

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** Clamp a translation so the (scaled) image covers the stage, or sits
 * centered when smaller than it. Degenerate sizes return the input. */
export function clampView(view: View, image: Size, stage: Size): View {
  const rw = image.width * view.scale
  const rh = image.height * view.scale
  const clampAxis = (offset: number, rendered: number, container: number): number => {
    if (!(container > 0) || !(rendered > 0)) return offset
    if (rendered <= container) return (container - rendered) / 2
    return Math.min(0, Math.max(container - rendered, offset))
  }
  return {
    scale: view.scale,
    x: clampAxis(view.x, rw, stage.width),
    y: clampAxis(view.y, rh, stage.height),
  }
}

/** The view that centers the whole image in the stage, scaled to fit —
 * never magnified past actual size. A small image in a big stage shows
 * crisp at 1:1 and centered; blowing it up to fill would look like the
 * product has no idea what sharpness is. (Zoom controls stay open.)
 * Returns `null` until the stage has been measured (sizes arrive from a
 * ResizeObserver — zero on first paint is normal, not an error). */
export function fitView(image: Size, stage: Size): View | null {
  if (image.width <= 0 || image.height <= 0) return null
  if (stage.width <= 0 || stage.height <= 0) return null
  const availW = Math.max(1, stage.width - FIT_PADDING * 2)
  const availH = Math.max(1, stage.height - FIT_PADDING * 2)
  const scale = clampScale(Math.min(1, availW / image.width, availH / image.height))
  return clampView({ scale, x: 0, y: 0 }, image, stage)
}

/**
 * Zoom by `factor` keeping the stage-space `anchor` (the cursor) over the
 * same image point. This is what makes wheel-zoom feel pinned to the
 * pointer instead of jumping to the middle.
 */
export function zoomView(
  view: View,
  factor: number,
  anchor: Point,
  image: Size,
  stage: Size,
): View {
  const scale = clampScale(view.scale * factor)
  if (scale === view.scale) return view
  // Image-space point under the anchor before zooming; keep it underneath.
  const px = (anchor.x - view.x) / view.scale
  const py = (anchor.y - view.y) / view.scale
  return clampView({ scale, x: anchor.x - px * scale, y: anchor.y - py * scale }, image, stage)
}

/** Pan by a stage-pixel delta, clamped to the coverage rule. */
export function panView(view: View, dx: number, dy: number, image: Size, stage: Size): View {
  return clampView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, image, stage)
}

/** Set an exact scale, anchored at the stage center (button zoom, 1:1). */
export function scaleView(view: View, scale: number, image: Size, stage: Size): View {
  const center = { x: stage.width / 2, y: stage.height / 2 }
  return zoomView(view, clampScale(scale) / view.scale, center, image, stage)
}

const FIT_EPSILON = 0.5

/** True when `view` is (visually) the fit view — drives the Fit toggle. */
export function isFitted(view: View, image: Size, stage: Size): boolean {
  const fit = fitView(image, stage)
  if (!fit) return false
  return (
    Math.abs(fit.scale - view.scale) < 0.0001 &&
    Math.abs(fit.x - view.x) < FIT_EPSILON &&
    Math.abs(fit.y - view.y) < FIT_EPSILON
  )
}

/** "128%" for the zoom readout. */
export function formatZoom(scale: number): string {
  const pct = scale * 100
  return `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%`
}

/**
 * The wheel-zoom multiplier for a raw `deltaY`. Exponential so one flick
 * covers the same ratio regardless of zoom level; inverted (scroll up =
 * zoom in) like every pro viewer.
 */
export function wheelFactor(deltaY: number): number {
  return Math.pow(1.0015, -deltaY)
}
