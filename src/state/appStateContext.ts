/**
 * The raw context object, kept component-free so it can be imported from
 * both the provider and the accessor hook without breaking fast refresh.
 */
import { createContext, type Dispatch } from 'react'
import type { AppAction, AppState } from './appReducer'

export const AppStateContext = createContext<{
  state: AppState
  dispatch: Dispatch<AppAction>
} | null>(null)
