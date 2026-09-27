/**
 * Shared product catalog (Stage 10) — the labels and one-line
 * descriptions for enhancement modes and export formats, in one plain
 * module.
 *
 * They used to live beside their first component, but the strip, the
 * export dialog, the batch preset and (now) Settings all present the
 * same choices, and a page that labels "Natural" one way and another way
 * somewhere else is a bug waiting to happen. Constants go here so the
 * components stay component-only.
 */
import type { EnhanceModeKey, ExportFormatKey } from '../types/ipc'

/** Order is the product's opinion; availability comes from native. */
export const MODE_ORDER: EnhanceModeKey[] = ['standard', 'natural', 'detail']

export const MODE_LABEL: Record<EnhanceModeKey, string> = {
  standard: 'Standard',
  natural: 'Natural',
  detail: 'Detail',
}

/** Fallback one-liners (pre-status / browser preview); the native status
 * carries the authoritative descriptions and wins when present. */
export const MODE_HINT: Record<EnhanceModeKey, string> = {
  standard: 'Reconstructs detail — best for clean photos',
  natural: 'Denoise-first — calmer, keeps the original grain',
  detail: 'Standard plus a real sharpening pass — crisp edges',
}

export const FORMATS: Array<{ value: ExportFormatKey; label: string; hint: string }> = [
  { value: 'png', label: 'PNG', hint: 'Lossless · largest file' },
  { value: 'jpeg', label: 'JPEG', hint: 'Photo-quality · small file' },
  { value: 'webp', label: 'WebP', hint: 'Modern · small with alpha' },
]
