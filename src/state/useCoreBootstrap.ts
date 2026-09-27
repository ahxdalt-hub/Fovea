import { useEffect } from 'react'
import { getConfig, getSystemInfo, setEngineHints, writeFrontendLog } from '../ipc/bridge'
import { toAppError } from '../types/ipc'
import { toEngineHints } from './settings'
import { useAppState } from './useAppState'

/**
 * Startup orchestration: verify the native core is reachable and hand the
 * result to app state. This is the sanity pass for the UI → command →
 * service pipeline and the hook where Stage 02+ features attach readiness.
 */
export function useCoreBootstrap() {
  const { state, dispatch } = useAppState()
  const settings = state.settings

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

  // Stage 10: mirror the engine-relevant preferences to the native side
  // whenever the core is ready and the record changes. At boot this
  // re-asserts what the persisted file already says (self-healing a
  // mirror whose write failed in a previous session, before any job can
  // run); afterwards `useSettings` has typically already sent it — the
  // repeat send is a no-op the engine doesn't notice.
  useEffect(() => {
    if (state.coreStatus !== 'ready') return
    try {
      void Promise.resolve(setEngineHints(toEngineHints(settings))).catch(() => {
        // A failed mirror retries on the next change; defaults stand.
      })
    } catch {
      // Mocked/offline bridge — nothing to mirror to.
    }
  }, [state.coreStatus, settings])

  return state
}
