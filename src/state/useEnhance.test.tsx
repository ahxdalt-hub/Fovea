/**
 * useEnhance — the lifecycle of a job the user walks away from.
 *
 * The interesting case is not the happy path: it is removing the image
 * while its enhancement runs. The reducer drops the job panel, but the
 * native job keeps going and holds the single engine slot — so the hook
 * has to stop it, and must not report the outcome of work the user
 * already discarded.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { EnhanceEventDto, EnhanceResultDto, ImportedImageDto } from '../types/ipc'
import type { AppAction, AppState } from './appReducer'

const enhanceImage = vi.fn()
const cancelEnhancement = vi.fn(async (_jobId: string) => {})
const notify = vi.fn()

vi.mock('../ipc/bridge', () => ({
  enhanceImage: (imageId: string, mode: string, scale: number, onEvent: unknown) =>
    enhanceImage(imageId, mode, scale, onEvent as (e: EnhanceEventDto) => void),
  cancelEnhancement: (jobId: string) => cancelEnhancement(jobId),
}))

vi.mock('../ui/notificationContext', () => ({
  useNotify: () => ({ notify }),
}))

import { AppStateProvider } from './AppState'
import { useAppState } from './useAppState'
import { useEnhance } from './useEnhance'

function image(id: string): ImportedImageDto {
  return {
    id,
    name: `${id}.png`,
    format: 'PNG',
    width: 800,
    height: 600,
    sizeBytes: 120_000,
    previewDataUrl: 'data:image/png;base64,AAAA',
  }
}

const result: EnhanceResultDto = {
  imageId: 'a.png',
  filePath: 'C:/appdata/enhanced/a.png',
  width: 3200,
  height: 2400,
  sourceWidth: 800,
  sourceHeight: 600,
  outputWidth: 3200,
  outputHeight: 2400,
  label: '4× · Standard',
  engine: 'DirectML GPU',
  dataUrl: 'data:image/png;base64,RESULT',
}

/** A harness whose promise the test settles by hand — a job that ends
 * whenever the test says, which is exactly the race being covered. */
function renderEnhance() {
  let settle: ((r: EnhanceResultDto) => void) | null = null
  let emit: ((e: EnhanceEventDto) => void) | null = null
  enhanceImage.mockImplementation(
    (_imageId: string, _mode: string, _scale: number, onEvent: (e: EnhanceEventDto) => void) => {
      emit = onEvent
      return new Promise<EnhanceResultDto>((resolve) => {
        settle = resolve
      })
    },
  )

  const hook = renderHook(
    () => {
      const app = useAppState()
      return { enhance: useEnhance(), app }
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <AppStateProvider>{children}</AppStateProvider>
      ),
    },
  )
  const pending: Promise<void>[] = []

  return {
    /** Always the latest render — `state` is a snapshot otherwise. */
    state: (): AppState => hook.result.current.app.state,
    dispatch: (action: AppAction) => act(() => hook.result.current.app.dispatch(action)),
    start: (imageId: string) => {
      pending.push(hook.result.current.enhance.run(imageId, { mode: 'standard', scale: 4 }))
    },
    /** Let the command reach the (mocked) native call. */
    flush: async () => {
      await act(async () => {})
    },
    /** Native says the job started with this id. */
    preparing: (jobId: string) => act(() => emit?.({ phase: 'preparing', jobId })),
    finish: async (r: EnhanceResultDto = result) => {
      settle?.(r)
      await act(async () => {
        await Promise.all(pending)
      })
    },
  }
}

beforeEach(() => {
  enhanceImage.mockReset()
  cancelEnhancement.mockClear()
  notify.mockReset()
})

describe('useEnhance — a job that outlives its image', () => {
  it('cancels natively when the running job’s image is removed', async () => {
    const h = renderEnhance()
    h.dispatch({ type: 'images/add', images: [image('a.png'), image('b.png')] })
    h.start('a.png')
    await h.flush()
    h.preparing('job-1')
    expect(h.state().enhanceJob?.jobId).toBe('job-1')

    h.dispatch({ type: 'images/remove', id: 'a.png' })
    await waitFor(() => expect(cancelEnhancement).toHaveBeenCalledWith('job-1'))

    // The engine answers with the superseded master; nothing about a
    // discarded image may reach state or the user.
    await h.finish()
    expect(h.state().enhancements['a.png']).toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
  })

  it('cancels on arrival when the image goes before native names the job', async () => {
    const h = renderEnhance()
    h.dispatch({ type: 'images/add', images: [image('a.png')] })
    h.start('a.png')
    await h.flush()

    h.dispatch({ type: 'images/remove', id: 'a.png' })
    expect(cancelEnhancement).not.toHaveBeenCalled() // no id to cancel yet

    h.preparing('job-2')
    await waitFor(() => expect(cancelEnhancement).toHaveBeenCalledWith('job-2'))
    await h.finish()
    expect(notify).not.toHaveBeenCalled()
  })

  it('leaves a live job alone while its image is still in the collection', async () => {
    const h = renderEnhance()
    h.dispatch({ type: 'images/add', images: [image('a.png'), image('b.png')] })
    h.start('a.png')
    await h.flush()
    h.preparing('job-3')

    h.dispatch({ type: 'images/remove', id: 'b.png' })
    expect(cancelEnhancement).not.toHaveBeenCalled()
    expect(h.state().enhanceJob?.jobId).toBe('job-3')
  })

  it('reports a normal completion for an image that stayed', async () => {
    const h = renderEnhance()
    h.dispatch({ type: 'images/add', images: [image('a.png')] })
    h.start('a.png')
    await h.flush()
    h.preparing('job-4')
    await h.finish()

    expect(h.state().enhancements['a.png']?.width).toBe(3200)
    expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('3,200'))
  })
})
