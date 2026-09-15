/** Read the shared application state. Throws outside the provider. */
import { useContext } from 'react'
import { AppStateContext } from './appStateContext'

export function useAppState() {
  const ctx = useContext(AppStateContext)
  if (!ctx) throw new Error('useAppState must be used inside <AppStateProvider>')
  return ctx
}
