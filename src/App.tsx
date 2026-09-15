/**
 * Pixora application shell.
 *
 * Layout: TopBar (identity + global chrome) / NavRail + Workspace / StatusBar.
 * The workspace renders the active view; navigation is a pure state change
 * (no router library — three views do not earn one). Core bootstrap status is
 * shown honestly: connecting → loading, error → retry surface, ready → views.
 *
 * Boundaries unchanged from Stage 01: React owns presentation, everything
 * native stays behind src/ipc/bridge.ts.
 */
import { useCallback, useState } from 'react'
import type { ThemePreference, ViewId } from './state/appReducer'
import { useAppState } from './state/useAppState'
import { useCoreBootstrap } from './state/useCoreBootstrap'
import { useThemeSync } from './state/useThemeSync'
import { useKeyboardShortcuts } from './state/useKeyboardShortcuts'
import { useDevPreviewParams } from './state/useDevPreviewParams'
import { persistTheme } from './state/appReducer'
import { NotificationProvider } from './ui/Notifications'
import { ErrorState, LoadingState } from './ui/States'
import { NavRail } from './shell/NavRail'
import { TopBar } from './shell/TopBar'
import { StatusBar } from './shell/StatusBar'
import { SettingsDialog } from './shell/SettingsDialog'
import { AboutDialog, ShortcutsDialog } from './shell/InfoDialogs'
import { EnhanceView } from './views/EnhanceView'
import { BatchView } from './views/BatchView'
import { HistoryView } from './views/HistoryView'
import './shell/Shell.css'

export function Shell() {
  const { state, dispatch } = useAppState()
  useCoreBootstrap()
  useThemeSync()
  useDevPreviewParams()

  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  const navigate = useCallback(
    (view: ViewId) => dispatch({ type: 'ui/navigate', view }),
    [dispatch],
  )
  const openSettings = useCallback(() => dispatch({ type: 'ui/settings', open: true }), [dispatch])
  const setTheme = useCallback(
    (theme: ThemePreference) => {
      persistTheme(theme)
      dispatch({ type: 'ui/setTheme', theme })
    },
    [dispatch],
  )
  const toggleShortcuts = useCallback(() => setShortcutsOpen((v) => !v), [])

  const anyDialogOpen = state.ui.settingsOpen || shortcutsOpen || aboutOpen

  useKeyboardShortcuts({
    enabled: !anyDialogOpen,
    onNavigate: navigate,
    onOpenSettings: openSettings,
    onToggleShortcuts: toggleShortcuts,
  })

  function renderWorkspace() {
    if (state.coreStatus === 'error') {
      return (
        <ErrorState
          title="The application core is unavailable"
          description={
            state.error?.message ?? 'Something went wrong while starting the local processing core.'
          }
          onRetry={() => dispatch({ type: 'ui/retryCore' })}
        />
      )
    }
    if (state.coreStatus === 'connecting') {
      return (
        <LoadingState
          label="Starting the local engine…"
          description="Connecting to the application core"
        />
      )
    }
    switch (state.ui.view) {
      case 'batch':
        return <BatchView onGoToEnhance={() => navigate('enhance')} />
      case 'history':
        return <HistoryView onGoToEnhance={() => navigate('enhance')} />
      default:
        return <EnhanceView />
    }
  }

  return (
    <div className="pixora-shell">
      <TopBar
        onOpenSettings={openSettings}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
        onSetTheme={setTheme}
      />
      <div className="pixora-shell__body">
        <NavRail active={state.ui.view} onNavigate={navigate} />
        {/* key remounts the view subtree so entry motion replays per section */}
        <main
          className="pixora-workspace"
          key={state.coreStatus === 'ready' ? state.ui.view : 'core'}
        >
          {renderWorkspace()}
        </main>
      </div>
      <StatusBar />

      <SettingsDialog
        open={state.ui.settingsOpen}
        onClose={() => dispatch({ type: 'ui/settings', open: false })}
        onSetTheme={setTheme}
      />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  )
}

export default function App() {
  return (
    <NotificationProvider>
      <Shell />
    </NotificationProvider>
  )
}
