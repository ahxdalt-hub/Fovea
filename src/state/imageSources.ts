/**
 * Image source cache — who holds which representation of an imported file.
 *
 * The viewer must never keep giant pixel data in React state or fetch the
 * same file twice when the user clicks away and back. This module is the
 * single owner of loaded `ImageViewDto`s, keyed by the image's canonical
 * id, with in-flight promise deduplication:
 *
 * - `view` — display-size rendering (native default, ~2600 px longest
 *   edge, or the pristine file when smaller). Fetched on first open.
 * - `full` — the true-resolution file, fetched lazily only when the user
 *   has zoomed past what the view can render sharply. Stage 05+ can add
 *   tiers here without touching the UI.
 *
 * Outside the Tauri runtime (browser preview, tests) the native call
 * fails and loads resolve to `null` — callers fall back to the small
 * preview that rides along with `ImportedImageDto`.
 */
import type { ImageViewDto } from '../types/ipc'
import { toAppError } from '../types/ipc'
import { loadImageView, writeFrontendLog } from '../ipc/bridge'

export type SourceKind = 'view' | 'full'

interface Entry {
  view?: ImageViewDto
  full?: ImageViewDto
  loading?: Map<SourceKind, Promise<ImageViewDto | null>>
}

const cache = new Map<string, Entry>()

function entry(id: string): Entry {
  let e = cache.get(id)
  if (!e) {
    e = {}
    cache.set(id, e)
  }
  return e
}

/** Cached source without triggering a load. */
export function peekSource(id: string, kind: SourceKind): ImageViewDto | null {
  const e = cache.get(id)
  if (!e) return null
  return kind === 'view' ? (e.view ?? null) : (e.full ?? null)
}

/** Dev-QA only: inject a synthetic source so the browser preview of the
 * workspace has real display-size pixels to inspect. Never in release —
 * the sole caller is gated by import.meta.env.DEV. */
export function seedSourceCache(id: string, kind: SourceKind, view: ImageViewDto): void {
  const e = entry(id)
  if (kind === 'view') e.view = view
  else e.full = view
}

/**
 * Load one representation, hitting the cache first and deduping
 * concurrent requests. Resolves `null` when the native core cannot
 * serve it (non-Tauri runtime, deleted file) — never throws, so the
 * viewer can fall back silently to the small preview.
 */
export function loadImageSource(
  id: string,
  kind: SourceKind,
  natural: { width: number; height: number },
): Promise<ImageViewDto | null> {
  const e = entry(id)
  const cached = kind === 'view' ? e.view : e.full
  if (cached) return Promise.resolve(cached)
  if (!e.loading) e.loading = new Map()
  const inflight = e.loading.get(kind)
  if (inflight) return inflight

  const maxEdge = kind === 'full' ? Math.max(natural.width, natural.height) : undefined
  const promise = loadImageView(id, maxEdge)
    .then((view) => {
      if (kind === 'view') e.view = view
      else e.full = view
      // Diagnostic (no paths, no pixels): confirms which tier the core served.
      writeFrontendLog(
        'debug',
        `image ${kind} served: edge=${view.deliveredEdge} original=${view.original}`,
      )
      return view
    })
    .catch((error) => {
      // Honest fallback: caller keeps the preview source. Log only the
      // safe code — never paths, never image data.
      writeFrontendLog('warn', `image ${kind} load failed: ${toAppError(error).code}`)
      return null
    })
    .finally(() => {
      e.loading?.delete(kind)
    })
  e.loading.set(kind, promise)
  return promise
}

/** Drop everything the user cleared from the collection. Test/dev helper. */
export function clearSourceCache(): void {
  cache.clear()
}

/**
 * Stage 12 memory discipline: evict every cached representation whose id
 * is no longer in the collection. Called by the shell whenever the
 * collection changes — a removed image's display (and, once zoomed, its
 * full-resolution) pixels leave the session instead of living forever.
 */
export function pruneSources(keepIds: readonly string[]): void {
  const keep = new Set(keepIds)
  for (const id of [...cache.keys()]) {
    if (!keep.has(id)) cache.delete(id)
  }
}

/**
 * Invalidate cached representations of re-imported ids. A file can change
 * on disk between two imports of the same canonical path; a stale display
 * view would silently show yesterday's pixels, so a re-import costs a
 * refetch.
 */
export function invalidateSources(ids: readonly string[]): void {
  for (const id of ids) cache.delete(id)
}
