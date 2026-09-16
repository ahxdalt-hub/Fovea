/**
 * Enhancement orchestration (Stage 05, controls in Stage 06) — the single
 * funnel for running the local AI engine on an imported image.
 *
 * Responsibilities mirror `useImport`'s contract: run the native job with
 * the user's chosen mode + scale, translate events into app state (the
 * job's six honest phases), and surface terminal outcomes as user-safe
 * notifications. The engine's progress is real: completed-tile counts
 * arrive from native, and the reducer stores them without inventing
 * anything in between.
 *
 * One job at a time — the native registry enforces the same, so the UI
 * shows a busy engine rather than a queue that doesn't exist.
 */
import { useCallback, useRef } from 'react'
import { cancelEnhancement, enhanceImage } from '../ipc/bridge'
import { toAppError, type EnhanceModeKey } from '../types/ipc'
import { useAppState } from './useAppState'
import { useNotify } from '../ui/notificationContext'

/** The parameters of one enhancement run — chosen by the user, never
 * defaulted inside this funnel. */
export interface EnhanceRunParams {
  mode: EnhanceModeKey
  scale: number
}

export interface EnhanceApi {
  /** Start enhancing the given image (no-op while a job runs). */
  run: (imageId: string, params: EnhanceRunParams) => Promise<void>
  /** Ask the native engine to stop the current job. */
  cancel: () => Promise<void>
  /** Dismiss a finished/failed job panel. */
  dismiss: () => void
}

export function useEnhance(): EnhanceApi {
  const { state, dispatch } = useAppState()
  const { notify } = useNotify()
  const running = useRef(false)

  const run = useCallback(
    async (imageId: string, params: EnhanceRunParams) => {
      if (running.current) return
      running.current = true
      dispatch({ type: 'enhance/start', imageId })
      try {
        const result = await enhanceImage(imageId, params.mode, params.scale, (event) =>
          dispatch({ type: 'enhance/event', event }),
        )
        // The result is authoritative — the completed event may already
        // have arrived, but the file-backed data URL only lands here.
        dispatch({
          type: 'enhancements/set',
          enhancement: {
            imageId: result.imageId,
            dataUrl: result.dataUrl,
            width: result.width,
            height: result.height,
            label: result.label,
          },
        })
        notify(
          'success',
          `Enhanced to ${result.width.toLocaleString()} × ${result.height.toLocaleString()} on ${result.engine} · saved locally`,
        )
      } catch (error) {
        const appError = toAppError(error)
        // The native stream already emitted the matching terminal event
        // for engine-side failures; dispatching again is harmless and
        // keeps the panel correct for pre-command rejections (busy,
        // unreachable core, browser preview).
        dispatch({
          type: 'enhance/event',
          event: { phase: 'failed', code: appError.code, message: appError.message },
        })
      } finally {
        running.current = false
      }
    },
    [dispatch, notify],
  )

  const cancel = useCallback(async () => {
    const job = state.enhanceJob
    if (!job?.jobId) return // nothing cancellable yet (or already terminal)
    dispatch({ type: 'enhance/cancelRequested' })
    try {
      await cancelEnhancement(job.jobId)
    } catch (error) {
      // A failed cancel signal must not strand the panel: the command's
      // promise still settles the job's terminal state.
      notify('warning', toAppError(error).message)
    }
  }, [dispatch, notify, state.enhanceJob])

  const dismiss = useCallback(() => dispatch({ type: 'enhance/clear' }), [dispatch])

  return { run, cancel, dismiss }
}
