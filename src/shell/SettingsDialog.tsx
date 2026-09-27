/**
 * Settings (Stage 10) — Pixora's preferences, organized the way users
 * think about the app, not the way the code stores them.
 *
 * Structure: a left category rail (General · Processing · Export ·
 * Performance · Diagnostics) with one focused section on the right at a
 * time — every screen stays short enough to read, and switching sections
 * is a visible, animated navigation, not a wall of controls.
 *
 * Language rules for this dialog:
 * - A normal photographer must be able to change every control. "Graphics
 *   card" and "processor", never "DirectML" or "VRAM" — the raw names
 *   belong to Diagnostics, which is for looking, not tuning.
 * - Every control carries one honest sentence about what it does; a
 *   setting without a clear user benefit is not a setting (memory sizing,
 *   tile ceilings and thread internals are the engine's job and are only
 *   reported in Diagnostics).
 * - Changes take effect immediately and persist; the dialog is never a
 *   form with a Save button.
 */
import { useEffect, useState } from 'react'
import { getDiagnostics, openLogsFolder, pickExportFolder } from '../ipc/bridge'
import type { DiagnosticsDto } from '../types/ipc'
import { formatBytes } from '../lib/format'
import { FORMATS, MODE_HINT, MODE_LABEL, MODE_ORDER } from '../lib/catalog'
import { useAppState } from '../state/useAppState'
import { useSettings } from '../state/useSettings'
import { isTauriRuntime } from '../state/useNativeFileDrop'
import type { EnhanceModeKey, ExportFormatKey } from '../types/ipc'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { SegmentedField, SelectField, ToggleField } from '../ui/Field'
import { IconFolder, IconMonitor, IconMoon, IconSun } from '../ui/Icons'
import './Dialogs.css'

export interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

type Category = 'general' | 'processing' | 'export' | 'performance' | 'diagnostics'

const CATEGORIES: Array<{ id: Category; label: string; blurb: string }> = [
  { id: 'general', label: 'General', blurb: 'Appearance and startup' },
  { id: 'processing', label: 'Processing', blurb: 'How images get enhanced' },
  { id: 'export', label: 'Export', blurb: 'Format, quality and where files go' },
  { id: 'performance', label: 'Performance', blurb: 'How hard Pixora uses your machine' },
  { id: 'diagnostics', label: 'Diagnostics', blurb: 'Version, hardware and logs' },
]

/** Fetch diagnostics once per dialog visit; failures leave the section
 * honest ("unavailable") rather than stale. */
function useDiagnostics() {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsDto | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
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
  }, [])
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

function SectionHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <header className="pix-settings__section-head">
      <h3 className="pix-settings__section-title">{title}</h3>
      <p className="pix-settings__section-blurb">{blurb}</p>
    </header>
  )
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  // Closed = unmounted. Every open is a fresh visit: the dialog starts at
  // General, diagnostics re-read, and no mid-list category or stale
  // report lingers from the last one. Settings dialogs are read top-down.
  if (!open) return null
  return <SettingsBody onClose={onClose} />
}

