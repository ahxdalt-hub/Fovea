/**
 * Foundation screen.
 *
 * Deliberately minimal: it shows real startup state (native core status,
 * config, system info) and nothing invented. The full product UI arrives
 * in later stages on top of the tokens and layout shell established here.
 */
import { StatusDot } from './components/StatusDot'
import { useAppState } from './state/useAppState'
import { useCoreBootstrap } from './state/useCoreBootstrap'
import './App.css'

function App() {
  const { state } = useAppState()
  useCoreBootstrap()

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div className="app-shell__brand">
          <h1 className="app-shell__title">
            {state.config?.productName ?? 'Local AI Image Upscaler'}
          </h1>
          {state.config && <span className="app-shell__version">v{state.config.version}</span>}
        </div>
        <StatusDot status={state.coreStatus} />
      </header>

      <main className="app-shell__main">
        {state.coreStatus === 'ready' && state.systemInfo && (
          <section className="core-card" aria-label="Application core status">
            <h2 className="core-card__heading">Native core ready</h2>
            <p className="core-card__note">
              The application is running locally on your machine. Image processing engines will
              connect here in upcoming stages.
            </p>
            <dl className="core-card__grid">
              <div>
                <dt>Operating system</dt>
                <dd>{state.systemInfo.osFamily}</dd>
              </div>
              <div>
                <dt>Architecture</dt>
                <dd>{state.systemInfo.arch}</dd>
              </div>
              <div>
                <dt>Build</dt>
                <dd>{state.config?.debug ? 'debug' : 'release'}</dd>
              </div>
            </dl>
          </section>
        )}

        {state.coreStatus === 'connecting' && (
          <p className="app-shell__placeholder">Starting application core…</p>
        )}

        {state.coreStatus === 'error' && state.error && (
          <section className="core-card core-card--error" aria-label="Startup error">
            <h2 className="core-card__heading">Application core unavailable</h2>
            <p className="core-card__note">{state.error.message}</p>
          </section>
        )}
      </main>

      <footer className="app-shell__footer">
        <span>Your images are processed locally and never leave this computer.</span>
      </footer>
    </div>
  )
}

export default App
