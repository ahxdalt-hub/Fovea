/**
 * Crash containment (Stage 12) — the last line between a renderer
 * exception and a blank window.
 *
 * React unmounts the whole tree when a render throws; without a boundary
 * the user sees nothing and the app looks dead. This boundary catches the
 * exception, reports the safe code path to the native log (message text
 * is capped and stripped by the `write_frontend_log` command — no pixel
 * data or file paths can ride along), and renders a minimal recoverable
 * surface: reload is the honest remedy for a corrupt render tree.
 *
 * It is mounted at the root, *outside* the state provider, so it survives
 * crashes in the provider itself.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { writeFrontendLog } from '../ipc/bridge'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Safe relay: the native command caps length and strips control
    // characters. Only the error's own text and component stack go —
    // never image data or file paths.
    writeFrontendLog('error', `render crash: ${error.message}`)
    writeFrontendLog('error', `render crash stack: ${info.componentStack?.trim() ?? 'unknown'}`)
  }

  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="pix-boundary" role="alert">
        <div className="pix-boundary__card">
          <h1 className="pix-boundary__title">Fovea hit an unexpected problem</h1>
          <p className="pix-boundary__text">
            A display error stopped the interface. Your images and history are safe on this machine.
            Reloading usually fixes it.
          </p>
          <button
            type="button"
            className="pix-boundary__reload"
            onClick={() => window.location.reload()}
          >
            Reload Fovea
          </button>
        </div>
      </div>
    )
  }
}
