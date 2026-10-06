/**
 * Shortcuts + About dialogs — static reference surfaces.
 *
 * These exist because desktop users expect them (F1, Help menu). Both are
 * small and read-only; content is real keyboard behavior wired in App.tsx.
 */
import { Dialog } from '../ui/Dialog'
import { BrandMark } from './BrandMark'
import { useAppState } from '../state/useAppState'
import { planName, planView } from '../lib/entitlements'
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
      <dl className="fovea-shortcuts">
        <div className="fovea-shortcuts__row">
          <dt>Import images</dt>
          <dd>
            <kbd>Ctrl</kbd>
            <span className="fovea-shortcuts__plus">+</span>
            <kbd>O</kbd>
          </dd>
        </div>
        <div className="fovea-shortcuts__row">
          <dt>Switch to Enhance</dt>
          <dd>
            <kbd>1</kbd>
          </dd>
        </div>
        <div className="fovea-shortcuts__row">
          <dt>Switch to Batch</dt>
          <dd>
            <kbd>2</kbd>
          </dd>
        </div>
        <div className="fovea-shortcuts__row">
          <dt>Switch to History</dt>
          <dd>
            <kbd>3</kbd>
          </dd>
        </div>
        <div className="fovea-shortcuts__row">
          <dt>Open settings</dt>
          <dd>
            <kbd>Ctrl</kbd>
            <span className="fovea-shortcuts__plus">+</span>
            <kbd>,</kbd>
          </dd>
        </div>
        <div className="fovea-shortcuts__row">
          <dt>Keyboard shortcuts</dt>
          <dd>
            <kbd>F1</kbd>
          </dd>
        </div>
        <div className="fovea-shortcuts__row">
          <dt>Close dialog / exit compare</dt>
          <dd>
            <kbd>Esc</kbd>
          </dd>
        </div>
        <div className="fovea-shortcuts__group">
          <dt className="u-caps-label">Image viewer</dt>
          <dd />
        </div>
        <div className="fovea-shortcuts__row">
          <dt>Zoom in / out</dt>
          <dd>
            <kbd>+</kbd>
            <span className="fovea-shortcuts__plus">/</span>
            <kbd>-</kbd>
          </dd>
        </div>
        <div className="fovea-shortcuts__row">
          <dt>Fit to workspace</dt>
          <dd>
            <kbd>0</kbd>
          </dd>
        </div>
        <div className="fovea-shortcuts__row">
          <dt>Actual size</dt>
          <dd>
            <kbd>1</kbd>
          </dd>
        </div>
        <div className="fovea-shortcuts__row">
          <dt>Compare original / enhanced</dt>
          <dd>
            <kbd>C</kbd>
          </dd>
        </div>
        <div className="fovea-shortcuts__row">
          <dt>Full screen</dt>
          <dd>
            <kbd>F</kbd>
          </dd>
        </div>
      </dl>
    </Dialog>
  )
}

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useAppState()
  const name = state.config?.productName ?? 'Fovea'
  const plan = planView(state.license)
  // The build's own plan and the plan in force are different facts, and a
  // paid installer running unactivated is exactly the case where telling them
  // apart matters: the customer owns the thing they cannot yet see.
  const buildPlan = state.config?.buildPlan ?? 'free'
  return (
    <Dialog open={open} onClose={onClose} title={`About ${name}`}>
      <div className="fovea-about">
        <BrandMark size={48} />
        <div className="fovea-about__text">
          <div className="fovea-about__name">
            <span className="fovea-about__title">{name}</span>
            {state.config && <span className="u-tabular">v{state.config.version}</span>}
          </div>
          <p>
            Professional image enhancement that runs entirely on your computer. Your photos are
            never uploaded.
          </p>
          {plan.known && (
            <p>
              {plan.tier === 'free'
                ? `This copy is running the free plan${
                    buildPlan === 'free'
                      ? ''
                      : `, although the installer it came from is ${name} — its key is pasted under Settings → License`
                  }.`
                : `The ${planName(plan.tier)} plan is in force on this machine.`}
            </p>
          )}
          <div className="fovea-about__meta">
            <Badge tone={plan.tier === 'free' ? 'neutral' : 'success'}>
              {plan.tier === 'free' ? 'Free plan' : planName(plan.tier)}
            </Badge>
            <Badge tone="accent">Tauri · Rust · React</Badge>
            {state.config?.debug && <Badge tone="warning">Debug build</Badge>}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
