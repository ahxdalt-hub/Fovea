import { useEffect } from 'react'
import {
  getConfig,
  getLicenseStatus,
  getSystemInfo,
  setEngineHints,
  writeFrontendLog,
} from '../ipc/bridge'
import { toAppError } from '../types/ipc'
import { hasRepairs, planRepairs, planView } from '../lib/entitlements'
import { toEngineHints } from './settings'
import { useAppState } from './useAppState'
import { useSettings } from './useSettings'

/**
 * Startup orchestration: verify the native core is reachable and hand the
 * result to app state. This is the sanity pass for the UI → command →
 * service pipeline and the hook where Stage 02+ features attach readiness.
 */
export function useCoreBootstrap() {
  const { state, dispatch } = useAppState()
  const { update } = useSettings()
  const settings = state.settings
  const license = state.license

  useEffect(() => {
    if (state.coreStatus !== 'connecting') return
    let cancelled = false

    async function boot() {
      try {
        const config = await getConfig()
        const systemInfo = await getSystemInfo()
        if (cancelled) return
        writeFrontendLog('info', 'frontend connected to native core')
        dispatch({ type: 'core/ready', config, systemInfo })
      } catch (error) {
        if (cancelled) return
        const appError = toAppError(error)
        writeFrontendLog('error', `core bootstrap failed: ${appError.code}`)
        dispatch({ type: 'core/error', error: appError })
      }
    }

    void boot()
    return () => {
      cancelled = true
    }
  }, [state.coreStatus, dispatch])

  // Stage 20: the plan in force, read once per session. Every surface that
  // offers a paid option draws it from this one record, and activation
  // replaces it in place. A read that fails leaves the plan *unknown* —
  // nothing is locked and nothing is repaired — because an unreadable license
  // must never grey out an app whose images still process fine. Native stays
  // the one that decides what actually runs.
  useEffect(() => {
    if (
      state.coreStatus !== 'ready' ||
      state.license !== null ||
      state.licenseStatus !== 'loading'
    ) {
      return
    }
    let cancelled = false
    getLicenseStatus()
      .then((status) => {
        if (!cancelled) dispatch({ type: 'license/set', status })
      })
      .catch((error) => {
        if (cancelled) return
        writeFrontendLog('warn', `license status unreadable: ${toAppError(error).code}`)
        dispatch({ type: 'license/error' })
      })
    return () => {
      cancelled = true
    }
  }, [state.coreStatus, state.license, state.licenseStatus, dispatch])

  // Stage 10: mirror the engine-relevant preferences to the native side
  // whenever the core is ready and the record changes. At boot this
  // re-asserts what the persisted file already says (self-healing a
  // mirror whose write failed in a previous session, before any job can
  // run); afterwards `useSettings` has typically already sent it — the
  // repeat send is a no-op the engine doesn't notice.
  useEffect(() => {
    if (state.coreStatus !== 'ready') return
    // A stored hardware switch the plan in force cannot turn is repaired
    // before it is mirrored: `update` persists the healed record and sends
    // its hints, so Settings, localStorage and the engine agree on the path
    // that is actually running. Native clamps its own copy at startup for
    // the case where this window never opened.
    const repairs = planRepairs(planView(license), settings)
    if (hasRepairs(repairs)) {
      if (Object.keys(repairs.processing).length > 0) update('processing', repairs.processing)
      if (Object.keys(repairs.performance).length > 0) update('performance', repairs.performance)
      return
    }
    try {
      void Promise.resolve(setEngineHints(toEngineHints(settings))).catch(() => {
        // A failed mirror retries on the next change; defaults stand.
      })
    } catch {
      // Mocked/offline bridge — nothing to mirror to.
    }
  }, [state.coreStatus, settings, license, update])

  return state
}
