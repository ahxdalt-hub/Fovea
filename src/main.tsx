import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import App from './App.tsx'
import { AppStateProvider } from './state/AppState'
import { ErrorBoundary } from './ui/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Stage 12: the boundary wraps everything so a render crash shows a
        recoverable surface instead of a blank window. It sits outside the
        state provider deliberately — the provider can be the crasher. */}
    <ErrorBoundary>
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </ErrorBoundary>
  </StrictMode>,
)
