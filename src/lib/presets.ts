/**
 * Smart presets (Stage 19) — seven named starting points that map to real
 * processing parameters, not to relabeled copies of one setting.
 *
 * A preset writes the same four values the Enhance strip itself holds
 * (scale, mode, filter, intensity) plus, where the deliverable really does
 * differ, the export format and quality. That is the whole mechanism: pick a
 * preset, the controls move, and Enhance runs exactly what the strip now
 * shows. Nothing is hidden and nothing is applied behind the UI.
 *
 * Every preset must differ from every other in at least two parameters —
 * enforced by unit test, because a preset that is really a rename is worse
 * than no preset: it teaches the user that the buttons do nothing.
 */
import type { EnhanceModeKey, ExportFormatKey, FilterKey } from '../types/ipc'

export type PresetKey =
  | 'photo'
  | 'portrait'
  | 'old-photo'
  | 'product'
  | 'print'
  | 'web'
  | 'illustration'

/** The processing choices a preset writes into the strip. */
export interface PresetProcessing {
  scale: number
  mode: EnhanceModeKey
  filter: FilterKey
  intensity: number
}

/** What the finished file should be, when the workflow has an opinion. */
export interface PresetExport {
  format: ExportFormatKey
  quality: number
}

export interface Preset {
  key: PresetKey
  label: string
  /** One line: what it is for, and why these settings. */
  hint: string
  processing: PresetProcessing
  export?: PresetExport
}

/** Order is the product's opinion — the two photographic workflows people
 * reach for first, then the specialist ones. */
export const PRESETS: Preset[] = [
  {
    key: 'photo',
    label: 'Photo',
    hint: 'Everyday photos — a clean 2× with the lightest possible touch',
    processing: { scale: 2, mode: 'standard', filter: 'natural', intensity: 40 },
    export: { format: 'jpeg', quality: 90 },
  },
  {
    key: 'portrait',
    label: 'Portrait',
    hint: 'Faces — soften the detail, lift exposure a little, keep skin honest',
    processing: { scale: 2, mode: 'standard', filter: 'portrait', intensity: 55 },
    export: { format: 'jpeg', quality: 92 },
  },
  {
    key: 'old-photo',
    label: 'Old Photo',
    hint: 'Scans and prints — denoise-first model at 4×, then calm the grain',
    processing: { scale: 4, mode: 'natural', filter: 'soft', intensity: 35 },
    export: { format: 'png', quality: 100 },
  },
  {
    key: 'product',
    label: 'Product',
    hint: 'Catalogue shots — crisp and neutral, colours kept sellable',
    processing: { scale: 2, mode: 'detail', filter: 'product', intensity: 60 },
    export: { format: 'png', quality: 100 },
  },
  {
    key: 'print',
    label: 'Print',
    hint: 'Maximum reproduction — native 4×, real sharpening, lossless master',
    processing: { scale: 4, mode: 'detail', filter: 'natural', intensity: 35 },
    export: { format: 'png', quality: 100 },
  },
  {
    key: 'web',
    label: 'Web',
    hint: 'Screen-first — 2× is enough, colour opened up, small modern file',
    processing: { scale: 2, mode: 'standard', filter: 'vivid', intensity: 45 },
    export: { format: 'webp', quality: 82 },
  },
  {
    key: 'illustration',
    label: 'Illustration',
    hint: 'Art and graphics — denoise-first at 4×, saturation held true',
    processing: { scale: 4, mode: 'natural', filter: 'natural', intensity: 60 },
    export: { format: 'png', quality: 100 },
  },
]

export function presetByKey(key: string): Preset | undefined {
  return PRESETS.find((p) => p.key === key)
}

/** The preset whose settings the strip currently shows, or `null` for a
 * hand-tuned combination — which is what keeps the highlight honest. */
export function matchingPreset(choices: PresetProcessing): Preset | null {
  return (
    PRESETS.find(
      (p) =>
        p.processing.scale === choices.scale &&
        p.processing.mode === choices.mode &&
        p.processing.filter === choices.filter &&
        p.processing.intensity === choices.intensity,
    ) ?? null
  )
}
