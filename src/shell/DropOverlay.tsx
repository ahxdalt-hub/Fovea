/**
 * DropOverlay — the whole-window drag & drop affordance.
 *
 * Tauri routes OS file drags through the core (the webview never sees the
 * raw DataTransfer), so this overlay is driven by native drag state, not
 * HTML5 drag events. It renders only while a file drag hovers the window:
 * a calm dimmed backdrop, an inset accent frame that reads as "files land
 * here", and a short instruction. No confetti, no icons bouncing.
 *
 * pointer-events:none — it must never intercept the drop itself.
 */
import './DropOverlay.css'

export function DropOverlay() {
  return (
    <div className="fovea-drop-overlay anim-fade" role="status" aria-label="Drop files to import">
      <div className="fovea-drop-overlay__frame" aria-hidden="true" />
      <div className="fovea-drop-overlay__hint">
        <span className="fovea-drop-overlay__title">Drop images to import</span>
        <span className="fovea-drop-overlay__detail">JPG · PNG · WebP — checked locally</span>
      </div>
    </div>
  )
}
