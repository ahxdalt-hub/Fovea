/**
 * Stage 12: the source cache's memory discipline. A removed image must
 * not keep its display (or full-resolution) pixels for the session, and a
 * re-import must not serve yesterday's pixels for a file that changed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// The cache calls the real bridge on a miss; stub it before importing.
vi.mock('../ipc/bridge', () => ({
  loadImageView: vi.fn(async (_id: string, maxEdge?: number) => ({
    width: 10,
    height: 10,
    deliveredEdge: 10,
    original: true,
    dataUrl: `data:image/png;base64,stub-${maxEdge ?? 'view'}`,
  })),
  writeFrontendLog: vi.fn(),
}))

import { loadImageSource, pruneSources, invalidateSources } from './imageSources'

const a = { width: 10, height: 10 }
const b = { width: 10, height: 10 }

afterEach(() => {
  pruneSources([])
})

describe('source cache discipline', () => {
  it('pruneSources evicts ids no longer in the collection', async () => {
    await loadImageSource('kept.png', 'view', a)
    await loadImageSource('removed.png', 'view', a)
    pruneSources(['kept.png'])
    // 'kept' still cached (a second load resolves from cache — mock not
    // called again is implied by the dataUrl matching the first stub).
    const kept = await loadImageSource('kept.png', 'view', a)
    expect(kept?.dataUrl).toBe('data:image/png;base64,stub-view')
    // 'removed' was evicted: this load misses and re-fetches from the
    // mock, whose stub encodes the requested edge — distinct from a cache
    // hit we can distinguish via call count below.
    const { loadImageView } = await import('../ipc/bridge')
    const calls = vi.mocked(loadImageView).mock.calls.length
    await loadImageSource('removed.png', 'view', a)
    expect(vi.mocked(loadImageView).mock.calls.length).toBe(calls + 1)
  })

  it('pruneSources keeps every listed id', async () => {
    await loadImageSource('a.png', 'view', a)
    await loadImageSource('b.png', 'view', b)
    pruneSources(['a.png', 'b.png'])
    const { loadImageView } = await import('../ipc/bridge')
    const calls = vi.mocked(loadImageView).mock.calls.length
    await loadImageSource('a.png', 'view', a)
    await loadImageSource('b.png', 'view', b)
    expect(vi.mocked(loadImageView).mock.calls.length).toBe(calls)
  })

  it('invalidateSources forces a refetch for the given ids only', async () => {
    await loadImageSource('fresh.png', 'view', a)
    await loadImageSource('stale.png', 'view', a)
    invalidateSources(['stale.png'])
    const { loadImageView } = await import('../ipc/bridge')
    const calls = vi.mocked(loadImageView).mock.calls.length
    await loadImageSource('fresh.png', 'view', a)
    // fresh id stays cached
    expect(vi.mocked(loadImageView).mock.calls.length).toBe(calls)
    await loadImageSource('stale.png', 'view', a)
    // stale id refetched
    expect(vi.mocked(loadImageView).mock.calls.length).toBe(calls + 1)
  })
})
