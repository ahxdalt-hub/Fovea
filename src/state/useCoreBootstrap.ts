import { useEffect } from 'react'
import { getConfig, getSystemInfo, writeFrontendLog } from '../ipc/bridge'
import { toAppError } from '../types/ipc'
import { useAppState } from './useAppState'

/**
 * Startup orchestration: verify the native core is reachable and hand the
 * result to app state. This is the sanity pass for the UI → command →
 * service pipeline and the hook where Stage 02+ features attach readiness.
 */
export function useCoreBootstrap() {
  const { state, dispatch } = useAppState()

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

  return state
}
