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
import type { ThemePreference } from '../state/settings'
import { planBadge, planView } from '../lib/entitlements'
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
  // The name comes from the bundle, so a Fovea Pro install says Fovea Pro and
  // a dev run says Fovea. Native is the only place the product name lives.
  const productName = state.config?.productName ?? 'Fovea'
  const plan = planView(state.license)
  const planChipTier =
    plan.known && plan.tier !== 'free' && !productName.toLowerCase().includes(plan.tier)
      ? plan.tier
      : null

  const themeItems: MenuItem[] = (['system', 'light', 'dark'] as const).map((t) => ({
    id: t,
    label: themeLabels[t],
    checked: state.settings.general.theme === t,
    onSelect: () => onSetTheme(t),
  }))

  const ThemeIcon =
    state.settings.general.theme === 'light'
      ? IconSun
      : state.settings.general.theme === 'dark'
        ? IconMoon
        : IconMonitor

  return (
    <header className="fovea-topbar">
      <div className="fovea-topbar__brand">
        <BrandMark />
        <span className="fovea-topbar__wordmark">{productName}</span>
        {/* The plan in force, when the name on the bar does not already carry
            it: an activated key is worth a mark you can see without opening
            Settings. */}
        {planChipTier && (
          <span className="fovea-topbar__plan" data-tier={planChipTier}>
            {planBadge(planChipTier)}
          </span>
        )}
      </div>

      <div className="fovea-topbar__trailing">
        <StatusDot status={state.coreStatus} />
        <div className="fovea-topbar__divider" aria-hidden="true" />
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
          items={[{ id: 'about', label: `About ${productName}`, onSelect: onOpenAbout }]}
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
