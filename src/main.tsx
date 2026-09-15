import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import App from './App.tsx'
import { AppStateProvider } from './state/AppState'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStateProvider>
      <App />
    </AppStateProvider>
  </StrictMode>,
)
