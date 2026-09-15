/**
 * EnhanceControls — the Stage 05 action strip for the Enhance view.
 *
 * Sits in the collection bar: the engine's readiness chip (honest —
 * shows "model missing" when the native registry finds nothing), the
 * Enhance 4× action, and — while a job runs — a progress row driven by
 * the *native tile counts* (a real fraction, never an animated guess),
 * plus cancel.
 *
 * Like every Stage 05 surface: no faked states. Idle with no result is
 * an action; running is a measured phase; failure is a retry; a
 * completed result is handed to the workspace's compare slider.
 */
import { useAppState } from '../state/useAppState'
import type { EnhanceApi } from '../state/useEnhance'
import { Button } from '../ui/Button'
import { ProgressBar, Spinner } from '../ui/Progress'
import { Tooltip } from '../ui/Tooltip'
import { IconRetry, IconSparkle } from '../ui/Icons'
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

export interface EnhanceControlsProps {
  enhanceApi: EnhanceApi
  /** The image the workspace is showing — the job's subject. */
  selectedId: string | null
}

export function EnhanceControls({ enhanceApi, selectedId }: EnhanceControlsProps) {
  const { state } = useAppState()
  const job = state.enhanceJob
  const status = state.inference
  const native = isTauriRuntime()

  const active =
    job !== null &&
    (job.phase === 'preparing' || job.phase === 'processing' || job.phase === 'completing')
  const terminal = job !== null && !active
  const modelReady = status === null || status.ready

  // The fraction is a measurement: completed tiles / planned tiles.
  const percent =
    job && job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : undefined

  const startEnhance = () => {
    if (selectedId) void enhanceApi.run(selectedId)
  }
  const dismiss = () => enhanceApi.dismiss()

  return (
    <div className="pix-enhance">
      <div className="pix-enhance__actions">
        {status && !status.ready && (
          <span className="pix-enhance__warn" role="status">
            {status.models[0]?.state === 'corrupt'
              ? 'Model file damaged'
              : 'AI model not installed'}
          </span>
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
            size="sm"
            iconStart={active ? <Spinner /> : <IconSparkle size="sm" />}
            disabled={!native || !modelReady || active}
            onClick={startEnhance}
          >
            Enhance 4×
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
            <span className="pix-enhance__done">
              Result is in the compare view — toggle it with the slider button.
            </span>
          )}
        </div>
      )}
    </div>
  )
}
