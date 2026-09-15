/**
 * Element size via ResizeObserver — the viewer needs the stage's pixel
 * box to compute fit, clamping, and anchors, and the box changes on
 * window resize, panel collapse, and fullscreen entry.
 *
 * Returns a callback ref (works with conditionally mounted elements)
 * and the latest border-box size. Environments without ResizeObserver
 * (jsdom) fall back to getBoundingClientRect once — enough for tests
 * that stub geometry.
 */
import { useCallback, useState } from 'react'

export interface Size {
  width: number
  height: number
}

export function useElementSize(): [(node: HTMLElement | null) => void, Size] {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  const attach = useCallback((node: HTMLElement | null) => {
    if (!node) {
      setSize({ width: 0, height: 0 })
      return
    }
    const publish = (next: Size) => {
      setSize((prev) =>
        Math.abs(prev.width - next.width) < 0.5 && Math.abs(prev.height - next.height) < 0.5
          ? prev
          : next,
      )
    }
    // Measure synchronously first: ResizeObserver's initial callback is
    // async and (in some embedded webviews) never fires for an element
    // whose size never changes — the viewer must know its stage size on
    // the very next render to fit the image.
    const rect = node.getBoundingClientRect()
    publish({ width: rect.width, height: rect.height })
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      const box = entry.borderBoxSize?.[0]
      if (box) publish({ width: box.inlineSize, height: box.blockSize })
      else {
        const r = entry.contentRect
        publish({ width: r.width, height: r.height })
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [attach, size]
}
