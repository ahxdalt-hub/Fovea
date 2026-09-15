/**
 * Native file drag & drop bridge.
 *
 * Tauri's window controller owns OS drag events while `dragDropEnabled`
 * is on (the default): the webview never receives raw HTML5 drag data and
 * the webview is never given a filesystem permission. Instead the core
 * emits enter/over/drop/leave events carrying canonical paths, which the
 * import service validates before anything reaches state.
 *
 * Outside the Tauri runtime (browser preview, jsdom tests) this hook is
 * inert: `dragOver` stays false and no listener is registered.
 */
import { useEffect, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

/** True when running inside a real Tauri webview. */
export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window
}

export interface NativeDropHandlers {
  /** Files are hovering over the window. */
  onEnter: () => void
  /** The pointer left the window — dismiss the affordance. */
  onLeave: () => void
  /** Files were dropped; paths are unvalidated (the service checks them). */
  onDrop: (paths: string[]) => void
}

export function useNativeFileDrop(handlers: NativeDropHandlers): void {
  // Keep the latest handlers without re-subscribing on every render.
  // Assignment happens in an effect (never during render) so React's
  // compiler-safe rules hold and the listener always sees current code.
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers
  })

  useEffect(() => {
    if (!isTauriRuntime()) return
    let disposed = false
    let unlisten: (() => void) | undefined

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return
        const payload = event.payload
        if (payload.type === 'enter') {
          // Only surface the drop affordance for actual files; text drags
          // produce the same events with no paths.
          if (payload.paths.length > 0) ref.current.onEnter()
        } else if (payload.type === 'drop') {
          ref.current.onLeave()
          if (payload.paths.length > 0) ref.current.onDrop(payload.paths)
        } else if (payload.type === 'leave') {
          ref.current.onLeave()
        }
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => {
        // Listener registration failing must not break the shell; import
        // remains reachable through the file picker.
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}

/** Hover-state helper: enter/leave drive a boolean, drop clears it. */
export function useDragOver(onDrop: (paths: string[]) => void | Promise<void>): {
  dragOver: boolean
} {
  const onDropRef = useRef(onDrop)
  useEffect(() => {
    onDropRef.current = onDrop
  })
  const [dragOver, setDragOver] = useState(false)
  useNativeFileDrop({
    onEnter: () => setDragOver(true),
    onLeave: () => setDragOver(false),
    onDrop: (paths) => {
      setDragOver(false)
      onDropRef.current(paths)
    },
  })
  return { dragOver }
}
