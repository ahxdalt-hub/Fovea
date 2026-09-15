/**
 * CrossfadeImage — an <img> that swaps sources without a white flash.
 *
 * When the viewer upgrades a source (preview → display-size → full-size,
 * or switching images), the old bytes stay painted underneath until the
 * new source has fully decoded, then the new layer fades in over it.
 * One extra paint, zero flicker — image inspection is never interrupted
 * by a blank frame.
 *
 * The wrapper carries layout/transform (caller's `style`); the two
 * stacked <img>s fill it identically so the swap is pixel-exact.
 */
import { useState, type CSSProperties } from 'react'
import { cx } from '../ui/cx'
import './CrossfadeImage.css'

export interface CrossfadeImageProps {
  src: string
  alt: string
  className?: string
  style?: CSSProperties
}

export function CrossfadeImage({ src, alt, className, style }: CrossfadeImageProps) {
  const [rendered, setRendered] = useState(src)
  const fading = rendered !== src
  return (
    <span className={cx('pix-xfade', className)} style={style}>
      {fading && (
        <img className="pix-xfade__layer pix-xfade__old" src={rendered} alt="" aria-hidden="true" />
      )}
      <img
        className={cx(
          'pix-xfade__layer',
          'pix-xfade__current',
          fading && 'pix-xfade__current--enter',
        )}
        src={src}
        alt={alt}
        onLoad={() => setRendered(src)}
        draggable={false}
      />
    </span>
  )
}