function SettingsBody({ onClose }: { onClose: () => void }) {
  const { state } = useAppState()
  const { settings, update } = useSettings()
  const { diagnostics, failed } = useDiagnostics()
  const [category, setCategory] = useState<Category>('general')

  const native = isTauriRuntime()
  const hw = diagnostics?.hardware
  const inference = state.inference

  const changeFolder = async () => {
    try {
      const chosen = await pickExportFolder()
      if (chosen) update('export', { folder: chosen })
    } catch {
      // A canceled/failed picker keeps the current choice — not a
      // data problem worth interrupting a settings visit for.
    }
  }

  const modeOptions = MODE_ORDER.map((m) => ({ value: m, label: MODE_LABEL[m] }))
  const modeHint =
    inference?.modes.find((m) => m.key === settings.processing.defaultMode)?.description ??
    MODE_HINT[settings.processing.defaultMode]

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Settings"
      description="Preferences are stored on this computer and applied immediately."
    >
      <div className="pix-settings">
        <nav className="pix-settings__nav" aria-label="Settings sections">
          {CATEGORIES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`pix-settings__nav-item${
                category === item.id ? ' pix-settings__nav-item--active' : ''
              }`}
              aria-current={category === item.id || undefined}
              onClick={() => setCategory(item.id)}
            >
              <span className="pix-settings__nav-label">{item.label}</span>
              <span className="pix-settings__nav-blurb">{item.blurb}</span>
            </button>
          ))}
        </nav>

        {/* key remounts the panel so each section enters with the shared
            fade — the navigation reads as movement, not a content swap. */}
        <div className="pix-settings__panel" key={category}>
          <div className="pix-settings__content anim-fade">
            {category === 'general' && (
              <>
                <SectionHeader title="General" blurb="How Pixora looks and how it opens." />
                <SegmentedField
                  label="Appearance"
                  value={settings.general.theme}
                  onChange={(value) =>
                    update('general', { theme: value as typeof settings.general.theme })
                  }
                  options={[
                    { value: 'system', label: 'System', icon: <IconMonitor size="sm" /> },
                    { value: 'light', label: 'Light', icon: <IconSun size="sm" /> },
                    { value: 'dark', label: 'Dark', icon: <IconMoon size="sm" /> },
                  ]}
                  hint="System follows Windows' light or dark setting."
                />
                <SelectField
                  label="On startup"
                  value={settings.general.startupView}
                  onChange={(event) =>
                    update('general', {
                      startupView: event.target.value as typeof settings.general.startupView,
                    })
                  }
                >
                  <option value="last">Open the last thing I was doing</option>
                  <option value="enhance">Open the Enhance workspace</option>
                  <option value="batch">Open Batch</option>
                  <option value="history">Open History</option>
                </SelectField>
                <div className="pix-settings__group">
                  <ToggleField
                    label="Remember recent files"
                    description="Pixora keeps a short list of files you have worked on — names and locations only, never copies — so a fresh window can offer to pick up where you left off."
                    checked={settings.general.rememberRecentFiles}
                    onChange={(checked) => update('general', { rememberRecentFiles: checked })}
                  />
                  {settings.general.rememberRecentFiles && (
                    <SelectField
                      label="Recent files to offer"
                      value={String(settings.general.recentFilesLimit)}
                      onChange={(event) =>
                        update('general', { recentFilesLimit: Number(event.target.value) })
                      }
                      hint="Shown when nothing is open."
                      className="pix-settings__nested"
                    >
                      {[3, 6, 9, 12].map((n) => (
                        <option key={n} value={String(n)}>
                          {n} files
                        </option>
                      ))}
                    </SelectField>
                  )}
                </div>
              </>
            )}

            {category === 'processing' && (
              <>
                <SectionHeader
                  title="Processing"
                  blurb="What the Enhance strip starts with. Change it there anytime — your last choice returns here automatically."
                />
                <SegmentedField
                  label="Default scale"
                  value={String(settings.processing.defaultScale)}
                  onChange={(value) => update('processing', { defaultScale: Number(value) })}
                  options={[
                    { value: '2', label: '2×' },
                    { value: '4', label: '4×' },
                  ]}
                  hint="How much larger the result gets. 4× suits prints; 2× is often plenty for screens."
                />
                <SegmentedField
                  label="Default enhancement"
                  value={settings.processing.defaultMode}
                  onChange={(value) =>
                    update('processing', { defaultMode: value as EnhanceModeKey })
                  }
                  options={modeOptions}
                  hint={modeHint}
                />
                <SegmentedField
                  label="Pixora should use"
                  value={settings.processing.enginePath}
                  onChange={(value) =>
                    update('processing', {
                      enginePath: value as typeof settings.processing.enginePath,
                    })
                  }
                  options={[
                    { value: 'auto', label: 'Graphics card when it helps' },
                    { value: 'cpu', label: 'The processor' },
                  ]}
                  hint={
                    settings.processing.enginePath === 'auto'
                      ? 'Recommended. If a graphics card can genuinely speed things up on this machine, Pixora uses it; otherwise it quietly works on the processor instead. Nothing ever fails over a missing GPU.'
                      : 'Slower on most machines. Useful if graphics drivers behave oddly — enhancement keeps working, just without acceleration.'
                  }
                />
                <p className="pix-settings__footnote">
                  Memory and tiling are never a setting: Pixora measures what your machine has spare
                  and sizes each run to fit, shrinking automatically under pressure.
                </p>
              </>
            )}

            {category === 'export' && (
              <>
                <SectionHeader
                  title="Export"
                  blurb="The starting point every Export dialog and batch run begins from."
                />
                <SegmentedField
                  label="Default format"
                  value={settings.export.format}
                  onChange={(value) => update('export', { format: value as ExportFormatKey })}
                  options={FORMATS.map((f) => ({ value: f.value, label: f.label }))}
                  hint={FORMATS.find((f) => f.value === settings.export.format)?.hint}
                />
                <div
                  className={`pix-field${settings.export.format === 'png' ? ' pix-settings__dimmed' : ''}`}
                >
                  <label className="pix-field__label" htmlFor="pixora-settings-quality">
                    Quality for JPEG and WebP{' '}
                    <span className="u-tabular">{settings.export.quality}</span>
                  </label>
                  <input
                    id="pixora-settings-quality"
                    className="pix-range"
                    type="range"
                    min={1}
                    max={100}
                    step={1}
                    value={settings.export.quality}
                    onChange={(event) => update('export', { quality: Number(event.target.value) })}
                  />
                  <p className="pix-field__message">
                    Higher keeps more detail and grows the file. 90 is a good print-quality default.
                    PNG ignores quality — its export keeps every pixel.
                  </p>
                </div>
                <div className="pix-field">
                  <span className="pix-field__label">Default folder</span>
                  <div className="pix-settings__folder">
                    <span
                      className="pix-settings__path"
                      title={settings.export.folder || undefined}
                    >
                      {settings.export.folder || "Pixora's export folder"}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      iconStart={<IconFolder size="sm" />}
                      disabled={!native}
                      onClick={() => void changeFolder()}
                    >
                      Change…
                    </Button>
                    {settings.export.folder && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => update('export', { folder: '' })}
                      >
                        Use Pixora's
                      </Button>
                    )}
                  </div>
                  <p className="pix-field__message">
                    {native
                      ? 'Exports and batches start here; you can still choose a different folder each time.'
                      : 'The folder picker needs the desktop app.'}
                  </p>
                </div>
              </>
            )}

            {category === 'performance' && (
              <>
                <SectionHeader
                  title="Performance"
                  blurb="One honest trade-off: use the whole machine, or leave it responsive."
                />
                <SegmentedField
                  label="Processing power"
                  value={settings.performance.speed}
                  onChange={(value) =>
                    update('performance', { speed: value as typeof settings.performance.speed })
                  }
                  options={[
                    { value: 'balanced', label: 'Keep things responsive' },
                    { value: 'maximum', label: 'Use the full machine' },
                  ]}
                  hint={
                    settings.performance.speed === 'balanced'
                      ? 'Recommended. Enhancement shares the machine with everything else you do — browsing, email, the window itself stays smooth. Usually the same speed, too.'
                      : 'A long run may use every processor the machine has. Slightly faster on an otherwise idle computer; expect the rest of Windows to feel busier while it works.'
                  }
                />
                <p className="pix-settings__footnote">
                  That is the whole performance page on purpose. Tile sizes, buffer ceilings and
                  thread counts are derived from your hardware every run — the numbers live under
                  Diagnostics for anyone curious, and under no settings because no user should have
                  to know what they mean.
                </p>
              </>
            )}

            {category === 'diagnostics' && (
              <>
                <SectionHeader
                  title="Diagnostics"
                  blurb="Read-only facts about this installation and machine, for troubleshooting."
                />
                {state.config && <DiagRow label="Pixora version" value={state.config.version} />}
                {state.systemInfo && (
                  <DiagRow
                    label="Running on"
                    value={`${state.systemInfo.osFamily} · ${state.systemInfo.arch}`}
                  />
                )}

                <div className="pix-settings__group">
                  <span className="u-caps-label">Enhancement engine</span>
                  {diagnostics ? (
                    <div className="pix-settings__diag">
                      <DiagRow
                        label="Device"
                        value={
                          diagnostics.engineDevice === 'CPU'
                            ? 'Processor'
                            : `Graphics card (${diagnostics.engineDevice})`
                        }
                      />
                      {hw && (
                        <DiagRow
                          label="Processor"
                          value={`${hw.cpuName} · ${hw.physicalCores || hw.logicalProcessors} cores`}
                        />
                      )}
                      {hw && (
                        <DiagRow
                          label="Memory"
                          value={`${formatBytes(hw.totalMemoryBytes)} total`}
                        />
                      )}
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
                        label="Run sizes"
                        value={`Tiles ≤ ${formatBytes(diagnostics.maxTileBytes)} · bands ≤ ${formatBytes(diagnostics.maxBandBytes)} (${diagnostics.memoryLimit})`}
                      />
                      <p className="pix-settings__note">
                        These are the ceilings Pixora derived from this machine — it never asks your
                        permission to shrink them, only reports when it had to.
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

                <div className="pix-settings__group">
                  <span className="u-caps-label">Enhancement models</span>
                  {inference ? (
                    inference.modes.map((m) => (
                      <DiagRow
                        key={m.key}
                        label={MODE_LABEL[m.key as EnhanceModeKey] ?? m.label}
                        value={m.available ? 'Ready' : 'Not installed'}
                      />
                    ))
                  ) : (
                    <p className="pix-settings__note">
                      Model status loads once the engine has been asked to enhance something.
                    </p>
                  )}
                </div>

                <div className="pix-settings__group">
                  <span className="u-caps-label">Storage</span>
                  {state.systemInfo && (
                    <p className="pix-settings__note">
                      Application data lives in{' '}
                      <code className="pix-settings__path">{state.systemInfo.appDataDir}</code>
                    </p>
                  )}
                  {inference && (
                    <p className="pix-settings__note">
                      Enhancement models live in{' '}
                      <code className="pix-settings__path">{inference.modelsDirDisplay}</code>
                    </p>
                  )}
                  {state.systemInfo && (
                    <div className="pix-settings__logs">
                      <p className="pix-settings__note">
                        Logs are written to{' '}
                        <code className="pix-settings__path">{state.systemInfo.logsDir}</code>
                      </p>
                      {native && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void openLogsFolder().catch(() => undefined)}
                        >
                          Open logs folder
                        </Button>
                      )}
                    </div>
                  )}
                  <p className="pix-settings__note">
                    Pixora's log files record what the app did — never your images, and never a copy
                    of them.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
