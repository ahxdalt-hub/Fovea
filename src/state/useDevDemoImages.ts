/**
 * Dev-only demo images for browser QA (Stage 04).
 *
 * The image workspace is the product's centerpiece and visual review must
 * be able to run without the Tauri window. `?demo=images` populates the
 * collection with locally-generated fixtures (canvas-drawn PNG/JPEG/WebP
 * at portrait/landscape/square/oversized dimensions) and seeds the source
 * cache with display-size data so the viewer's real code path paints.
 *
 * `?demo=enhanced` additionally attaches a demo enhancement so the
 * compare slider's *result* state can be reviewed. Both are unmistakably
 * marked: names carry no claim of realism and the compare tag shows a
 * `demo` badge. They are stripped from release builds (import.meta.env.DEV
 * becomes false) and inert inside Tauri and tests — the production app
 * never shows a fabricated image.
 */
import { useEffect } from 'react'
import type { ImportedImageDto } from '../types/ipc'
import { useAppState } from './useAppState'
import { seedSourceCache } from './imageSources'

function makeFixture(
  name: string,
  width: number,
  height: number,
  hue: number,
  mime: 'image/png' | 'image/jpeg',
): ImportedImageDto {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  // A soft gradient plus a grid so zoom/pan detail is observable.
  const g = ctx.createLinearGradient(0, 0, width, height)
  g.addColorStop(0, `hsl(${hue} 62% 52%)`)
  g.addColorStop(0.6, `hsl(${(hue + 40) % 360} 55% 40%)`)
  g.addColorStop(1, `hsl(${(hue + 80) % 360} 45% 26%)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'
  ctx.lineWidth = Math.max(1, width / 900)
  const step = Math.max(24, Math.round(width / 26))
  for (let x = step; x < width; x += step) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  for (let y = step; y < height; y += step) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
  // Fine text at the center: sharpness after zoom is directly visible.
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = `${Math.round(width / 14)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${width}×${height}`, width / 2, height / 2)

  const dataUrl = canvas.toDataURL(mime, 0.92)
  const format = mime === 'image/jpeg' ? 'JPEG' : 'PNG'
  return {
    id: `demo:///${name}`,
    name,
    format,
    width,
    height,
    sizeBytes: Math.round((dataUrl.length * 3) / 4),
    previewDataUrl: dataUrl,
  }
}

let seeded = false

export function useDevDemoImages() {
  const { dispatch } = useAppState()

  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.MODE === 'test') return
    if ('__TAURI_INTERNALS__' in window) return
    const params = new URLSearchParams(window.location.search)
    if (params.get('demo') !== 'images' && params.get('demo') !== 'enhanced') return
    if (seeded) return
    seeded = true

    const fixtures: ImportedImageDto[] = [
      makeFixture('landscape-demo.png', 2400, 1350, 210, 'image/png'),
      makeFixture('portrait-demo.png', 1080, 1920, 25, 'image/png'),
      makeFixture('square-demo.png', 1400, 1400, 150, 'image/png'),
      makeFixture('photo-demo.jpg', 4032, 3024, 265, 'image/jpeg'),
      makeFixture('huge-demo.jpg', 7000, 4500, 320, 'image/jpeg'),
    ]
    for (const f of fixtures) {
      // The "display view" cache entry equals the fixture itself — this
      // is a dev QA path, the honest tier logic still runs everywhere.
      seedSourceCache(f.id, 'view', {
        width: f.width,
        height: f.height,
        deliveredEdge: Math.max(f.width, f.height),
        original: true,
        dataUrl: f.previewDataUrl,
      })
    }
    dispatch({ type: 'images/add', images: fixtures })

    if (params.get('demo') === 'enhanced') {
      const target = fixtures[0]!
      // A visibly *different* fixture (shifted palette + caption) so the
      // compare layout can be reviewed; unmistakably a demo, never AI.
      const after = makeFixture('landscape-demo.png', target.width, target.height, 130, 'image/png')
      dispatch({
        type: 'enhancements/set',
        enhancement: {
          imageId: target.id,
          dataUrl: after.previewDataUrl,
          width: target.width * 2,
          height: target.height * 2,
          label: 'demo fixture · not AI output',
          dev: true,
        },
      })
    }
    dispatch({ type: 'ui/navigate', view: 'enhance' })
  }, [dispatch])
}
