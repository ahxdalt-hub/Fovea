/**
 * ImageWorkspace — Fovea's central viewing surface (Stage 04).
 *
 * The image owns the screen; everything else is calm overlay:
 * an info chip (top-left), a compact toolbar (bottom-center), and
 * fullscreen chrome that fades while idle.
 *
 * View model: `src/lib/viewer.ts` — fit/zoom/pan are pure affine math
 * applied as one CSS transform on a natural-size layer. In fit mode the
 * view is *derived* (recomputed during render from stage size — resizing
 * the window keeps the image fitted with zero extra renders); only custom
 * zoom/pan is stored state. The browser composites that transform on the
 * GPU, so motion stays smooth even for very large files: React never
 * touches image pixels.
 *
 * Resolution policy (the performance contract):
 * - `previewDataUrl` (small, always present) paints immediately.
 * - The native core then serves a display-sized view (or the pristine
 *   file when it already fits). Sources are cached in `imageSources.ts`
 *   — never refetched, never duplicated; a cache hit renders with no
 *   loading state at all.
 * - Full-resolution bytes are requested *only* when a user zoom pushes
 *   past what the view can render sharply, and the swap crossfades
 *   underneath the cursor instead of popping.
 *
 * Comparison: `CompareSplit` receives the enhanced result when one
 * exists (Stage 05's engine will produce it). Until then the after side
 * is an honest pending panel — the interaction is real, the pixels are
 * not invented.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { ImageEnhancementDto, ImageViewDto, ImportedImageDto } from '../types/ipc'
import { IconButton } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'
import { Spinner } from '../ui/Progress'
import { Menu } from '../ui/Menu'
import {
  IconClose,
  IconCollapse,
  IconCompare,
  IconExpand,
  IconFit,
  IconImport,
  IconMore,
  IconZoomIn,
  IconZoomOut,
} from '../ui/Icons'
import { useElementSize } from '../hooks/useElementSize'
import { isTauriRuntime } from '../state/useNativeFileDrop'
import { peekSource, loadImageSource } from '../state/imageSources'
import { CrossfadeImage } from './CrossfadeImage'
import { CompareSplit } from './CompareSplit'
import {
  clampView,
  fitView,
  formatZoom,
  isFitted,
  panView,
  scaleView,
  wheelFactor,
  zoomView,
  type View,
} from '../lib/viewer'
import { formatBytes, formatDimensions } from '../lib/format'
import './ImageWorkspace.css'

export interface ImageWorkspaceProps {
  image: ImportedImageDto
  /** Enhanced counterpart when one exists — the Stage 05/06 engine fills this. */
  enhanced: ImageEnhancementDto | null
  onAddMore: () => void
  onClear: () => void
  /** Stage 06: incrementing nonce — each change asks the viewer to enter
   * compare mode (set when an enhancement for *this* image completes, and
   * by the completion CTA). Keyed by image, so a mount never replays. */
  openCompareNonce?: number
}

type Mode = 'single' | 'compare'

/** Button-zoom step (toolbar + keyboard). */
const STEP = 1.25
/** Idle time before fullscreen chrome fades. */
const IDLE_MS = 2600
const IDENTITY: View = { scale: 1, x: 0, y: 0 }

/** Where a delivered source runs out of real pixels (≥1.0 = lossless). */
function qualityOf(source: ImageViewDto | null): number {
  if (!source) return 0
  if (source.original) return Infinity
  return source.deliveredEdge / Math.max(source.width, source.height)
}

