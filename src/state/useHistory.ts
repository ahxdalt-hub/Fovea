/**
 * Shared history access (Stage 09) — the one funnel every view uses to
 * read or reset the native journal.
 *
 * History state lives in the app reducer (not local component state) so
 * the History view and the cold-start "recent files" row read the *same*
 * snapshot, and — like every other native read here (config, inference
 * status) — loading it happens through `dispatch` inside an effect, never
 * a `setState` call that would cascade renders. The native store is the
 * source of truth; this hook just mirrors a fresh read into app state.
 */
import { useCallback } from 'react'
import { clearHistory, getHistory } from '../ipc/bridge'
import { toAppError } from '../types/ipc'
import { useAppState } from './useAppState'
import { useNotify } from '../ui/notificationContext'

export interface HistoryApi {
  /** Whether the journal has been read this session (drives auto-load). */
  loaded: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** Re-read the journal + recents from the native store. */
  load: () => Promise<void>
  /** Wipe the journal + recents (files on disk are never touched). */
  clear: () => Promise<void>
}

export function useHistory(): HistoryApi {
  const { state, dispatch } = useAppState()
  const { notify } = useNotify()

  const load = useCallback(async () => {
    dispatch({ type: 'history/loading' })
    try {
      const snapshot = await getHistory()
      dispatch({ type: 'history/loaded', snapshot })
    } catch (error) {
      dispatch({ type: 'history/error', message: toAppError(error).message })
    }
  }, [dispatch])

  const clear = useCallback(async () => {
    dispatch({ type: 'history/loading' })
    try {
      await clearHistory()
      dispatch({ type: 'history/loaded', snapshot: { entries: [], recents: [] } })
      notify('info', 'History cleared. Your files on disk were not touched.')
    } catch (error) {
      dispatch({ type: 'history/error', message: toAppError(error).message })
    }
  }, [dispatch, notify])

  return {
    loaded: state.history !== null || state.historyStatus !== 'idle',
    status: state.historyStatus,
    error: state.historyError,
    load,
    clear,
  }
}
