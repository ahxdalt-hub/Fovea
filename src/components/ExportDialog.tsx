/**
 * ExportDialog (Stage 06) — save the enhancement result.
 *
 * Three decisions, in the order a user thinks about them:
 * 1. Format — PNG (lossless copy of the master), JPEG, or WebP.
 * 2. Quality — a real knob for the lossy formats; PNG hides it because
 *    there is no quality to trade (the export is byte-identical).
 * 3. Where — Pixora's export folder by default; the native folder picker
 *    changes it. The webview never touches the filesystem: the dialog
 *    returns a path and the Rust side resolves the committed master
 *    server-side by image id.
 *
 * The dialog reports its outcome through app state (`exports/set`) and a
 * success notification, and closes — the workspace keeps the picture
 * center stage while the file is written.
 */
import { useCallback, useState } from 'react'
import { exportEnhancedImage, pickExportFolder } from '../ipc/bridge'
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

const FORMATS: Array<{ value: ExportFormatKey; label: string; hint: string }> = [
  { value: 'png', label: 'PNG', hint: 'Lossless · largest file' },
  { value: 'jpeg', label: 'JPEG', hint: 'Photo-quality · small file' },
  { value: 'webp', label: 'WebP', hint: 'Modern · small with alpha' },
]

export function ExportDialog({
  open,
  onClose,
  imageId,
  imageName,
  resultWidth,
  resultHeight,
  resultLabel,
  onExported,
}: ExportDialogProps) {
  const { dispatch } = useAppState()
  const { notify } = useNotify()
  const [format, setFormat] = useState<ExportFormatKey>('png')
  const [quality, setQuality] = useState(90)
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const lossy = format !== 'png'

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
      open={open}
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
          name="pixora-export-format"
          value={format}
          onChange={(value) => setFormat(value as ExportFormatKey)}
          options={FORMATS.map((f) => ({ value: f.value, label: f.label }))}
          hint={FORMATS.find((f) => f.value === format)?.hint}
        />

        {lossy && (
          <div className="pix-field pix-export__quality">
            <label className="pix-field__label" htmlFor="pixora-export-quality">
              Quality <span className="u-tabular">{quality}</span>
            </label>
            <input
              id="pixora-export-quality"
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
            <span className="pix-export__path" title={folder || undefined}>
              {folder || "Pixora's export folder"}
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
              ? 'A chosen folder on this machine.'
              : 'The app data folder — change it to save anywhere.'}
          </p>
        </div>
      </div>
    </Dialog>
  )
}
