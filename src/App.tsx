/**
 * Pixora application shell.
 *
 * Layout: TopBar (identity + global chrome) / NavRail + Workspace / StatusBar.
 * The workspace renders the active view; navigation is a pure state change
 * (no router library — three views do not earn one). Core bootstrap status is
 * shown honestly: connecting → loading, error → retry surface, ready → views.
 *
 * Stage 03 adds the import funnel: native file drag & drop (overlay while
 * hovering) and the native picker both run through useImport, which
 * validates files in Rust before they join the collection.
 *
 * Stage 04 turns the Enhance view into the image workspace: a zoom/pan/fit
 * canvas for the selected image with a compare slider wired for (not
 * faking) the Stage 05 enhanced result.
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
import { useDevDemoImages } from './state/useDevDemoImages'
import { useImport } from './state/useImport'
import { useDragOver } from './state/useNativeFileDrop'
import { persistTheme } from './state/appReducer'
import { NotificationProvider } from './ui/Notifications'
import { ErrorState, LoadingState } from './ui/States'
import { NavRail } from './shell/NavRail'
import { TopBar } from './shell/TopBar'
import { StatusBar } from './shell/StatusBar'
import { SettingsDialog } from './shell/SettingsDialog'
import { AboutDialog, ShortcutsDialog } from './shell/InfoDialogs'
import { DropOverlay } from './shell/DropOverlay'
import { EnhanceView } from './views/EnhanceView'
import { BatchView } from './views/BatchView'
import { HistoryView } from './views/HistoryView'
import './shell/Shell.css'

export function Shell() {
  const { state, dispatch } = useAppState()
  useCoreBootstrap()
  useThemeSync()
  useDevPreviewParams()
  useDevDemoImages()
  const importApi = useImport()
  const { dragOver } = useDragOver(importApi.dropPaths)

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
  const openImport = useCallback(() => void importApi.browse(), [importApi])

  const anyDialogOpen = state.ui.settingsOpen || shortcutsOpen || aboutOpen

  useKeyboardShortcuts({
    enabled: !anyDialogOpen,
    onNavigate: navigate,
    onOpenSettings: openSettings,
    onToggleShortcuts: toggleShortcuts,
    onOpenImport: openImport,
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
        return <EnhanceView importApi={importApi} images={state.images} />
    }
  }

  return (
    <div className="pixora-shell">
      {dragOver && <DropOverlay />}
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
