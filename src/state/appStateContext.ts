/**
 * The raw context object, kept component-free so it can be imported from
 * both the provider and the accessor hook without breaking fast refresh.
 */
import { createContext } from 'react'
import type { AppAction, AppState } from './appReducer'

export const AppStateContext = createContext<{
  state: AppState
  dispatch: React.Dispatch<AppAction>
} | null>(null)
