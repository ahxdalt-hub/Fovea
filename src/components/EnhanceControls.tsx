/**
 * EnhanceControls — the Stage 06 enhancement strip for the Enhance view.
 *
 * Sits in the collection bar and carries the whole enhance interaction:
 * the scale and mode choices (SegmentedFields, offering only what the
 * installed models genuinely deliver — read from the native status, never
 * hard-coded), the primary Enhance action, and the honest job lifecycle:
 * measured progress from native tile counts, cancel, failure/retry, and a
 * completion state that hands the result to the compare slider and the
 * Export action.
 *
 * The workflow it encodes is Select → Enhance → Compare → Export, in that
 * reading order, with the image kept dominant: all of this is one compact
 * strip above the workspace, not a panel that competes with the picture.
 */
import { useEffect, useMemo } from 'react'
import type { EnhanceModeKey } from '../types/ipc'
import { useAppState } from '../state/useAppState'
import { useSettings } from '../state/useSettings'
import type { ProcessingSettings } from '../state/settings'
import type { EnhanceApi } from '../state/useEnhance'
import { Button } from '../ui/Button'
import { SegmentedField } from '../ui/Field'
import { ProgressBar, Spinner } from '../ui/Progress'
import { Tooltip } from '../ui/Tooltip'
import { IconExport, IconRetry, IconSparkle, IconWarning } from '../ui/Icons'
import { formatDimensions } from '../lib/format'
import { MODE_HINT, MODE_LABEL, MODE_ORDER } from '../lib/catalog'
import { isTauriRuntime } from '../state/useNativeFileDrop'
import './EnhanceControls.css'

/** Phase label — calm, specific, never technical. */
function phaseLabel(phase: string, done: number, total: number, cancelling: boolean): string {
  if (cancelling) return 'Cancelling…'
  switch (phase) {
    case 'preparing':
      return 'Preparing image…'
    case 'processing':
      return total > 0 ? `Processing · tile ${done} of ${total}` : 'Processing…'
    case 'completing':
      return 'Finalizing output…'
    case 'completed':
      return 'Enhanced'
    case 'cancelled':
      return 'Cancelled'
    default:
      return 'Failed'
  }
}

/** Order + labels + hints live in the shared catalog (src/lib/catalog)
 * so the strip, batch, export and Settings all speak the same words. */

export interface EnhanceControlsProps {
  enhanceApi: EnhanceApi
  /** The image the workspace is showing — the job's subject. */
  selectedId: string | null
  /** Opens the export dialog (Stage 06) for the current result. */
  onExport: () => void
  /** Ask the workspace to switch into compare mode (completion CTA). */
  onCompare: () => void
}

