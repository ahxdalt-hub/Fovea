/**
 * Display formatting helpers — human-readable sizes and pixel dimensions.
 * Deliberately tiny and dependency-free; these are presentation concerns
 * only, so they never live next to the data (DTOs stay raw numbers).
 */

/** Bytes → "128 KB" / "2.4 MB". Binary units, one decimal above 1000. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1000) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1000) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/** "1920 × 1080" with the proper multiplication sign. */
export function formatDimensions(width: number, height: number): string {
  return `${width.toLocaleString('en-US')} × ${height.toLocaleString('en-US')}`
}

/** Mega-pixels, e.g. "2.1 MP". */
export function formatMegapixels(width: number, height: number): string {
  return `${((width * height) / 1_000_000).toFixed(1)} MP`
}
