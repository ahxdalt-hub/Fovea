/**
 * Settings dialog — the shell's real preferences.
 *
 * Theme choice is live (persisted, applied immediately). The remaining
 * sections state clearly that engine/storage preferences attach here when
 * Stage 03+ adds them, instead of shipping fake toggles.
 */
import { useAppState } from '../state/useAppState'
import type { ThemePreference } from '../state/appReducer'
import { Dialog } from '../ui/Dialog'
import { SegmentedField } from '../ui/Field'
import { IconMonitor, IconMoon, IconSun } from '../ui/Icons'
import './Dialogs.css'

export interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  onSetTheme: (theme: ThemePreference) => void
}

export function SettingsDialog({ open, onClose, onSetTheme }: SettingsDialogProps) {
  const { state } = useAppState()

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Settings"
      description="Preferences are stored on this computer."
    >
      <div className="pixora-settings">
        <SegmentedField
          label="Appearance"
          value={state.ui.theme}
          onChange={(value) => onSetTheme(value as ThemePreference)}
          options={[
            { value: 'system', label: 'System', icon: <IconMonitor size="sm" /> },
            { value: 'light', label: 'Light', icon: <IconSun size="sm" /> },
            { value: 'dark', label: 'Dark', icon: <IconMoon size="sm" /> },
          ]}
        />

        <div className="pixora-settings__group">
          <span className="u-caps-label">Processing</span>
          <p className="pix-settings__note">
            Engine, device (GPU/CPU), and output preferences appear here as the enhancement
            workspace becomes available.
          </p>
        </div>

        <div className="pixora-settings__group">
          <span className="u-caps-label">Storage</span>
          {state.systemInfo && (
            <p className="pix-settings__note">
              Application data lives in{' '}
              <code className="pix-settings__path">{state.systemInfo.appDataDir}</code>
            </p>
          )}
          <p className="pix-settings__note">
            History retention and cache location are managed here in later stages.
          </p>
        </div>
      </div>
    </Dialog>
  )
}
