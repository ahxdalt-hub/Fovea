/**
 * EnhanceControls — the Stage 06 enhancement strip for the Enhance view.
 *
 * Sits in the collection bar and carries the whole enhance interaction: the
 * scale and mode choices (SegmentedFields), the finishing look (a preset, one
 * of the ten filters, and its strength), the primary Enhance action, and the
 * honest job lifecycle: measured progress from native tile counts, cancel,
 * failure/retry, and a completion state that hands the result to the compare
 * slider and the Export action.
 *
 * Two independent facts decide what each control offers (Stage 20), and both
 * are read rather than hard-coded: what the installed models genuinely
 * deliver, from the native inference status, and what the plan on this machine
 * allows, from the native license record. A choice the plan withholds is drawn
 * in place, unselectable, with that plan's name beside it — never removed,
 * because a feature you cannot see is a feature that does not exist.
 *
 * The workflow it encodes is Select → Enhance → Compare → Export, in that
 * reading order, with the image kept dominant: all of this is one compact
 * strip above the workspace, not a panel that competes with the picture.
 *
 * Presets are a convenience, not a hidden mode: choosing one writes the
 * same four values the strip shows, so what the button says and what the
 * engine runs are the same thing — and hand-tuning any control moves the
 * preset readout to "Custom".
 */
