/**
 * Stage 12 failure-formatting guards — a non-finite number from a bad
 * payload must degrade the label ("—"), never the render ("NaN GB").
 */
import { describe, expect, it } from 'vitest'
import { formatBytes, formatDimensions, formatMegapixels } from './format'

describe('formatBytes', () => {
  it('formats normal sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('degrades non-finite and negative input honestly', () => {
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatBytes(-5)).toBe('0 B')
  })
})

describe('formatDimensions', () => {
  it('formats a normal pair', () => {
    expect(formatDimensions(1920, 1080)).toBe('1,920 × 1,080')
  })

  it('never renders NaN when a dimension is bad', () => {
    expect(formatDimensions(Number.NaN, 1080)).toBe('? × 1,080')
    expect(formatDimensions(Number.NaN, Number.NaN)).toBe('? × ?')
  })
})

describe('formatMegapixels', () => {
  it('formats and degrades', () => {
    expect(formatMegapixels(2000, 1500)).toBe('3.0 MP')
    expect(formatMegapixels(Number.NaN, 10)).toBe('—')
  })
})
