import { describe, expect, it } from 'vitest'
import { appReducer, initialState } from './appReducer'
import type { AppConfigDto, AppErrorPayload, ImportedImageDto, SystemInfoDto } from '../types/ipc'

const config: AppConfigDto = {
  productName: 'Test App',
  version: '0.1.0',
  identifier: 'test.example',
  debug: true,
}

const systemInfo: SystemInfoDto = {
  osFamily: 'windows',
  arch: 'x86_64',
  appDataDir: 'C:/Fake/AppData',
}

const failure: AppErrorPayload = { code: 'unexpected_error', message: 'nope' }

describe('appReducer', () => {
  it('starts in connecting state', () => {
    expect(initialState.coreStatus).toBe('connecting')
    expect(initialState.config).toBeNull()
  })

  it('moves to ready with config and system info', () => {
    const next = appReducer(initialState, { type: 'core/ready', config, systemInfo })
    expect(next.coreStatus).toBe('ready')
    expect(next.config).toEqual(config)
    expect(next.systemInfo).toEqual(systemInfo)
    expect(next.error).toBeNull()
  })

  it('records a user-safe error and clears stale data views', () => {
    const ready = appReducer(initialState, { type: 'core/ready', config, systemInfo })
    const failed = appReducer(ready, { type: 'core/error', error: failure })
    expect(failed.coreStatus).toBe('error')
    expect(failed.error).toEqual(failure)
  })

  it('clears the previous error when reconnecting', () => {
    const failed = appReducer(initialState, { type: 'core/error', error: failure })
    const retry = appReducer(failed, { type: 'core/connecting' })
    expect(retry.error).toBeNull()
    expect(retry.coreStatus).toBe('connecting')
  })

  it('navigates between views without touching core data', () => {
    const ready = appReducer(initialState, { type: 'core/ready', config, systemInfo })
    const next = appReducer(ready, { type: 'ui/navigate', view: 'batch' })
    expect(next.ui.view).toBe('batch')
    expect(next.coreStatus).toBe('ready')
    expect(next.systemInfo).toEqual(systemInfo)
  })

  it('persists theme preference in state and toggles the settings dialog', () => {
    const themed = appReducer(initialState, { type: 'ui/setTheme', theme: 'dark' })
    expect(themed.ui.theme).toBe('dark')
    const opened = appReducer(themed, { type: 'ui/settings', open: true })
    expect(opened.ui.settingsOpen).toBe(true)
    const closed = appReducer(opened, { type: 'ui/settings', open: false })
    expect(closed.ui.settingsOpen).toBe(false)
    // Navigation/theme must not disturb each other.
    expect(closed.ui.theme).toBe('dark')
  })

  it('retryCore re-enters connecting and clears the error', () => {
    const failed = appReducer(initialState, { type: 'core/error', error: failure })
    const retried = appReducer(failed, { type: 'ui/retryCore' })
    expect(retried.coreStatus).toBe('connecting')
    expect(retried.error).toBeNull()
  })
})

function imported(overrides: Partial<ImportedImageDto> & { id: string }): ImportedImageDto {
  return {
    name: `${overrides.id}.png`,
    format: 'PNG',
    width: 800,
    height: 600,
    sizeBytes: 120_000,
    previewDataUrl: 'data:image/png;base64,AAAA',
    ...overrides,
  }
}