export function ImageWorkspace({
  image,
  enhanced,
  onAddMore,
  onClear,
  openCompareNonce = 0,
}: ImageWorkspaceProps) {
  const natural = useMemo(
    () => ({ width: image.width, height: image.height }),
    [image.width, image.height],
  )

  const stageRef = useRef<HTMLDivElement | null>(null)
  const [stageAttach, stage] = useElementSize()
  // One stable ref callback: React only detaches on unmount, so the
  // ResizeObserver survives every view/zoom render.
  const attachStage = useCallback(
    (node: HTMLDivElement | null) => {
      stageRef.current = node
      stageAttach(node)
    },
    [stageAttach],
  )

  const [custom, setCustom] = useState<View>(IDENTITY)
  const [fitMode, setFitMode] = useState(true)
  const [mode, setMode] = useState<Mode>('single')
  const [panning, setPanning] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [idle, setIdle] = useState(false)

  // Stage 06: enter compare mode the moment an enhancement result lands
  // for this image (the result must be immediately understandable), and
  // on explicit requests from the completion CTA (`openCompareNonce`).
  // This is React's "adjusting state during a render" pattern — derived
  // from the props it reacts to, not an effect firing afterwards. Mount
  // initial state equals the props, so replaying a stored result on an
  // image switch never forces compare.
  const [seen, setSeen] = useState({ enhanced, nonce: openCompareNonce })
  if (seen.enhanced !== enhanced) {
    setSeen({ enhanced, nonce: openCompareNonce })
    if (enhanced) setMode('compare')
  } else if (seen.nonce !== openCompareNonce) {
    setSeen({ enhanced, nonce: openCompareNonce })
    setMode('compare')
  }

  // ── Source tiers: preview → view → full (lazy escalation) ──────────
  // The cache is consulted during render (a plain map read): a warm hit
  // renders instantly with no loading state. Only a cold miss fetches,
  // and the fetch writes state from its promise — never synchronously.
  const [asyncView, setAsyncView] = useState<ImageViewDto | null>(null)
  const [asyncFull, setAsyncFull] = useState<ImageViewDto | null>(null)
  const [fullLoading, setFullLoading] = useState(false)
  const fullRequested = useRef(false)
  // Stage 12: a failed view fetch resolves null (the source cache never
  // throws), so without this flag the "Reading full image…" chip would
  // spin forever. A fetch failure is a state, not an eternal loading lie.
  const [viewFailed, setViewFailed] = useState(false)

  const cachedView = peekSource(image.id, 'view')
  const cachedFull = peekSource(image.id, 'full')
  const viewDto = cachedView ?? asyncView
  const fullDto = cachedFull ?? asyncFull
  // Reset per-image memory when the id changes (the shell also remounts
  // via key, but rerendered tests must not inherit stale tiers).
  const lastImageId = useRef(image.id)
  if (lastImageId.current !== image.id) {
    lastImageId.current = image.id
    fullRequested.current = false
    // Render-phase state adjustment for a changed prop — the React-endorsed
    // way to reset state without an effect (and without lint friction).
    setViewFailed(false)
  }

  useEffect(() => {
    if (cachedView) return // warm cache: nothing to do
    if (!isTauriRuntime()) return // browser preview keeps the small fallback
    let cancelled = false
    void loadImageSource(image.id, 'view', natural).then((v) => {
      if (cancelled) return
      // A null result (native refused) shows the honest failure chip; the
      // preview underneath keeps the workspace usable either way.
      if (v) setAsyncView(v)
      else setViewFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [cachedView, image.id, natural])

  /** Kick the full-res fetch once, when a zoom would exceed view sharpness. */
  const escalate = useCallback(
    (nextView: View) => {
      if (fullRequested.current || !isTauriRuntime()) return
      const q = qualityOf(peekSource(image.id, 'view') ?? asyncView)
      if (Number.isFinite(q) && nextView.scale > q * 1.02) {
        fullRequested.current = true
        setFullLoading(true)
        void loadImageSource(image.id, 'full', natural)
          .then((f) => {
            if (f) setAsyncFull(f)
            // A failed escalation stays retryable: the user can zoom out
            // and back in without losing 1:1 detail for the session.
            else fullRequested.current = false
          })
          .finally(() => setFullLoading(false))
      }
    },
    [image.id, natural, asyncView],
  )

  // ── The applied view: fit is derived; custom is clamped per frame ──
  const fitCandidate = fitView(natural, stage)
  const view: View = fitMode ? (fitCandidate ?? IDENTITY) : clampView(custom, natural, stage)
  const fitted = fitMode || isFitted(view, natural, stage)

  const shownSrc =
    (fullDto && view.scale > qualityOf(viewDto) * 1.02 ? fullDto.dataUrl : null) ??
    viewDto?.dataUrl ??
    image.previewDataUrl

  // Keep the wheel handler (native, registered once) looking at the
  // latest render values without re-subscribing on every zoom frame.
  const liveRef = useRef({ view, natural, stage, fitMode })
  useEffect(() => {
    liveRef.current = { view, natural, stage, fitMode }
  })

  // ── Interactions: one functional update path for every view change ─
  const applyView = useCallback(
    (fn: (v: View) => View) => {
      const { view: current, natural: nat, stage: st } = liveRef.current
      const next = clampView(fn(current), nat, st)
      setFitMode(false)
      setCustom(next)
      escalate(next)
    },
    [escalate],
  )

  const applyFit = useCallback(() => {
    setFitMode(true)
    const next = fitView(natural, stage)
    if (next) setCustom(next)
  }, [natural, stage])

  // Wheel zoom needs non-passive registration (React's onWheel is
  // passive at the root, so preventDefault there is ignored). The
  // handler is registered once; it reads current geometry from liveRef.
  useEffect(() => {
    const node = stageRef.current
    if (!node) return
    function onWheel(event: WheelEvent) {
      event.preventDefault()
      const rect = node?.getBoundingClientRect()
      if (!rect) return
      const { natural: nat, stage: st } = liveRef.current
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      applyView((v) => zoomView(v, wheelFactor(event.deltaY), anchor, nat, st))
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [applyView])

  // ── Pan: pointer capture, one transform update per gesture frame ───
  const dragRef = useRef<{ id: number; lastX: number; lastY: number } | null>(null)
  function onStagePointerDown(event: ReactPointerEvent) {
    if (event.button !== 0) return
    // Only pan from the stage/layer, never from chrome or the slider.
    const target = event.target as HTMLElement
    if (target.closest('.pix-ws__chrome') || target.closest('.pix-compare__handle')) return
    dragRef.current = { id: event.pointerId, lastX: event.clientX, lastY: event.clientY }
    const node = stageRef.current
    if (node && typeof node.setPointerCapture === 'function') {
      node.setPointerCapture(event.pointerId)
    }
    setPanning(true)
  }
  function onStagePointerMove(event: ReactPointerEvent) {
    const drag = dragRef.current
    if (!drag || drag.id !== event.pointerId) return
    const dx = event.clientX - drag.lastX
    const dy = event.clientY - drag.lastY
    drag.lastX = event.clientX
    drag.lastY = event.clientY
    applyView((v) => panView(v, dx, dy, natural, stage))
  }
  function onStagePointerUp(event: ReactPointerEvent) {
    if (dragRef.current?.id !== event.pointerId) return
    dragRef.current = null
    setPanning(false)
  }

  function onDoubleClick(event: ReactMouseEvent) {
    const target = event.target as HTMLElement
    if (target.closest('.pix-ws__chrome') || target.closest('.pix-compare__handle')) return
    if (fitted) applyView((v) => scaleView(v, 1, natural, stage))
    else applyFit()
  }

  // ── Keyboard: viewer-scoped keys, stopPropagation so the shell's
  //    1/2/3 navigation doesn't fire while inspecting an image ────────
  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    let handled = true
    switch (event.key) {
      case '+':
      case '=':
        applyView((v) => scaleView(v, v.scale * STEP, natural, stage))
        break
      case '-':
      case '_':
        applyView((v) => scaleView(v, v.scale / STEP, natural, stage))
        break
      case '0':
        applyFit()
        break
      case '1':
        applyView((v) => scaleView(v, 1, natural, stage))
        break
      case 'f':
      case 'F':
        void toggleFullscreen()
        break
      case 'c':
      case 'C':
        setMode((m) => (m === 'single' ? 'compare' : 'single'))
        break
      case 'Escape':
        if (mode === 'compare' && !fullscreen) setMode('single')
        else handled = false
        break
      default:
        handled = false
    }
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // ── Fullscreen: the workspace element itself, chrome fades on idle ─
  async function toggleFullscreen() {
    const node = stageRef.current?.closest('.pix-ws') as HTMLElement | null
    if (!node) return
    if (typeof document.exitFullscreen === 'function' && document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {})
    } else if (typeof node.requestFullscreen === 'function') {
      await node.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
    }
  }
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement != null)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  useEffect(() => {
    if (!fullscreen) return
    let timer: ReturnType<typeof setTimeout>
    const wake = () => {
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), IDLE_MS)
    }
    window.addEventListener('pointermove', wake)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointermove', wake)
    }
  }, [fullscreen])

  // ── Render ──────────────────────────────────────────────────────────
  const layerStyle = {
    width: natural.width,
    height: natural.height,
    transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
  } as const
  const zoomLabel = formatZoom(view.scale)
  // `preparing` means the display view is still on its way; `viewFailed`
  // means it never arrived — the chip then names the failure instead of
  // spinning forever (Stage 12: no eternal loading lie).
  const preparing = !viewDto && isTauriRuntime() && !viewFailed

  return (
    <section
      className={[
        'pix-ws',
        fullscreen && 'pix-ws--fullscreen',
        fullscreen && idle && 'pix-ws--idle',
        panning && 'pix-ws--panning',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={`Image workspace — ${image.name}`}
    >
      <div
        ref={attachStage}
        className="pix-ws__stage"
        tabIndex={0}
        autoFocus
        role="group"
        aria-roledescription="zoomable image viewer"
        aria-label={`${image.name}, ${formatDimensions(image.width, image.height)} pixels`}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
      >
        <div className="pix-ws__layer" style={layerStyle}>
          {mode === 'single' ? (
            <CrossfadeImage className="pix-ws__img" src={shownSrc} alt={image.name} />
          ) : (
            <CompareSplit
              beforeSrc={shownSrc}
              afterSrc={enhanced?.dataUrl ?? null}
              width={natural.width}
              height={natural.height}
              viewScale={view.scale}
              demoBadge={enhanced?.dev === true}
              pendingNote={
                isTauriRuntime() ? undefined : 'The enhancement engine runs in the desktop app.'
              }
              onInteract={() => setIdle(false)}
            />
          )}
        </div>

        {/* Info chip — present, quiet, never over the image center. */}
        <div className="pix-ws__chrome pix-ws__info">
          <span className="pix-ws__name" title={image.name}>
            {image.name}
          </span>
          <span className="pix-ws__meta u-tabular">
            {formatDimensions(image.width, image.height)} · {image.format} ·{' '}
            {formatBytes(image.sizeBytes)}
          </span>
          {(preparing || fullLoading) && (
            <span className="pix-ws__busy" role="status">
              <Spinner /> {preparing ? 'Reading full image locally…' : 'Loading 1:1 detail…'}
            </span>
          )}
          {viewFailed && !viewDto && (
            <span className="pix-ws__busy" role="status">
              Couldn't load the full image — showing the preview
            </span>
          )}
          {enhanced && !enhanced.dev && <span className="pix-ws__enhanced">{enhanced.label}</span>}
        </div>

        {/* Top-right chrome: fullscreen exit / collection actions. */}
        <div className="pix-ws__chrome pix-ws__tr">
          {fullscreen ? (
            <Tooltip content="Exit full screen (Esc)" side="bottom" align="end">
              <IconButton label="Exit full screen" onClick={() => void toggleFullscreen()}>
                <IconClose />
              </IconButton>
            </Tooltip>
          ) : (
            <Menu
              label="Workspace actions"
              trigger={
                // Menu owns activation — styled span trigger, as in TopBar.
                <span className="pix-icon-button pix-icon-button--ghost pix-ws__menu-trigger">
                  <IconMore />
                </span>
              }
              items={[
                {
                  id: 'add',
                  label: 'Add more images…',
                  icon: <IconImport size="sm" />,
                  onSelect: onAddMore,
                },
                {
                  id: 'clear',
                  label: 'Clear collection',
                  onSelect: onClear,
                  danger: true,
                },
              ]}
            />
          )}
        </div>

        {/* Bottom toolbar: zoom / fit / compare / fullscreen. */}
        <div className="pix-ws__chrome pix-ws__bar">
          <div className="pix-ws__toolbar" role="toolbar" aria-label="Viewer controls">
            <Tooltip content="Zoom out (−)" side="top">
              <IconButton
                label="Zoom out"
                onClick={() => applyView((v) => scaleView(v, v.scale / STEP, natural, stage))}
              >
                <IconZoomOut />
              </IconButton>
            </Tooltip>
            <Tooltip content="Actual size (1)" side="top">
              <button
                type="button"
                className="pix-ws__zoom u-tabular"
                onClick={() => applyView((v) => scaleView(v, 1, natural, stage))}
              >
                {zoomLabel}
              </button>
            </Tooltip>
            <Tooltip content="Zoom in (+)" side="top">
              <IconButton
                label="Zoom in"
                onClick={() => applyView((v) => scaleView(v, v.scale * STEP, natural, stage))}
              >
                <IconZoomIn />
              </IconButton>
            </Tooltip>
            <span className="pix-ws__sep" aria-hidden="true" />
            <Tooltip content="Fit to workspace (0)" side="top">
              <IconButton
                label="Fit to workspace"
                active={fitted}
                disabled={preparing}
                onClick={applyFit}
              >
                <IconFit />
              </IconButton>
            </Tooltip>
            <span className="pix-ws__sep" aria-hidden="true" />
            <Tooltip
              content={
                mode === 'single'
                  ? enhanced
                    ? 'Compare original and enhanced (C)'
                    : 'Compare view — enhanced results appear here (C)'
                  : 'Back to single view (C)'
              }
              side="top"
            >
              <IconButton
                label={mode === 'single' ? 'Compare' : 'Exit compare'}
                active={mode === 'compare'}
                onClick={() => setMode((m) => (m === 'single' ? 'compare' : 'single'))}
              >
                <IconCompare />
              </IconButton>
            </Tooltip>
            <span className="pix-ws__sep" aria-hidden="true" />
            <Tooltip content="Full screen (F)" side="top">
              <IconButton label="Full screen" onClick={() => void toggleFullscreen()}>
                <IconExpand />
              </IconButton>
            </Tooltip>
          </div>
        </div>

        {/* Fullscreen: minimal floating controls. */}
        {fullscreen && (
          <div className="pix-ws__chrome pix-ws__fsbar">
            <span className="pix-ws__fsreadout u-tabular">{zoomLabel}</span>
            <div className="pix-ws__fsbuttons">
              <IconButton label="Fit to screen (0)" onClick={applyFit}>
                <IconFit />
              </IconButton>
              <IconButton
                label={mode === 'single' ? 'Compare (C)' : 'Exit compare (C)'}
                active={mode === 'compare'}
                onClick={() => setMode((m) => (m === 'single' ? 'compare' : 'single'))}
              >
                <IconCompare />
              </IconButton>
              <IconButton label="Exit full screen (F)" onClick={() => void toggleFullscreen()}>
                <IconCollapse />
              </IconButton>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
