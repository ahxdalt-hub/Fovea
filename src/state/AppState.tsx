/**
 * Provider component for app state. State shape and reducer logic live in
 * `appReducer.ts`; read it from components via `useAppState`.
 */
import { useReducer, type ReactNode } from 'react'
import { AppStateContext } from './appStateContext'
import { appReducer, initialState } from './appReducer'

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState)
  return <AppStateContext.Provider value={{ state, dispatch }}>{children}</AppStateContext.Provider>
}