describe('appReducer — imported collection', () => {
  const ready = appReducer(initialState, { type: 'core/ready', config, systemInfo })

  it('adds images preserving order', () => {
    const next = appReducer(ready, {
      type: 'images/add',
      images: [imported({ id: 'a' }), imported({ id: 'b' })],
    })
    expect(next.images.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('deduplicates by canonical id on re-import', () => {
    const once = appReducer(ready, { type: 'images/add', images: [imported({ id: 'a' })] })
    const twice = appReducer(once, {
      type: 'images/add',
      images: [imported({ id: 'a' }), imported({ id: 'c' })],
    })
    expect(twice.images.map((i) => i.id)).toEqual(['a', 'c'])
    // Re-importing known files returns the identical state object.
    const again = appReducer(twice, { type: 'images/add', images: [imported({ id: 'c' })] })
    expect(again).toBe(twice)
  })

  it('tracks the importing flag without touching the collection', () => {
    const started = appReducer(ready, { type: 'import/start' })
    expect(started.importing).toBe(true)
    expect(started.images).toEqual(ready.images)
    const ended = appReducer(started, { type: 'import/end' })
    expect(ended.importing).toBe(false)
  })

  it('removes one image by id and clears the rest', () => {
    const filled = appReducer(ready, {
      type: 'images/add',
      images: [imported({ id: 'a' }), imported({ id: 'b' })],
    })
    const removed = appReducer(filled, { type: 'images/remove', id: 'a' })
    expect(removed.images.map((i) => i.id)).toEqual(['b'])
    const cleared = appReducer(removed, { type: 'images/clear' })
    expect(cleared.images).toEqual([])
  })

  it('collection survives navigation and theme changes', () => {
    const filled = appReducer(ready, { type: 'images/add', images: [imported({ id: 'a' })] })
    const moved = appReducer(filled, { type: 'ui/navigate', view: 'batch' })
    expect(moved.images).toHaveLength(1)
    const themed = appReducer(moved, { type: 'ui/setTheme', theme: 'dark' })
    expect(themed.images).toHaveLength(1)
  })
})

describe('appReducer — workspace selection & enhancements (Stage 04)', () => {
  const withImages = appReducer(
    appReducer(initialState, {
      type: 'core/ready',
      config,
      systemInfo,
    }),
    { type: 'images/add', images: [imported({ id: 'a' }), imported({ id: 'b' })] },
  )

  it('first import selects the first image automatically', () => {
    expect(withImages.selectedImageId).toBe('a')
  })

  it('explicit selection moves the workspace focus', () => {
    const next = appReducer(withImages, { type: 'images/select', id: 'b' })
    expect(next.selectedImageId).toBe('b')
  })

  it('selecting a known image twice is a no-op in shape', () => {
    const a = appReducer(withImages, { type: 'images/select', id: 'b' })
    const same = appReducer(a, { type: 'images/select', id: 'b' })
    expect(same.selectedImageId).toBe('b')
  })

  it('removing the selected image falls back to a surviving one', () => {
    const removed = appReducer(withImages, { type: 'images/remove', id: 'a' })
    expect(removed.selectedImageId).toBe('b')
    expect(removed.images.map((i) => i.id)).toEqual(['b'])
  })

  it('removing the last image clears the selection', () => {
    const single = appReducer(initialState, { type: 'images/add', images: [imported({ id: 'a' })] })
    const cleared = appReducer(single, { type: 'images/clear' })
    expect(cleared.selectedImageId).toBeNull()
    expect(cleared.enhancements).toEqual({})
  })

  it('stores an enhancement keyed by image id (Stage 05 contract)', () => {
    const result = {
      imageId: 'a',
      dataUrl: 'data:image/png;base64,AA',
      width: 3840,
      height: 2160,
      label: '4× · Standard',
    }
    const next = appReducer(withImages, { type: 'enhancements/set', enhancement: result })
    expect(next.enhancements['a']).toEqual(result)
    // Re-running replaces, not duplicates.
    const rerun = appReducer(next, {
      type: 'enhancements/set',
      enhancement: { ...result, label: '2× · Standard' },
    })
    expect(Object.keys(rerun.enhancements)).toEqual(['a'])
    expect(rerun.enhancements['a']?.label).toBe('2× · Standard')
  })

  it('removing an image drops its enhancement; clearing wipes all', () => {
    const withResult = appReducer(withImages, {
      type: 'enhancements/set',
      enhancement: {
        imageId: 'a',
        dataUrl: 'data:image/png;base64,AA',
        width: 1,
        height: 1,
        label: 'x',
      },
    })
    const removed = appReducer(withResult, { type: 'images/remove', id: 'a' })
    expect(removed.enhancements['a']).toBeUndefined()
    const clearedAll = appReducer(withResult, { type: 'enhancements/clear' })
    expect(clearedAll.enhancements).toEqual({})
  })
})

describe('appReducer — enhance job (Stage 05)', () => {
  const start = { type: 'enhance/start', imageId: 'a' } as const

  it('enhance/start opens a preparing job with no id yet', () => {
    const next = appReducer(initialState, start)
    expect(next.enhanceJob).toEqual({
      imageId: 'a',
      jobId: null,
      phase: 'preparing',
      done: 0,
      total: 0,
      device: null,
      cancelling: false,
      error: null,
    })
  })

  it('the preparing event carries the cancel handle', () => {
    let s = appReducer(initialState, start)
    s = appReducer(s, { type: 'enhance/event', event: { phase: 'preparing', jobId: 'job-1' } })
    expect(s.enhanceJob?.jobId).toBe('job-1')
  })

  it('device events record the engine path — including a GPU→CPU retry', () => {
    let s = appReducer(initialState, start)
    s = appReducer(s, {
      type: 'enhance/event',
      event: { phase: 'device', device: 'DirectML GPU', tile: 256 },
    })
    expect(s.enhanceJob?.device).toBe('DirectML GPU')
    s = appReducer(s, {
      type: 'enhance/event',
      event: { phase: 'device', device: 'CPU', tile: 64 },
    })
    expect(s.enhanceJob?.device).toBe('CPU')
    // A late device event never resurrects a terminal phase.
    s = appReducer(s, { type: 'enhance/event', event: { phase: 'cancelled' } })
    s = appReducer(s, {
      type: 'enhance/event',
      event: { phase: 'device', device: 'CPU', tile: 64 },
    })
    expect(s.enhanceJob?.phase).toBe('cancelled')
  })

  it('processing stores real tile counts', () => {
    let s = appReducer(initialState, start)
    s = appReducer(s, { type: 'enhance/event', event: { phase: 'processing', done: 3, total: 9 } })
    expect(s.enhanceJob?.phase).toBe('processing')
    expect(s.enhanceJob?.done).toBe(3)
    expect(s.enhanceJob?.total).toBe(9)
  })

  it('a full happy path: preparing → processing → completing → completed', () => {
    let s = appReducer(initialState, start)
    s = appReducer(s, { type: 'enhance/event', event: { phase: 'preparing', jobId: 'j' } })
    s = appReducer(s, { type: 'enhance/event', event: { phase: 'processing', done: 1, total: 1 } })
    s = appReducer(s, { type: 'enhance/event', event: { phase: 'completing' } })
    s = appReducer(s, { type: 'enhance/event', event: { phase: 'completed' } })
    expect(s.enhanceJob?.phase).toBe('completed')
    expect(s.enhanceJob?.done).toBe(1)
  })

  it('failed stores the user-safe error; cancelled is distinct', () => {
    let s = appReducer(initialState, start)
    s = appReducer(s, {
      type: 'enhance/event',
      event: { phase: 'failed', code: 'model_missing', message: 'install it' },
    })
    expect(s.enhanceJob?.phase).toBe('failed')
    expect(s.enhanceJob?.error).toEqual({ code: 'model_missing', message: 'install it' })

    let c = appReducer(initialState, start)
    c = appReducer(c, { type: 'enhance/event', event: { phase: 'cancelled' } })
    expect(c.enhanceJob?.phase).toBe('cancelled')
    expect(c.enhanceJob?.error).toBeNull()
  })

  it('a cancelled job is not rewritten to failed by the command rejection', () => {
    let s = appReducer(initialState, start)
    s = appReducer(s, { type: 'enhance/event', event: { phase: 'cancelled' } })
    s = appReducer(s, {
      type: 'enhance/event',
      event: { phase: 'failed', code: 'cancelled', message: 'Processing was cancelled.' },
    })
    expect(s.enhanceJob?.phase).toBe('cancelled')
  })

  it('cancelRequested flags without changing the real phase', () => {
    let s = appReducer(initialState, start)
    s = appReducer(s, { type: 'enhance/event', event: { phase: 'processing', done: 2, total: 5 } })
    s = appReducer(s, { type: 'enhance/cancelRequested' })
    expect(s.enhanceJob?.cancelling).toBe(true)
    expect(s.enhanceJob?.phase).toBe('processing')
    expect(s.enhanceJob?.done).toBe(2)
  })

  it('events for an unknown job are dropped; clear wipes the panel', () => {
    const dropped = appReducer(initialState, {
      type: 'enhance/event',
      event: { phase: 'processing', done: 1, total: 2 },
    })
    expect(dropped.enhanceJob).toBeNull()
    let s = appReducer(initialState, start)
    s = appReducer(s, { type: 'enhance/clear' })
    expect(s.enhanceJob).toBeNull()
  })

  it('removing the job image or clearing the collection drops the panel', () => {
    let s = appReducer(initialState, {
      type: 'images/add',
      images: [
        {
          id: 'a',
          name: 'a.png',
          format: 'PNG',
          width: 10,
          height: 10,
          sizeBytes: 10,
          previewDataUrl: 'data:image/png;base64,AA',
        },
      ],
    })
    s = appReducer(s, start)
    s = appReducer(s, { type: 'images/remove', id: 'a' })
    expect(s.enhanceJob).toBeNull()
    s = appReducer(s, start)
    s = appReducer(s, { type: 'images/clear' })
    expect(s.enhanceJob).toBeNull()
  })

  it('inference/set records engine readiness', () => {
    const status = {
      device: 'DirectML GPU',
      models: [{ id: 'm', label: 'l', scale: 4, state: 'ready', mode: 'standard' }],
      ready: true,
      scales: [2, 4],
      modes: [{ key: 'standard', label: 'Standard', description: 'd', available: true }],
      modelsDirDisplay: 'C:/models',
    }
    const s = appReducer(initialState, { type: 'inference/set', status })
    expect(s.inference?.ready).toBe(true)
    expect(s.inference?.scales).toEqual([2, 4])
    expect(s.inference?.modes).toHaveLength(1)
  })

  it('enhance/setSettings merges partial choices', () => {
    const s = appReducer(initialState, { type: 'enhance/setSettings', settings: { scale: 2 } })
    expect(s.enhanceSettings.scale).toBe(2)
    expect(s.enhanceSettings.mode).toBe('standard') // default stands
    const t = appReducer(s, { type: 'enhance/setSettings', settings: { mode: 'detail' } })
    expect(t.enhanceSettings).toEqual({ scale: 2, mode: 'detail' })
  })

  it('exports/set records the last export per image', () => {
    const result = {
      filePath: 'C:/out/a.png',
      fileName: 'a.png',
      folder: 'C:/out',
      format: 'png',
      bytes: 4321,
    }
    const s = appReducer(initialState, { type: 'exports/set', imageId: 'a', result })
    expect(s.exports['a']).toEqual(result)
    const again = appReducer(s, {
      type: 'exports/set',
      imageId: 'a',
      result: { ...result, format: 'jpeg' },
    })
    expect(again.exports['a']?.format).toBe('jpeg')
  })
})
