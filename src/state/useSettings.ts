/**
 * The settings write path (Stage 10) — one place every preference change
 * funnels through:
 *
 *   validate (patchSettings normalizes) → dispatch (UI sees it) →
 *   writeSettings (localStorage, survives restarts) →
 *   setEngineHints (native mirror for what the engine honours).
 *
 * Components call `update('export', { format: 'jpeg' })` and never think
 * about storage; the reducer case and the disk can never disagree because
 * both derive from the same normalized record.
 */
import { useCallback } from 'react'
import { setEngineHints } from '../ipc/bridge'
import { useAppState } from './useAppState'
import { patchSettings, toEngineHints, writeSettings, type FoveaSettings } from './settings'

export interface SettingsApi {
  settings: FoveaSettings
  /** Patch one group; returns the full next record (already persisted). */
  update: <K extends keyof FoveaSettings>(
    group: K,
    patch: Partial<FoveaSettings[K]>,
  ) => FoveaSettings
}

export function useSettings(): SettingsApi {
  const { state, dispatch } = useAppState()

  const update = useCallback<SettingsApi['update']>(
    (group, patch) => {
      const next = patchSettings(state.settings, group, patch)
      dispatch({ type: 'settings/set', settings: next })
      writeSettings(next)
      // The engine-relevant projection rides along; a failed mirror must
      // never undo a preference the user just made (the next change or
      // startup retries it). Defensive against mocked bridges that
      // return non-promises: the promise shape is the IPC layer's
      // concern, not this one's.
      try {
        void Promise.resolve(setEngineHints(toEngineHints(next))).catch(() => {
          // Intentionally silent — see above.
        })
      } catch {
        // Same.
      }
      return next
    },
    [state.settings, dispatch],
  )

  return { settings: state.settings, update }
}
