/**
 * Shared product catalog (Stage 10) — the labels and one-line descriptions
 * for enhancement modes, finishing filters and export formats, in one plain
 * module.
 *
 * They used to live beside their first component, but the strip, the
 * export dialog, the batch preset and (now) Settings all present the
 * same choices, and a page that labels "Natural" one way and another way
 * somewhere else is a bug waiting to happen. Constants go here so the
 * components stay component-only.
 */
import type { EnhanceModeKey, ExportFormatKey, FilterKey } from '../types/ipc'

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

/** Filters are pure pixel math on data the engine already has, so unlike
 * modes every one is always offered. The native status supplies the
 * authoritative labels and hints and wins whenever it is present. */
export const FILTER_ORDER: FilterKey[] = [
  'original',
  'natural',
  'vivid',
  'warm',
  'cool',
  'cinematic',
  'soft',
  'sharp',
  'mono',
  'product',
  'portrait',
]

export const FILTER_LABEL: Record<FilterKey, string> = {
  original: 'Original',
  natural: 'Natural',
  vivid: 'Vivid',
  warm: 'Warm',
  cool: 'Cool',
  cinematic: 'Cinematic',
  soft: 'Soft',
  sharp: 'Sharp',
  mono: 'Black & White',
  product: 'Product',
  portrait: 'Portrait',
}

/** Fallback one-liners (pre-status / browser preview); the native status
 * carries the authoritative descriptions and wins when present. */
export const FILTER_HINT: Record<FilterKey, string> = {
  original: 'No finishing pass — exactly what the model produced',
  natural: 'Slight saturation and contrast lift, no colour cast',
  vivid: 'Strong saturation and contrast — punchy, for content that pops',
  warm: 'Warms the balance: red up, blue down',
  cool: 'Cools the balance: blue up, red down',
  cinematic: 'Filmic curve — lifted blacks, warm highlights, teal shadows',
  soft: 'Blends toward a blur — gentle skin, calmer detail',
  sharp: 'Unsharp local contrast on top of the result',
  mono: 'Toward luminance with tonal contrast — intensity sets how far',
  product: 'Clarity and neutral contrast, colours kept accurate',
  portrait: 'Mild softening, small exposure lift, warmth, eased saturation',
}

/** The slider's neutral position: the strength each filter was designed at,
 * not a cap. Mirrors `DEFAULT_INTENSITY` on the Rust side, which is the
 * value the engine applies when a client sends nothing meaningful. */
export const FILTER_DEFAULT_INTENSITY = 50

export const FORMATS: Array<{ value: ExportFormatKey; label: string; hint: string }> = [
  { value: 'png', label: 'PNG', hint: 'Lossless · largest file' },
  { value: 'jpeg', label: 'JPEG', hint: 'Photo-quality · small file' },
  { value: 'webp', label: 'WebP', hint: 'Modern · small with alpha' },
]
