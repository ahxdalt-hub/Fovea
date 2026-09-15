/**
 * Shortcuts + About dialogs — static reference surfaces.
 *
 * These exist because desktop users expect them (F1, Help menu). Both are
 * small and read-only; content is real keyboard behavior wired in App.tsx.
 */
import { Dialog } from '../ui/Dialog'
import { BrandMark } from './BrandMark'
import { useAppState } from '../state/useAppState'
import { Badge } from '../ui/Badge'
import './Dialogs.css'

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="Keyboard shortcuts"
      description="Everything reachable without leaving the keyboard."
    >
      <dl className="pixora-shortcuts">
        <div className="pixora-shortcuts__row">
          <dt>Switch to Enhance</dt>
          <dd>
            <kbd>1</kbd>
          </dd>
        </div>
        <div className="pixora-shortcuts__row">
          <dt>Switch to Batch</dt>
          <dd>
            <kbd>2</kbd>
          </dd>
        </div>
        <div className="pixora-shortcuts__row">
          <dt>Switch to History</dt>
          <dd>
            <kbd>3</kbd>
          </dd>
        </div>
        <div className="pixora-shortcuts__row">
          <dt>Open settings</dt>
          <dd>
            <kbd>Ctrl</kbd>
            <span className="pixora-shortcuts__plus">+</span>
            <kbd>,</kbd>
          </dd>
        </div>
        <div className="pixora-shortcuts__row">
          <dt>Keyboard shortcuts</dt>
          <dd>
            <kbd>F1</kbd>
          </dd>
        </div>
        <div className="pixora-shortcuts__row">
          <dt>Close dialog</dt>
          <dd>
            <kbd>Esc</kbd>
          </dd>
        </div>
      </dl>
    </Dialog>
  )
}

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useAppState()
  return (
    <Dialog open={open} onClose={onClose} title="About Pixora">
      <div className="pixora-about">
        <BrandMark size={48} />
        <div className="pixora-about__text">
          <div className="pixora-about__name">
            <span className="pixora-about__title">Pixora</span>
            {state.config && <span className="u-tabular">v{state.config.version}</span>}
          </div>
          <p>
            Professional image enhancement that runs entirely on your computer. Your photos are
            never uploaded.
          </p>
          <div className="pixora-about__meta">
            <Badge tone="accent">Tauri · Rust · React</Badge>
            {state.config?.debug && <Badge tone="warning">Debug build</Badge>}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
