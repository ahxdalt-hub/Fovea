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
import { useCallback, useEffect, useState } from 'react'
import type { ViewId } from './state/appReducer'
import type { ThemePreference } from './state/settings'
import { persistLastView } from './state/settings'
import { useAppState } from './state/useAppState'
import { useSettings } from './state/useSettings'
import { useCoreBootstrap } from './state/useCoreBootstrap'
import { useThemeSync } from './state/useThemeSync'
import { useKeyboardShortcuts } from './state/useKeyboardShortcuts'
import { useDevPreviewParams } from './state/useDevPreviewParams'
import { useDevDemoImages } from './state/useDevDemoImages'
import { useImport } from './state/useImport'
import { useEnhance } from './state/useEnhance'
import { useBatch } from './state/useBatch'
import { useDragOver } from './state/useNativeFileDrop'
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
  const { update: updateSettings } = useSettings()
  useCoreBootstrap()
  useThemeSync()
  useDevPreviewParams()
  useDevDemoImages()
  const importApi = useImport()
  const enhanceApi = useEnhance()
  const batchApi = useBatch()
  const { dragOver } = useDragOver(importApi.dropPaths)

  // On the first ready handshake, re-sync any batch that survived from a
  // previous window (the worker keeps draining after a remount) so the
  // queue panel is never shown as empty while work runs natively.
  useEffect(() => {
    if (state.coreStatus === 'ready') void batchApi.refresh()
    // Intentionally not keyed on batchApi.refresh identity — one sync per
    // ready transition is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.coreStatus])

  const reopenFromPath = useCallback(
    (path: string) => {
      // Import runs the native validation ladder and navigates to the
      // workspace; a moved/deleted file reports honestly through the
      // import notification rather than a dead click.
      void importApi.dropPaths([path])
    },
    [importApi],
  )

  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  const navigate = useCallback(
    (view: ViewId) => {
      // The remembered view feeds `startupView: 'last'` (Stage 10).
      persistLastView(view)
      dispatch({ type: 'ui/navigate', view })
    },
    [dispatch],
  )
  const openSettings = useCallback(() => dispatch({ type: 'ui/settings', open: true }), [dispatch])
  const setTheme = useCallback(
    (theme: ThemePreference) => updateSettings('general', { theme }),
    [updateSettings],
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
        return <BatchView batchApi={batchApi} onGoToEnhance={() => navigate('enhance')} />
      case 'history':
        return <HistoryView onGoToEnhance={() => navigate('enhance')} onReopen={reopenFromPath} />
      default:
        return (
          <EnhanceView
            importApi={importApi}
            enhanceApi={enhanceApi}
            images={state.images}
            onReopen={reopenFromPath}
          />
        )
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
