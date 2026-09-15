/**
 * Application state — types and pure reducer.
 *
 * Stage 01 deliberately avoids a state library: one context + reducer is
 * enough for startup status. The shape here (typed actions, single pure
 * reducer) is what later feature stores will follow.
 */
import type { AppConfigDto, AppErrorPayload, SystemInfoDto } from '../types/ipc'

/** Native connection lifecycle. */
export type CoreStatus = 'connecting' | 'ready' | 'error'

export interface AppState {
  coreStatus: CoreStatus
  config: AppConfigDto | null
  systemInfo: SystemInfoDto | null
  /** Last error surfaced from the native layer, already user-safe. */
  error: AppErrorPayload | null
}

export type AppAction =
  | { type: 'core/connecting' }
  | { type: 'core/ready'; config: AppConfigDto; systemInfo: SystemInfoDto }
  | { type: 'core/error'; error: AppErrorPayload }

export const initialState: AppState = {
  coreStatus: 'connecting',
  config: null,
  systemInfo: null,
  error: null,
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'core/connecting':
      return { ...state, coreStatus: 'connecting', error: null }
    case 'core/ready':
      return {
        ...state,
        coreStatus: 'ready',
        config: action.config,
        systemInfo: action.systemInfo,
        error: null,
      }
    case 'core/error':
      return { ...state, coreStatus: 'error', error: action.error }
  }
}
