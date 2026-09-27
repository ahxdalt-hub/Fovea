/**
 * Recent files (Stage 09) — the short "pick up where you left off" list
 * on a cold Enhance start.
 *
 * A thin reader over the shared `history` slice (see `useHistory`): the
 * native store already dedupes, existence-checks and prunes dead
 * pointers at read time, so the reopen affordances this feeds always
 * point at files that are actually there. When `active` (the collection
 * is empty), it makes sure a fresh read has happened; the sync is via
 * dispatch, matching every other native read in the app.
 */
import { useEffect } from 'react'
import type { RecentFileDto } from '../types/ipc'
import { useAppState } from './useAppState'
import { useHistory } from './useHistory'

export interface RecentsApi {
  recents: RecentFileDto[]
}

export function useRecentFiles(active: boolean): RecentsApi {
  const { state } = useAppState()
  const { status, load } = useHistory()

  // Load once, and only while the empty-state actually needs the list.
  useEffect(() => {
    if (active && status === 'idle') void load()
  }, [active, status, load])

  return { recents: state.history?.recents ?? [] }
}