export function EnhanceControls({
  enhanceApi,
  selectedId,
  onExport,
  onCompare,
}: EnhanceControlsProps) {
  const { state } = useAppState()
  const { settings, update } = useSettings()
  const job = state.enhanceJob
  const status = state.inference
  const native = isTauriRuntime()
  // Stage 10: the strip's mode + scale ARE the persisted processing
  // defaults — the workspace choice and the Settings page read and write
  // one value, so "what I usually use" is decided exactly once.
  const processing = settings.processing
  // Stable identity: this is the settings slice, not a fresh object per
  // render (the self-heal effect below depends on it).
  const choices = useMemo(
    () => ({ scale: processing.defaultScale, mode: processing.defaultMode }),
    [processing],
  )

  const active =
    job !== null &&
    (job.phase === 'preparing' || job.phase === 'processing' || job.phase === 'completing')
  const terminal = job !== null && !active
  const modelReady = status === null || status.ready

  // Scales / modes offered are exactly what the installed models support.
  // Before the first native status arrives, fall back to the defaults the
  // bundled models ship with (4× native + 2× resampled; Standard).
  const scales = useMemo(() => (status ? status.scales : [2, 4]), [status])
  const availableModes = useMemo(() => {
    if (!status) return new Set(MODE_ORDER) // pre-fetch / preview: honest defaults
    return new Set(status.modes.filter((m) => m.available).map((m) => m.key as EnhanceModeKey))
  }, [status])
  const modeOptions = MODE_ORDER.filter((m) => availableModes.has(m))

  // Self-heal a stored choice the engine can't deliver (e.g. a model was
  // removed): snap to the nearest supported value instead of a dead
  // button. Guarded on non-empty option sets — with no model installed
  // there is nothing to snap to, and the action is simply disabled.
  useEffect(() => {
    const fixes: Partial<ProcessingSettings> = {}
    if (scales.length > 0 && !scales.includes(choices.scale)) {
      fixes.defaultScale = scales[scales.length - 1]
    }
    if (availableModes.size > 0 && !availableModes.has(choices.mode)) {
      const first = MODE_ORDER.find((m) => availableModes.has(m))
      if (first) fixes.defaultMode = first
    }
    if (Object.keys(fixes).length > 0) update('processing', fixes)
  }, [scales, availableModes, choices, update])

  // The fraction is a measurement: completed tiles / planned tiles.
  const percent =
    job && job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : undefined

  const startEnhance = () => {
    if (selectedId) void enhanceApi.run(selectedId, { mode: choices.mode, scale: choices.scale })
  }
  const dismiss = () => enhanceApi.dismiss()

  const changeScale = (value: string) => update('processing', { defaultScale: Number(value) })
  const changeMode = (value: string) =>
    update('processing', { defaultMode: value as EnhanceModeKey })

  const enhanced = selectedId ? (state.enhancements[selectedId] ?? null) : null
  const showExportButton = enhanced !== null && !active

  return (
    <div className="pix-enhance">
      <div className="pix-enhance__actions">
        {status && !status.ready && (
          <span className="pix-enhance__warn" role="status">
            <IconWarning size="sm" />
            {status.models.some((m) => m.state === 'corrupt')
              ? 'Model file damaged — add it to Pixora’s models folder'
              : 'AI model not installed — add it to Pixora’s models folder'}
          </span>
        )}

        {scales.length > 1 ? (
          <SegmentedField
            label="Scale"
            labelInline
            name="pixora-scale"
            value={String(choices.scale)}
            onChange={changeScale}
            disabled={active}
            options={scales.map((s) => ({ value: String(s), label: `${s}×` }))}
          />
        ) : null}
        {modeOptions.length > 1 && (
          <SegmentedField
            label="Mode"
            labelInline
            name="pixora-mode"
            value={choices.mode}
            onChange={changeMode}
            disabled={active}
            options={modeOptions.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
          />
        )}
        {modeOptions.length > 1 && (
          <span
            className="pix-enhance__modehint"
            title={status?.modes.find((m) => m.key === choices.mode)?.description}
          >
            {status?.modes.find((m) => m.key === choices.mode)?.description ??
              MODE_HINT[choices.mode]}
          </span>
        )}

        <span className="pix-enhance__spacer" aria-hidden="true" />

        {showExportButton && (
          <Button
            variant="secondary"
            size="sm"
            iconStart={<IconExport size="sm" />}
            onClick={onExport}
          >
            Export…
          </Button>
        )}
        <Tooltip
          content={
            !native
              ? 'Enhancement runs in the desktop app'
              : !modelReady
                ? 'Install the enhancement model first'
                : active
                  ? 'An enhancement is already running'
                  : undefined
          }
          side="bottom"
        >
          <Button
            variant="primary"
            size="md"
            iconStart={active ? <Spinner /> : <IconSparkle size="sm" />}
            disabled={!native || !modelReady || active || !selectedId}
            onClick={startEnhance}
          >
            {active ? `Enhancing ${choices.scale}×…` : `Enhance ${choices.scale}×`}
          </Button>
        </Tooltip>
        {terminal && job && (
          <Button variant="ghost" size="sm" onClick={dismiss}>
            {job.phase === 'failed' ? 'Dismiss error' : 'Hide'}
          </Button>
        )}
      </div>

      {job && (
        <div className="pix-enhance__panel anim-fade" role="status" aria-live="polite">
          <div className="pix-enhance__row">
            <span className="pix-enhance__phase">
              {phaseLabel(job.phase, job.done, job.total, job.cancelling)}
            </span>
            {/* Stage 07: which path the engine reports running on — a
                fact from native (re-emitted honestly if a GPU attempt
                falls back mid-job), kept small so the image stays the
                story. GPU users barely notice it; CPU fallback reads
                calm, never alarming. */}
            {active && job.device && (
              <Tooltip
                content={
                  job.device === 'CPU'
                    ? 'Enhancing with the processor — GPU acceleration is unavailable on this machine'
                    : 'Enhancing with GPU acceleration'
                }
                side="bottom"
              >
                <span className="pix-enhance__device">
                  {job.device === 'CPU' ? 'Processor' : 'GPU'}
                </span>
              </Tooltip>
            )}
            <span className="pix-enhance__spacer" aria-hidden="true" />
            {active && job.jobId && (
              <Button variant="ghost" size="sm" onClick={() => void enhanceApi.cancel()}>
                Cancel
              </Button>
            )}
            {job.phase === 'failed' && (
              <Button
                variant="secondary"
                size="sm"
                iconStart={<IconRetry size="sm" />}
                onClick={startEnhance}
              >
                Retry
              </Button>
            )}
          </div>
          {active && <ProgressBar value={percent} label="Enhancement progress" />}
          {job.phase === 'failed' && job.error && (
            <span className="pix-enhance__error">{job.error.message}</span>
          )}
          {job.phase === 'completed' && (
            <div className="pix-enhance__result anim-rise">
              <span className="pix-enhance__done">
                {enhanced
                  ? `${formatDimensions(enhanced.width, enhanced.height)} · ${enhanced.label} — in the compare view below`
                  : 'Enhanced — the result is in the compare view'}
              </span>
              <span className="pix-enhance__result-actions">
                <Button variant="secondary" size="sm" onClick={onCompare}>
                  Compare
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  iconStart={<IconExport size="sm" />}
                  onClick={onExport}
                >
                  Export
                </Button>
              </span>
            </div>
          )}
          {job.phase === 'cancelled' && (
            <span className="pix-enhance__hint">Cancelled — nothing was written.</span>
          )}
        </div>
      )}
    </div>
  )
}
