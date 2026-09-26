/**
 * Settings dialog — the shell's real preferences.
 *
 * Theme choice is live (persisted, applied immediately). Stage 07 added
 * the Processing section's other half: the engine's hardware diagnostics
 * (which device enhancements run on, what the machine has, what memory
 * ceilings the engine derived) — the technical detail the main UI keeps
 * subtle, gathered in one honest place for users who look.
 */
import { useEffect, useState } from 'react'
import { getDiagnostics } from '../ipc/bridge'
import type { DiagnosticsDto } from '../types/ipc'
import { formatBytes } from '../lib/format'
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

/** Fetch diagnostics each time the dialog opens; failures leave the
 * section honest ("unavailable") rather than stale. */
function useDiagnostics(open: boolean) {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsDto | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    getDiagnostics()
      .then((d) => {
        if (!cancelled) setDiagnostics(d)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [open])
  return { diagnostics, failed }
}

function DiagRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="pix-settings__row">
      <span className="pix-settings__label">{label}</span>
      <span className="pix-settings__value u-tabular">{value}</span>
    </div>
  )
}

export function SettingsDialog({ open, onClose, onSetTheme }: SettingsDialogProps) {
  const { state } = useAppState()
  const { diagnostics, failed } = useDiagnostics(open)
  const hw = diagnostics?.hardware

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
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
          {diagnostics ? (
            <div className="pix-settings__diag">
              <DiagRow
                label="Enhancement engine"
                value={
                  diagnostics.engineDevice === 'CPU'
                    ? 'Processor (no compatible GPU found)'
                    : `GPU acceleration (${diagnostics.engineDevice})`
                }
              />
              {hw && (
                <DiagRow
                  label="Processor"
                  value={`${hw.cpuName} · ${hw.physicalCores || hw.logicalProcessors} cores`}
                />
              )}
              {hw && <DiagRow label="Memory" value={`${formatBytes(hw.totalMemoryBytes)} total`} />}
              {hw && hw.gpus.length > 0 && (
                <DiagRow
                  label="Graphics adapters"
                  value={hw.gpus
                    .map(
                      (g) =>
                        `${g.name}${g.dedicatedVideoBytes ? ` · ${formatBytes(g.dedicatedVideoBytes)}` : ''}${g.directx12 ? '' : ' (no DirectX 12)'}`,
                    )
                    .join('; ')}
                />
              )}
              <DiagRow
                label="Memory strategy"
                value={`Tiles ≤ ${formatBytes(diagnostics.maxTileBytes)} · bands ≤ ${formatBytes(diagnostics.maxBandBytes)} (${diagnostics.memoryLimit})`}
              />
              <p className="pix-settings__note">
                Pixora picks GPU acceleration when available and falls back to the processor
                automatically — large or detailed images use smaller tiles to stay within memory. If
                a run needs more than the machine can spare, it reports the limit instead of
                failing.
              </p>
            </div>
          ) : failed ? (
            <p className="pix-settings__note">
              Engine diagnostics are unavailable right now. Restart Pixora if this persists.
            </p>
          ) : (
            <p className="pix-settings__note">Reading hardware information…</p>
          )}
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
