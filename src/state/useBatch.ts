/**
 * Batch orchestration (Stage 08 queue, wired for Stage 09) — the single
 * funnel for queueing many images through the one-at-a-time engine.
 *
 * Contract mirrors `useEnhance`: run the native queue over IPC, fold the
 * streamed per-item events into app state (`batch/event`, reconciled by
 * the reducer with terminal-state protection), surface terminal
 * outcomes as notifications, and expose cancel/retry. The reducer's
 * snapshot is the source of truth — this hook never invents progress;
 * completed-tile counts arrive from native exactly as for a single job.
 *
 * A batch shares the engine's single job slot with a manual Enhance
 * (the Stage 07 memory budget is sized for one session), so starting one
 * while a job runs is refused honestly by the native layer — surfaced,
 * not swallowed.
 */
import { useCallback, useRef, useState } from 'react'
import {
  cancelBatchAll,
  cancelBatchItem,
  getBatchSnapshot,
  retryBatchFailed,
  startBatch,
} from '../ipc/bridge'
import { toAppError } from '../types/ipc'
import type { BatchConfigPayload, BatchItemPayload } from '../types/ipc'
import { useAppState } from './useAppState'
import { useNotify } from '../ui/notificationContext'

export interface BatchApi {
  /** True while a batch is in flight (drives the button + Cancel affordances). */
  running: boolean
  /** Start a batch; resolves once the queue is accepted and streaming. */
  start: (items: BatchItemPayload[], output: BatchConfigPayload) => Promise<void>
  /** Ask the native queue to stop one item. */
  cancelItem: (itemId: string) => Promise<void>
  /** Ask the native queue to stop every item (results already written stay). */
  cancelAll: () => Promise<void>
  /** Re-queue failed/cancelled items as fresh runs. */
  retryFailed: () => Promise<void>
  /** Dismiss a finished batch's queue panel. */
  dismiss: () => void
  /** Re-sync the queue from native (late subscribers, re-entry). */
  refresh: () => Promise<void>
}

export function useBatch(): BatchApi {
  const { state, dispatch } = useAppState()
  const { notify } = useNotify()
  const [starting, setStarting] = useState(false)
  const busy = useRef(false)

  const running =
    starting || (state.batch?.running ?? false) || (state.batch?.items.some(isActive) ?? false)

  const start = useCallback(
    async (items: BatchItemPayload[], output: BatchConfigPayload) => {
      if (busy.current || items.length === 0) return
      busy.current = true
      setStarting(true)
      // Move the busy job's live panel aside so the batch is the focus.
      dispatch({ type: 'enhance/clear' })
      try {
        const snapshot = await startBatch(items, output, (event) =>
          dispatch({ type: 'batch/event', event }),
        )
        dispatch({ type: 'batch/snapshot', snapshot })
      } catch (error) {
        notify('error', toAppError(error).message)
      } finally {
        busy.current = false
        setStarting(false)
      }
    },
    [dispatch, notify],
  )

  const cancelItem = useCallback(
    async (itemId: string) => {
      // The UI marks the item cancelling optimistically? No — honest:
      // the native terminal event is the only thing that flips state.
      try {
        await cancelBatchItem(itemId)
      } catch (error) {
        notify('warning', toAppError(error).message)
      }
    },
    [notify],
  )

  const cancelAll = useCallback(async () => {
    try {
      await cancelBatchAll()
      notify('info', 'Stopping the batch — finished results are kept.')
    } catch (error) {
      notify('warning', toAppError(error).message)
    }
  }, [notify])

  const retryFailed = useCallback(async () => {
    try {
      const snapshot = await retryBatchFailed()
      if (snapshot) dispatch({ type: 'batch/snapshot', snapshot })
    } catch (error) {
      notify('warning', toAppError(error).message)
    }
  }, [dispatch, notify])

  const dismiss = useCallback(() => dispatch({ type: 'batch/clear' }), [dispatch])

  const refresh = useCallback(async () => {
    try {
      const snapshot = await getBatchSnapshot()
      if (snapshot) dispatch({ type: 'batch/snapshot', snapshot })
    } catch {
      // A missing snapshot just means no batch has run — leave state as is.
    }
  }, [dispatch])

  return { running, start, cancelItem, cancelAll, retryFailed, dismiss, refresh }
}

/** Is this item's work still pending or in flight? */
function isActive(item: { state: string }): boolean {
  return item.state === 'waiting' || item.state === 'processing'
}
