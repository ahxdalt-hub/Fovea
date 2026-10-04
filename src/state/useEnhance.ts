/**
 * Enhancement orchestration (Stage 05, controls in Stage 06) — the single
 * funnel for running the local AI engine on an imported image.
 *
 * Responsibilities mirror `useImport`'s contract: run the native job with
 * the user's chosen recipe (mode, scale, filter, intensity), translate
 * events into app state (the job's six honest phases), and surface terminal
 * outcomes as user-safe notifications. The engine's progress is real:
 * completed-tile counts arrive from native, and the reducer stores them
 * without inventing anything in between.
 *
 * One job at a time — the native registry enforces the same, so the UI
 * shows a busy engine rather than a queue that doesn't exist.
 */
import { useCallback, useEffect, useRef } from 'react'
import { cancelEnhancement, enhanceImage } from '../ipc/bridge'
import { toAppError, type EnhanceEventDto, type EnhanceRecipe } from '../types/ipc'
import { useAppState } from './useAppState'
import { useNotify } from '../ui/notificationContext'

/** The parameters of one enhancement run — chosen by the user (or by a
 * preset, which writes the same values), never defaulted inside this
 * funnel. */
export type EnhanceRunParams = EnhanceRecipe

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
  // Whether a job panel currently exists — checked from the rejection
  // path, where the closure's `state` may be stale. If the user dismissed
  // the panel, a dispatched `failed` event would land nowhere; the toast
  // is the only surface left. (Synced in an effect, the codebase's
  // latest-value ref idiom.)
  const hasJobPanel = useRef(false)
  // The native job the app started, tracked outside the reducer: removing
  // its image drops the panel, but the work keeps running and holds the
  // single engine slot. Without this the user could neither see nor stop
  // it, and every later Enhance would hear "engine busy".
  const inFlight = useRef<{ imageId: string; jobId: string | null } | null>(null)
  // True once the job's image left the collection — the outcome belongs to
  // work the user already discarded, so it surfaces nowhere.
  const abandoned = useRef(false)
  useEffect(() => {
    hasJobPanel.current = state.enhanceJob !== null
  })
  useEffect(() => {
    const job = inFlight.current
    if (job === null) return
    if (state.images.some((img) => img.id === job.imageId)) return
    abandoned.current = true
    // The id is only known after native's `preparing` event; if the image
    // went sooner than that, the event handler issues the cancel on arrival.
    if (job.jobId !== null) void cancelEnhancement(job.jobId)
  }, [state.images])

  const run = useCallback(
    async (imageId: string, params: EnhanceRunParams) => {
      if (running.current) return
      running.current = true
      inFlight.current = { imageId, jobId: null }
      abandoned.current = false
      const onEvent = (event: EnhanceEventDto) => {
        if (event.phase === 'preparing') {
          const job = inFlight.current
          if (job) job.jobId = event.jobId
          // A cancel request racing the job's own start lands here.
          if (abandoned.current) void cancelEnhancement(event.jobId)
        }
        dispatch({ type: 'enhance/event', event })
      }
      dispatch({ type: 'enhance/start', imageId })
      try {
        const result = await enhanceImage(imageId, params, onEvent)
        if (abandoned.current) return
        // The result is authoritative — the completed event may already
        // have arrived, but the file-backed data URL only lands here. The
        // single-image path always carries a display view; a null one
        // (batch path) would have nothing to show, so we only wire the
        // compare result when a real view came back.
        if (result.dataUrl !== null) {
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
        }
        notify(
          'success',
          `Enhanced to ${result.width.toLocaleString()} × ${result.height.toLocaleString()} on ${result.engine} · saved locally`,
        )
      } catch (error) {
        // An abandoned job ends in a cancellation the user asked for by
        // removing the image; reporting it would announce work they
        // already threw away.
        if (abandoned.current) return
        const appError = toAppError(error)
        // The native stream already emitted the matching terminal event
        // for engine-side failures; dispatching again is harmless and
        // keeps the panel correct for pre-command rejections (busy,
        // unreachable core, browser preview). If the panel is gone —
        // dismissed, or parked by an accepted batch — the dispatch would
        // be silently dropped, so the toast carries the outcome instead.
        if (hasJobPanel.current) {
          dispatch({
            type: 'enhance/event',
            event: { phase: 'failed', code: appError.code, message: appError.message },
          })
        } else {
          notify('error', appError.message)
        }
      } finally {
        running.current = false
        inFlight.current = null
        abandoned.current = false
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
