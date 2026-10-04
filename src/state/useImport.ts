/**
 * Import orchestration — the single funnel every import source runs
 * through (native file picker, native drag & drop, later the batch view).
 *
 * Responsibilities:
 * - run the native validation/import over IPC
 * - dispatch results into the imported-image collection (dedup lives in
 *   the reducer, keyed by canonical path)
 * - translate per-file failures into user-safe notifications — the files
 *   that passed still import, so one bad drop never blocks the batch
 * - switch to the Enhance view so a drop "transitions naturally into the
 *   image workspace"
 */
import { useCallback, useRef } from 'react'
import { importImages, pickImageFiles } from '../ipc/bridge'
import { isImportOutcome, toAppError } from '../types/ipc'
import { useAppState } from './useAppState'
import { useNotify } from '../ui/notificationContext'
import { formatBytes } from '../lib/format'
import { invalidateSources } from './imageSources'

/** Guard the untrusted IPC boundary at runtime, once per import. */
function readOutcomes(raw: unknown) {
  const outcomes = Array.isArray(raw) ? raw.filter(isImportOutcome) : []
  const images = outcomes.flatMap((o) => (o.status === 'imported' ? [o.image] : []))
  const failures = outcomes.flatMap((o) =>
    o.status === 'failed' ? [{ name: o.name, message: o.error.message }] : [],
  )
  return { images, failures }
}

export interface ImportApi {
  /** True while an import batch is being validated natively. */
  importing: boolean
  /** Open the native image picker. */
  browse: () => Promise<void>
  /** Import a batch of paths (drag & drop payloads). */
  dropPaths: (paths: string[]) => Promise<void>
  removeImage: (id: string) => void
  clearImages: () => void
}

export function useImport(): ImportApi {
  const { state, dispatch } = useAppState()
  const { notify } = useNotify()
  const busy = useRef(false)

  const runImport = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return
      // Native drag & drop has no busy state of its own: without this word
      // a second drop during a large import simply does nothing, and the
      // user has no way to know their files were even seen.
      if (busy.current) {
        notify('info', 'Still checking the files you dropped earlier — try again in a moment')
        return
      }
      busy.current = true
      dispatch({ type: 'import/start' })
      dispatch({ type: 'ui/navigate', view: 'enhance' })
      try {
        const raw = await importImages(paths)
        const { images, failures } = readOutcomes(raw)
        // A re-imported file may have changed on disk since the last
        // import — its cached display view would silently show stale
        // pixels. Every import invalidates its ids' cached sources.
        invalidateSources(images.map((img) => img.id))
        // Count distinct ids: a duplicate path in one drop dedupes to one
        // collection entry, so the toast must not count it twice.
        const known = new Set(state.images.map((existing) => existing.id))
        const newCount = new Set(images.filter((img) => !known.has(img.id)).map((img) => img.id))
          .size
        if (images.length > 0) dispatch({ type: 'images/add', images })

        // A large bad drop would flood the (capped) toast queue — the
        // first few failures name their files, the rest summarize.
        const head = failures.slice(0, 3)
        for (const f of head) {
          notify('warning', `${f.name} — ${f.message}`)
        }
        if (failures.length > head.length) {
          const rest = failures.length - head.length
          notify('warning', `${rest} more file${rest === 1 ? '' : 's'} could not be imported`)
        }
        if (newCount > 0) {
          const label = newCount === 1 ? '1 image' : `${newCount} images`
          notify('success', `Imported ${label} · stored locally, nothing uploaded`)
        } else if (failures.length === 0 && images.length > 0) {
          notify('info', 'Those images are already in your workspace')
        } else if (failures.length === 0) {
          notify('warning', 'No images found in that selection')
        }
      } catch (error) {
        const appError = toAppError(error)
        notify('error', appError.message)
      } finally {
        busy.current = false
        dispatch({ type: 'import/end' })
      }
    },
    [dispatch, notify, state.images],
  )

  const browse = useCallback(async () => {
    if (busy.current) return
    try {
      const paths = await pickImageFiles()
      await runImport(paths)
    } catch (error) {
      // A canceled or failed dialog must not look like a data problem.
      const appError = toAppError(error)
      notify('error', appError.message)
    }
  }, [notify, runImport])

  const dropPaths = useCallback(
    async (paths: string[]) => {
      await runImport(paths)
    },
    [runImport],
  )

  const removeImage = useCallback(
    (id: string) => {
      dispatch({ type: 'images/remove', id })
    },
    [dispatch],
  )

  const clearImages = useCallback(() => dispatch({ type: 'images/clear' }), [dispatch])

  return { importing: state.importing, browse, dropPaths, removeImage, clearImages }
}

/** Summary line for the collection header, e.g. "3 images · 12.4 MB". */
export function collectionSummary(images: { sizeBytes: number }[]): string {
  const total = images.reduce((sum, img) => sum + img.sizeBytes, 0)
  return `${images.length} ${images.length === 1 ? 'image' : 'images'} · ${formatBytes(total)}`
}
