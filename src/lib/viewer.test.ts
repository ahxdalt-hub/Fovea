import { describe, expect, it } from 'vitest'
import {
  clampScale,
  clampView,
  fitView,
  formatZoom,
  isFitted,
  panView,
  scaleView,
  wheelFactor,
  zoomView,
} from './viewer'

const landscape = { width: 4000, height: 2000 }
const stage = { width: 1000, height: 600 }

describe('fitView', () => {
  it('scales down to the stage with padding and centers the image', () => {
    const view = fitView(landscape, stage)
    expect(view).not.toBeNull()
    const v = view!
    // 4000×2000 into 944×544 usable → width binds.
    expect(v.scale).toBeCloseTo(944 / 4000)
    const rw = landscape.width * v.scale
    const rh = landscape.height * v.scale
    expect(v.x).toBeCloseTo((stage.width - rw) / 2)
    expect(v.y).toBeCloseTo((stage.height - rh) / 2)
  })

  it('never magnifies past actual size', () => {
    const tiny = { width: 50, height: 40 }
    const v = fitView(tiny, stage)!
    // A small image sits at 1:1, centered — sharp, not stretched to fill.
    expect(v.scale).toBe(1)
    expect(v.x).toBeCloseTo((stage.width - 50) / 2)
    expect(v.y).toBeCloseTo((stage.height - 40) / 2)
  })

  it('returns null until the stage has a real size', () => {
    expect(fitView(landscape, { width: 0, height: 600 })).toBeNull()
  })
})

describe('clampView', () => {
  it('centers when the image is smaller than the stage', () => {
    const clamped = clampView({ scale: 0.1, x: -500, y: -300 }, landscape, stage)
    expect(clamped.x).toBeCloseTo((stage.width - 400) / 2)
    expect(clamped.y).toBeCloseTo((stage.height - 200) / 2)
  })

  it('prevents edge gaps when zoomed in', () => {
    const wide = clampView({ scale: 1, x: 50, y: -9999 }, landscape, stage)
    expect(wide.x).toBeLessThanOrEqual(0)
    expect(wide.y).toBeGreaterThanOrEqual(stage.height - 2000)
  })
})

describe('zoomView', () => {
  it('keeps the anchor point locked over the same image pixel', () => {
    const start = fitView(landscape, stage)!
    const anchor = { x: 700, y: 300 }
    const zoomed = zoomView(start, 1.5, anchor, landscape, stage)
    // Image-space point under the anchor must be unchanged.
    const beforePx = (anchor.x - start.x) / start.scale
    const afterPx = (anchor.x - zoomed.x) / zoomed.scale
    expect(afterPx).toBeCloseTo(beforePx)
  })

  it('respects the scale bounds', () => {
    const start = fitView(landscape, stage)!
    const huge = zoomView(start, 1e6, { x: 500, y: 300 }, landscape, stage)
    expect(huge.scale).toBe(32)
    const tiny = zoomView(start, 1e-6, { x: 500, y: 300 }, landscape, stage)
    expect(tiny.scale).toBe(0.02)
  })
})

describe('panView', () => {
  it('moves the image and clamps at the coverage limit', () => {
    const start = { scale: 1, x: 0, y: 0 } // 4000×2000 at stage 1000×600
    const moved = panView(start, -200, -50, landscape, stage)
    expect(moved.x).toBe(-200)
    const tooFar = panView(moved, -5000, 0, landscape, stage)
    expect(tooFar.x).toBe(stage.width - 4000)
  })
})

describe('scaleView / isFitted / formatZoom', () => {
  it('1:1 preserves the center', () => {
    const start = fitView(landscape, stage)!
    const one = scaleView(start, 1, landscape, stage)
    expect(one.scale).toBe(1)
    expect(one.x).toBeCloseTo((stage.width - landscape.width) / 2)
  })

  it('isFitted detects the fit view and a nudged one', () => {
    const fit = fitView(landscape, stage)!
    expect(isFitted(fit, landscape, stage)).toBe(true)
    expect(isFitted({ ...fit, scale: fit.scale * 1.01 }, landscape, stage)).toBe(false)
  })

  it('formats zoom labels compactly', () => {
    expect(formatZoom(1)).toBe('100%')
    expect(formatZoom(1.25)).toBe('125%')
    expect(formatZoom(0.05)).toBe('5%')
    expect(formatZoom(3.14159)).toBe('314%')
  })

  it('clampScale keeps values legal', () => {
    expect(clampScale(0)).toBe(0.02)
    expect(clampScale(9999)).toBe(32)
  })
})

describe('wheelFactor', () => {
  it('scrolling up zooms in, down zooms out', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1)
    expect(wheelFactor(100)).toBeLessThan(1)
    expect(wheelFactor(0)).toBeCloseTo(1)
  })
})