import { useEffect, useMemo } from 'react'
import type { EnhanceModeKey, FilterKey } from '../types/ipc'
import { useAppState } from '../state/useAppState'
import { useSettings } from '../state/useSettings'
import type { ProcessingSettings } from '../state/settings'
import type { EnhanceApi } from '../state/useEnhance'
import { Button } from '../ui/Button'
import { SegmentedField } from '../ui/Field'
import { ProgressBar, Spinner } from '../ui/Progress'
import { Tooltip } from '../ui/Tooltip'
import { cx } from '../ui/cx'
import { IconExport, IconRetry, IconSparkle, IconWarning } from '../ui/Icons'
import { formatDimensions } from '../lib/format'
import { availableFilterKeys, MODE_HINT, MODE_LABEL, MODE_ORDER } from '../lib/catalog'
import {
  filterLock,
  modeLock,
  periodLabel,
  planBadge,
  planName,
  planQuota,
  planScaleCeiling,
  planView,
  presetLock,
  scaleLock,
} from '../lib/entitlements'
import { matchingPreset, presetByKey, type PresetKey } from '../lib/presets'
import { LookFields, PresetChips } from './FinishingLook'
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
  // one value, so "what I usually use" is decided exactly once. Stage 19
  // adds the finishing look (filter + intensity) to the same record, so a
  // preset written here survives a restart and appears in Settings.
  const processing = settings.processing
  // Stable identity: this is the settings slice, not a fresh object per
  // render (the self-heal effect below depends on it).
  const choices = useMemo(
    () => ({
      scale: processing.defaultScale,
      mode: processing.defaultMode,
      filter: processing.defaultFilter,
      intensity: processing.defaultIntensity,
    }),
    [processing],
  )

  const active =
    job !== null &&
    (job.phase === 'preparing' || job.phase === 'processing' || job.phase === 'completing')
  const terminal = job !== null && !active
  const modelReady = status === null || status.ready
  // The plan in force, read once from the native license record. `null` (not
  // fetched yet) is *unknown*, not the free plan: nothing is locked and
  // nothing is repaired until native actually answers, so a Pro user never
  // sees a paywall flash on start and a stored 4× is never quietly rewritten.
  const plan = useMemo(() => planView(state.license), [state.license])

  // Scales / modes offered are exactly what the installed models support.
  // Before the first native status arrives, fall back to the defaults the
  // bundled models ship with (4× native + 2× resampled; Standard).
  const scales = useMemo(() => (status ? status.scales : [2, 4]), [status])
  const availableModes = useMemo(() => {
    if (!status) return new Set(MODE_ORDER) // pre-fetch / preview: honest defaults
    return new Set(status.modes.filter((m) => m.available).map((m) => m.key as EnhanceModeKey))
  }, [status])
  const modeOptions = MODE_ORDER.filter((m) => availableModes.has(m))

  // Filters are pixel math on data the engine already produced, so the
  // native list is complete by construction — but it is still the source of
  // the labels and hints, exactly like the modes.
  const filterOptions = useMemo<FilterKey[]>(
    () => availableFilterKeys(status?.filters ?? null),
    [status],
  )

  // The plan's layer on top: the same options, minus what this plan cannot
  // run. Everything the strip *does* (healing a stored choice, enabling the
  // Enhance button) is decided against these, so the button can never offer
  // a run that native would refuse.
  const ceiling = planScaleCeiling(plan)
  const runnableScales = useMemo(
    () => scales.filter((s) => ceiling === null || s <= ceiling),
    [scales, ceiling],
  )
  const runnableModes = useMemo(
    () => MODE_ORDER.filter((m) => availableModes.has(m) && modeLock(plan, m) === null),
    [availableModes, plan],
  )
  const runnableFilters = useMemo(
    () => filterOptions.filter((f) => filterLock(plan, f) === null),
    [filterOptions, plan],
  )
  // The recipe on screen is one this machine can actually run — true whenever
  // the strip is consistent, and false only in a corner where the plan and
  // the installed models together leave nothing runnable (a free plan with
  // only the restoration models installed, say).
  const recipeRunnable =
    runnableScales.includes(choices.scale) &&
    runnableModes.includes(choices.mode) &&
    runnableFilters.includes(choices.filter)

  // The free plan's month meter (Stage 20). `null` means this plan is not
  // metered — Pro and Studio simply never see a counter.
  const quota = planQuota(plan)
  const outOfCredits = quota !== null && quota.remaining <= 0
  const spentMessage = quota
    ? `You have used all ${quota.limit} free enhancements in ${periodLabel(quota.period)} — the count resets on the 1st, or ${planName('pro')} lifts it`
    : ''

  // The preset whose four values the strip currently shows. A hand-tuned
  // combination reads as "Custom" rather than lying about being "Photo".
  const activePreset = matchingPreset(choices)

  // Self-heal a stored choice this machine can't deliver (a model was
  // removed, or the plan changed under the settings that were written): snap
  // to the nearest runnable value instead of a dead button. Guarded on
  // non-empty option sets — with nothing runnable there is nothing to snap
  // to, and the action is simply disabled.
  useEffect(() => {
    const fixes: Partial<ProcessingSettings> = {}
    if (runnableScales.length > 0 && !runnableScales.includes(choices.scale)) {
      fixes.defaultScale = runnableScales[runnableScales.length - 1]
    }
    if (runnableModes.length > 0 && !runnableModes.includes(choices.mode)) {
      const first = runnableModes[0]
      if (first) fixes.defaultMode = first
    }
    // A look the plan withholds (or the product no longer offers) falls back
    // to "no filter" — the choice that cannot change the picture, which is
    // the safest thing to land on.
    if (runnableFilters.length > 0 && !runnableFilters.includes(choices.filter)) {
      fixes.defaultFilter = 'original'
    }
    if (Object.keys(fixes).length > 0) update('processing', fixes)
  }, [runnableScales, runnableModes, runnableFilters, choices, update])

  // The fraction is a measurement: completed tiles / planned tiles.
  const percent =
    job && job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : undefined

  const startEnhance = () => {
    // The whole recipe goes to native — mode, scale, and the finishing look.
    // Nothing is applied client-side, so the strip's readout is the run.
    if (selectedId) void enhanceApi.run(selectedId, choices)
  }
  const dismiss = () => enhanceApi.dismiss()

  const changeScale = (value: string) => update('processing', { defaultScale: Number(value) })
  const changeMode = (value: string) =>
    update('processing', { defaultMode: value as EnhanceModeKey })
  const changeLook = (patch: { filter?: FilterKey; intensity?: number }) =>
    update('processing', {
      ...(patch.filter === undefined ? {} : { defaultFilter: patch.filter }),
      ...(patch.intensity === undefined ? {} : { defaultIntensity: patch.intensity }),
    })
  /** Writes the preset's real parameters into the same record the controls
   * read — including the export hints, where the workflow genuinely wants a
   * different file. No hidden mode, no per-preset engine branch. */
  const applyPreset = (key: PresetKey) => {
    const preset = presetByKey(key)
    if (!preset || presetLock(plan, preset) !== null) return
    update('processing', {
      defaultScale: preset.processing.scale,
      defaultMode: preset.processing.mode,
      defaultFilter: preset.processing.filter,
      defaultIntensity: preset.processing.intensity,
    })
    if (preset.export) update('export', preset.export)
  }

  const enhanced = selectedId ? (state.enhancements[selectedId] ?? null) : null
  const showExportButton = enhanced !== null && !active
  // A job keeps running when the user selects a different image, so the
  // panel must say whose work it is — otherwise tile counts for another
  // picture read as progress on the one on screen. Its result CTAs are
  // withheld until that image is selected again: Compare and Export act on
  // the selected image, not the job's.
  const jobIsMine = job === null || job.imageId === selectedId
  const jobOwnerName =
    job && !jobIsMine ? state.images.find((i) => i.id === job.imageId)?.name : undefined

  return (
    <div className="pix-enhance">
      {/* Stage 19: the finishing look, first in the reading order because a
          preset writes the four values the whole strip shows — it is not a
          hidden mode. The filter and its strength are exactly the pixel pass
          the engine runs on the model's result. These are the same shared
          fields the batch preset renders, so the two surfaces can never
          describe one look with two different words. */}
      <div className="pix-enhance__look">
        <PresetChips
          active={activePreset?.key ?? null}
          disabled={active}
          lockFor={(preset) => presetLock(plan, preset)}
          onPick={applyPreset}
        />
        <LookFields
          filter={choices.filter}
          intensity={choices.intensity}
          filters={status?.filters ?? null}
          disabled={active}
          lockFor={(key) => filterLock(plan, key)}
          onChange={changeLook}
        />
      </div>

      <div className="pix-enhance__actions">
        {status && !status.ready && (
          <span className="pix-enhance__warn" role="status">
            <IconWarning size="sm" />
            {status.models.some((m) => m.state === 'corrupt')
              ? 'Model file damaged — add it to Fovea’s models folder'
              : 'AI model not installed — add it to Fovea’s models folder'}
          </span>
        )}

        {scales.length > 1 ? (
          <SegmentedField
            label="Scale"
            labelInline
            name="fovea-scale"
            value={String(choices.scale)}
            onChange={changeScale}
            disabled={active}
            options={scales.map((s) => {
              const tier = scaleLock(plan, s)
              return {
                value: String(s),
                label: `${s}×`,
                locked: tier !== null,
                badge: tier === null ? undefined : planBadge(tier),
                lockHint: tier === null ? undefined : `${s}× upscaling is ${planName(tier)}`,
              }
            })}
          />
        ) : null}
        {modeOptions.length > 1 && (
          <SegmentedField
            label="Mode"
            labelInline
            name="fovea-mode"
            value={choices.mode}
            onChange={changeMode}
            disabled={active}
            options={modeOptions.map((m) => {
              const tier = modeLock(plan, m)
              return {
                value: m,
                label: MODE_LABEL[m],
                locked: tier !== null,
                badge: tier === null ? undefined : planBadge(tier),
                lockHint:
                  tier === null
                    ? undefined
                    : `${MODE_LABEL[m]} is a restoration mode — part of ${planName(tier)}`,
              }
            })}
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

        {/* The free plan's month, in plain numbers (Stage 20). A metered plan
            says so before you press anything; an unmetered one has nothing to
            report and stays silent. */}
        {quota && (
          <span
            className={cx('pix-enhance__meter', outOfCredits && 'pix-enhance__meter--spent')}
            title={
              outOfCredits
                ? 'The count resets on the 1st of next month'
                : 'Each finished image uses one; the count resets on the 1st'
            }
          >
            {outOfCredits
              ? `All ${quota.limit} free enhancements used in ${periodLabel(quota.period)}`
              : `${quota.remaining} of ${quota.limit} free enhancements left in ${periodLabel(quota.period)}`}
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
                  : outOfCredits
                    ? spentMessage
                    : !recipeRunnable
                      ? 'No installed model offers an option this plan can run — see Settings → Processing'
                      : undefined
          }
          side="bottom"
        >
          <Button
            variant="primary"
            size="md"
            iconStart={active ? <Spinner /> : <IconSparkle size="sm" />}
            disabled={
              !native || !modelReady || active || !selectedId || outOfCredits || !recipeRunnable
            }
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
            {!jobIsMine && (
              <span className="pix-enhance__owner">{jobOwnerName ?? 'another image'}</span>
            )}
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
            {job.phase === 'failed' && jobIsMine && (
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
                {!jobIsMine
                  ? `${jobOwnerName ?? 'That image'} is enhanced — select it to compare and export`
                  : enhanced
                    ? `${formatDimensions(enhanced.width, enhanced.height)} · ${enhanced.label} — in the compare view below`
                    : 'Enhanced — the result is in the compare view'}
              </span>
              {jobIsMine && (
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
              )}
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
