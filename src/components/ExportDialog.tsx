/**
 * ExportDialog (Stage 06, Stage 10 defaults) — save the enhancement result.
 *
 * Three decisions, in the order a user thinks about them:
 * 1. Format — PNG (lossless copy of the master), JPEG, or WebP.
 * 2. Quality — a real knob for the lossy formats; PNG hides it because
 *    there is no quality to trade (the export is byte-identical).
 * 3. Where — Fovea's own folder (`Documents/Fovea`) by default; the native
 *    folder picker changes it for this export. The webview never touches
 *    the filesystem: the dialog returns a path and the Rust side resolves
 *    the committed master server-side by image id.
 *
 * Once the file is on disk the Rust side opens File Explorer on it — the
 * user lands on what they just made, in the folder the app named.
 *
 * Stage 10: the starting point for all three is the persisted export
 * defaults — and a *change made here is for this export only*. The
 * dialog's local choices are seeded per open (closed = unmounted), so a
 * fresh visit always reflects the Settings page.
 *
 * The dialog reports its outcome through app state (`exports/set`) and a
 * success notification, and closes — the workspace keeps the picture
 * center stage while the file is written.
 */
import { useCallback, useState } from 'react'
import { exportEnhancedImage, openExportFolder, pickExportFolder } from '../ipc/bridge'
import { FORMATS } from '../lib/catalog'
import { useAppState } from '../state/useAppState'
import { useNotify } from '../ui/notificationContext'
import type { ExportFormatKey, ExportResultDto } from '../types/ipc'
import { toAppError } from '../types/ipc'
import { formatBytes, formatDimensions } from '../lib/format'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { SegmentedField } from '../ui/Field'
import { Spinner } from '../ui/Progress'
import { IconExport, IconFolder } from '../ui/Icons'
import './ExportDialog.css'

export interface ExportDialogProps {
  open: boolean
  onClose: () => void
  /** The image being exported; the native side resolves its committed
   * master from this id — no path crosses from the UI. */
  imageId: string | null
  /** Imported file name — shown for orientation, drives the export stem. */
  imageName: string | null
  /** Result dimensions, e.g. 3840 × 2160. */
  resultWidth: number
  resultHeight: number
  /** Result label, e.g. "4× · Standard". */
  resultLabel: string | null
  /** Called after a successful export (dialog closes on its own). */
  onExported?: (result: ExportResultDto) => void
}

export function ExportDialog(props: ExportDialogProps) {
  // Closed = unmounted: the body's local choices (format, quality,
  // folder) seed from the persisted defaults exactly once per open —
  // no sync effect, no leftovers from a canceled visit.
  if (!props.open) return null
  return <ExportDialogBody {...props} />
}

function ExportDialogBody({
  onClose,
  imageId,
  imageName,
  resultWidth,
  resultHeight,
  resultLabel,
  onExported,
}: ExportDialogProps) {
  const { state, dispatch } = useAppState()
  const { notify } = useNotify()
  const defaults = state.settings.export
  const [format, setFormat] = useState<ExportFormatKey>(defaults.format)
  const [quality, setQuality] = useState(defaults.quality)
  const [folder, setFolder] = useState(defaults.folder)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const lossy = format !== 'png'
  /** Fovea's own folder, named by the native layer (`Documents/Fovea`).
   * Empty until that answer exists — the label then stays generic. */
  const foveaFolder = state.systemInfo?.defaultExportDir ?? ''
  const shownFolder = folder || foveaFolder

  const chooseFolder = useCallback(async () => {
    try {
      const chosen = await pickExportFolder()
      if (chosen) setFolder(chosen) // cancel keeps the current choice
    } catch (err) {
      setError(toAppError(err).message)
    }
  }, [])

  const runExport = useCallback(async () => {
    if (!imageId || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await exportEnhancedImage(imageId, format, quality, folder)
      dispatch({ type: 'exports/set', imageId, result })
      notify(
        'success',
        `Saved ${result.fileName} (${formatBytes(result.bytes)}) — ${result.folder}`,
      )
      // Land the user on the file they just made. The folder is the one the
      // native layer wrote to, so this can never open an arbitrary place;
      // a refused Explorer window is reported, never swallowed.
      try {
        await openExportFolder()
      } catch (err) {
        notify('warning', `${toAppError(err).message} — ${result.folder}`)
      }
      onExported?.(result)
      onClose()
    } catch (err) {
      setError(toAppError(err).message)
    } finally {
      setBusy(false)
    }
  }, [imageId, busy, format, quality, folder, dispatch, notify, onClose, onExported])

  return (
    <Dialog
      open
      onClose={onClose}
      title="Export enhanced image"
      size="sm"
      description={
        imageId && imageName
          ? `${imageName} · ${formatDimensions(resultWidth, resultHeight)}${resultLabel ? ` · ${resultLabel}` : ''}`
          : undefined
      }
      footer={
        <>
          {error && <span className="pix-export__error">{error}</span>}
          <span className="pix-export__foot-spacer" aria-hidden="true" />
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconStart={busy ? <Spinner /> : <IconExport size="sm" />}
            disabled={!imageId || busy}
            onClick={() => void runExport()}
          >
            {busy ? 'Saving…' : 'Export'}
          </Button>
        </>
      }
    >
      <div className="pix-export">
        <SegmentedField
          label="Format"
          name="fovea-export-format"
          value={format}
          onChange={(value) => setFormat(value as ExportFormatKey)}
          options={FORMATS.map((f) => ({ value: f.value, label: f.label }))}
          hint={FORMATS.find((f) => f.value === format)?.hint}
        />

        {lossy && (
          <div className="pix-field pix-export__quality">
            <label className="pix-field__label" htmlFor="fovea-export-quality">
              Quality <span className="u-tabular">{quality}</span>
            </label>
            <input
              id="fovea-export-quality"
              className="pix-range"
              type="range"
              min={1}
              max={100}
              step={1}
              value={quality}
              onChange={(event) => setQuality(Number(event.target.value))}
            />
            <p className="pix-field__message">
              Higher keeps more detail and grows the file. 90 is a good print-quality default.
            </p>
          </div>
        )}

        <div className="pix-field">
          <span className="pix-field__label">Save to</span>
          <div className="pix-export__folder">
            <span className="pix-export__path" title={shownFolder || undefined}>
              {shownFolder || "Fovea's export folder"}
            </span>
            <Button
              variant="secondary"
              size="sm"
              iconStart={<IconFolder size="sm" />}
              onClick={() => void chooseFolder()}
            >
              Change…
            </Button>
          </div>
          <p className="pix-field__message">
            {folder
              ? 'A folder you chose on this machine.'
              : "Fovea's own folder inside your Documents."}{' '}
            File Explorer opens on the file as soon as it is saved.
          </p>
        </div>
      </div>
    </Dialog>
  )
}
