/**
 * Display formatting helpers — human-readable sizes and pixel dimensions.
 * Deliberately tiny and dependency-free; these are presentation concerns
 * only, so they never live next to the data (DTOs stay raw numbers).
 *
 * Stage 12: every helper tolerates non-finite input ("—" instead of
 * "NaN GB") — a bad number degrades the label, never the render.
 */

/** Bytes → "128 KB" / "2.4 MB". Binary units, one decimal above 1000. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1000) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1000) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/** "1920 × 1080" with the proper multiplication sign. */
export function formatDimensions(width: number, height: number): string {
  const w = Number.isFinite(width) ? width.toLocaleString('en-US') : '?'
  const h = Number.isFinite(height) ? height.toLocaleString('en-US') : '?'
  return `${w} × ${h}`
}

/** Mega-pixels, e.g. "2.1 MP". */
export function formatMegapixels(width: number, height: number): string {
  const mp = (width * height) / 1_000_000
  return Number.isFinite(mp) ? `${mp.toFixed(1)} MP` : '—'
}
