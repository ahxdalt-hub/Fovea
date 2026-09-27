/**
 * CompareSplit — the reusable before/after slider (Stage 04 architecture).
 *
 * Geometry: the root is the image *frame* — sized in image space (caller
 * sets width/height to natural px) and transformed by the viewer (zoom /
 * pan) like any layer, so both sides always show the same region at the
 * same scale. That shared transform is what makes the comparison
 * trustworthy: you compare pixels, not viewports.
 *
 * Both images fill the frame absolutely and are divided by clip-path, so
 * the split is exact at any position and the after side may be a higher
 * resolution than the before without visual drift.
 *
 * Stage 04: `afterSrc` is null until the enhancement engine lands
 * (Stage 05). The slider stays fully functional — the after side shows an
 * honest pending panel — so the interaction is proven and nothing is
 * fabricated. When the engine arrives it passes a real `afterSrc` and the
 * same component shows the result.
 *
 * The handle is a real ARIA slider: pointer drag, touch, and arrow keys
 * all move it; its position is 0–100 so assistive tech announces it.
 */
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { cx } from '../ui/cx'
import { IconSparkle } from '../ui/Icons'
import './CompareSplit.css'

export interface CompareSplitProps {
  beforeSrc: string
  /** Null while no enhanced result exists — honest pending panel. */
  afterSrc: string | null
  beforeLabel?: string
  afterLabel?: string
  /** Frame size in image-space px (the before image's natural size). */
  width: number
  height: number
  /** Extra class on the root (the viewer supplies the transform here). */
  className?: string
  /** Honest note under the pending panel (what unlocks the after side). */
  pendingNote?: string
  /** Dev-QA marker: demo fixture, never real engine output. */
  demoBadge?: boolean
  onInteract?: () => void
  /** The viewer's current zoom. The frame lives inside the zoomed layer, so
   * chrome (handle, divider, tags, pending card) counter-scales by 1/scale
   * to keep a constant on-screen size — a handle that shrinks at fit zoom
   * or balloons at 4× reads as broken, not zoomy. */
  viewScale?: number
}

/** The divider never fully covers either side. */
export const COMPARE_MIN = 3
export const COMPARE_MAX = 100 - COMPARE_MIN

export function CompareSplit({
  beforeSrc,
  afterSrc,
  beforeLabel = 'Original',
  afterLabel = 'Enhanced',
  width,
  height,
  className,
  pendingNote,
  demoBadge = false,
  onInteract,
  viewScale = 1,
}: CompareSplitProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(50) // percent of the frame width

  const setFromClientX = useCallback((clientX: number) => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const pct = ((clientX - rect.left) / rect.width) * 100
    setPosition(Math.min(COMPARE_MAX, Math.max(COMPARE_MIN, pct)))
  }, [])

  function onPointerDown(event: ReactPointerEvent) {
    event.preventDefault()
    event.stopPropagation() // never start a viewer pan
    // jsdom lacks pointer capture; guarded so tests can drive the slider.
    const target = event.currentTarget as HTMLElement & {
      setPointerCapture?: (id: number) => void
    }
    target.setPointerCapture?.(event.pointerId)
    setFromClientX(event.clientX)
    onInteract?.()
  }
  function onPointerMove(event: ReactPointerEvent) {
    if (event.buttons !== 1) return
    setFromClientX(event.clientX)
  }
  function nudge(key: string, shift: boolean): boolean {
    const step = shift ? 10 : 2
    let moved = true
    if (key === 'ArrowLeft') setPosition((p) => Math.max(COMPARE_MIN, p - step))
    else if (key === 'ArrowRight') setPosition((p) => Math.min(COMPARE_MAX, p + step))
    else if (key === 'Home') setPosition(COMPARE_MIN)
    else if (key === 'End') setPosition(COMPARE_MAX)
    else moved = false
    if (moved) onInteract?.()
    return moved
  }

  const pending = afterSrc === null

  return (
    <div
      ref={rootRef}
      className={cx('pix-compare', pending && 'pix-compare--pending', className)}
      style={{ width, height, ['--pix-view-scale' as string]: viewScale }}
      data-position={position.toFixed(1)}
    >
      <img
        className="pix-compare__img"
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
        src={beforeSrc}
        alt={`${beforeLabel} version`}
        draggable={false}
      />
      {pending ? (
        <div className="pix-compare__pending" style={{ left: `${position}%` }}>
          <div className="pix-compare__pending-card anim-fade">
            <IconSparkle size="lg" />
            <span className="pix-compare__pending-title">{afterLabel} will appear here</span>
            <span className="pix-compare__pending-note">
              {pendingNote ?? 'Run an enhancement to compare against this original.'}
            </span>
          </div>
        </div>
      ) : (
        <img
          className="pix-compare__img"
          style={{ clipPath: `inset(0 0 0 ${position}%)` }}
          src={afterSrc}
          alt={`${afterLabel} version`}
          draggable={false}
        />
      )}

      {/* Divider + grab handle */}
      <div className="pix-compare__divider" style={{ left: `${position}%` }}>
        <div
          role="slider"
          tabIndex={0}
          className="pix-compare__handle"
          aria-label={`${beforeLabel} / ${afterLabel} divider`}
          aria-valuemin={COMPARE_MIN}
          aria-valuemax={COMPARE_MAX}
          aria-valuenow={Math.round(position)}
          aria-valuetext={`${Math.round(position)}% ${beforeLabel} shown`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onKeyDown={(event) => {
            if (nudge(event.key, event.shiftKey)) event.preventDefault()
          }}
        >
          <span className="pix-compare__grip" aria-hidden="true">
            <span className="pix-compare__arrow" />
            <span className="pix-compare__arrow pix-compare__arrow--flip" />
          </span>
        </div>
      </div>

      {/* Side labels — fade out when the handle crowds them. */}
      <span
        className={cx('pix-compare__tag', position < 16 && 'pix-compare__tag--dim')}
        aria-hidden="true"
      >
        {beforeLabel}
      </span>
      <span
        className={cx(
          'pix-compare__tag',
          'pix-compare__tag--right',
          position > 84 && 'pix-compare__tag--dim',
        )}
        aria-hidden="true"
      >
        {afterLabel}
        {demoBadge && <span className="pix-compare__demo">demo</span>}
      </span>
    </div>
  )
}
