/**
 * TopBar — application identity and global actions.
 *
 * Deliberately quiet: brand left, global chrome right (core status, theme,
 * shortcuts, overflow, settings). View-level actions live in the view
 * headers, not here, so the bar never changes per navigation and the eye
 * can rest.
 */
import type { ReactNode } from 'react'
import { useAppState } from '../state/useAppState'
import type { ThemePreference } from '../state/appReducer'
import { Menu, type MenuItem } from '../ui/Menu'
import { Tooltip } from '../ui/Tooltip'
import { StatusDot } from '../components/StatusDot'
import { IconKeyboard, IconMonitor, IconMoon, IconSettings, IconSun, IconMore } from '../ui/Icons'
import { BrandMark } from './BrandMark'
import './Shell.css'

/**
 * Chrome icon button. The Menu component owns activation, so its trigger is
 * a styled non-interactive span; standalone buttons are real <button>s.
 */
function ChromeIcon({ children }: { children: ReactNode }) {
  return (
    <span className="pix-icon-button pix-icon-button--ghost pix-icon-button--sm">{children}</span>
  )
}

const themeLabels: Record<ThemePreference, string> = {
  system: 'Use system setting',
  light: 'Light',
  dark: 'Dark',
}

export interface TopBarProps {
  onOpenSettings: () => void
  onOpenShortcuts: () => void
  onOpenAbout: () => void
  onSetTheme: (theme: ThemePreference) => void
}

export function TopBar({ onOpenSettings, onOpenShortcuts, onOpenAbout, onSetTheme }: TopBarProps) {
  const { state } = useAppState()

  const themeItems: MenuItem[] = (['system', 'light', 'dark'] as const).map((t) => ({
    id: t,
    label: themeLabels[t],
    checked: state.ui.theme === t,
    onSelect: () => onSetTheme(t),
  }))

  const ThemeIcon =
    state.ui.theme === 'light' ? IconSun : state.ui.theme === 'dark' ? IconMoon : IconMonitor

  return (
    <header className="pixora-topbar">
      <div className="pixora-topbar__brand">
        <BrandMark />
        <span className="pixora-topbar__wordmark">Pixora</span>
      </div>

      <div className="pixora-topbar__trailing">
        <StatusDot status={state.coreStatus} />
        <div className="pixora-topbar__divider" aria-hidden="true" />
        <Menu
          label="Theme"
          trigger={
            <ChromeIcon>
              <ThemeIcon size="sm" />
            </ChromeIcon>
          }
          items={themeItems}
        />
        <Tooltip content="Keyboard shortcuts (F1)" side="bottom" align="end">
          <button
            type="button"
            className="pix-icon-button pix-icon-button--ghost pix-icon-button--sm"
            aria-label="Keyboard shortcuts"
            onClick={onOpenShortcuts}
          >
            <IconKeyboard size="sm" />
          </button>
        </Tooltip>
        <Menu
          label="More options"
          trigger={
            <ChromeIcon>
              <IconMore size="sm" />
            </ChromeIcon>
          }
          items={[{ id: 'about', label: 'About Pixora', onSelect: onOpenAbout }]}
        />
        <Tooltip content="Settings (Ctrl+,)" side="bottom" align="end">
          <button
            type="button"
            className="pix-icon-button pix-icon-button--ghost pix-icon-button--sm"
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <IconSettings size="sm" />
          </button>
        </Tooltip>
      </div>
    </header>
  )
}
