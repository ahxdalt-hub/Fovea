/**
 * Batch view (Stage 08 queue, wired for Stage 09) — enhance a whole set
 * of imported images in one pass.
 *
 * The queue is real and honest: it drains the imported collection
 * one item at a time through the same single-slot engine as a manual
 * Enhance (Stage 07 memory rule), and every item's state comes from the
 * native snapshot + streamed events — never a UI-side estimate. When
 * there is no collection yet, this view says so and routes the user to
 * import, rather than showing an empty table of rows that don't exist.
 *
 * It deliberately stays *not* a management dashboard: a compact preset
 * strip, the queue list with per-item progress, and the terminal actions
 * (cancel, retry, dismiss). Output settings default to Fovea's own
 * batch folder so the primary action never dead-ends on a dialog.
 */
import { useCallback, useMemo, useState } from 'react'
import type {
  BatchConfigPayload,
  BatchItemDto,
  BatchItemStateDto,
  EnhanceModeKey,
  ExportFormatKey,
  FilterKey,
} from '../types/ipc'
import { toAppError } from '../types/ipc'
import { openExportFolder, pickExportFolder } from '../ipc/bridge'
import { FORMATS, FILTER_LABEL, availableFilterKeys } from '../lib/catalog'
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
import { LookFields, PresetChips } from '../components/FinishingLook'
import { useAppState } from '../state/useAppState'
import type { BatchApi } from '../state/useBatch'
import { useNotify } from '../ui/notificationContext'
import { Badge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { cx } from '../ui/cx'
import { SegmentedField } from '../ui/Field'
import { ProgressBar, Spinner } from '../ui/Progress'
import { EmptyState } from '../ui/States'
import { Tooltip } from '../ui/Tooltip'
import { IconClose, IconFolder, IconLayers, IconRetry, IconTune } from '../ui/Icons'
import { isTauriRuntime } from '../state/useNativeFileDrop'
import { formatDimensions } from '../lib/format'
import './Views.css'

export interface BatchViewProps {
  batchApi: BatchApi
  onGoToEnhance: () => void
}

const MODE_LABEL: Record<string, string> = {
  standard: 'Standard',
  natural: 'Natural',
  detail: 'Detail',
}

/** One-line human label for an item's state — calm, never technical. */
function stateLabel(item: BatchItemDto): string {
  if (item.cancelling) return 'Cancelling…'
  switch (item.state as BatchItemStateDto) {
    case 'waiting':
      return 'Waiting'
    case 'processing':
      return 'Processing'
    case 'completed':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
}

function badgeTone(
  state: BatchItemStateDto,
): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' {
  switch (state) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'danger'
    case 'processing':
      return 'accent'
    case 'cancelled':
      return 'warning'
    default:
      return 'neutral'
  }
}

export function BatchView({ batchApi, onGoToEnhance }: BatchViewProps) {
  const { state } = useAppState()
  const { notify } = useNotify()
  const native = isTauriRuntime()
  const images = state.images
  const batch = state.batch

  // A shared preset for the whole run. Defaults track the persisted
  // settings (Stage 10): the processing defaults the Enhance strip uses
  // and the export defaults (format, quality, folder). Only installed
  // scales/modes are offered.
  const status = state.inference
  const plan = useMemo(() => planView(state.license), [state.license])
  const scales = useMemo(() => (status ? status.scales : [2, 4]), [status])
  const availableModes = useMemo(() => {
    if (!status) return new Set(['standard', 'natural', 'detail'])
    return new Set(status.modes.filter((m) => m.available).map((m) => m.key))
  }, [status])
  const [scale, setScale] = useState(state.settings.processing.defaultScale)
  const [mode, setMode] = useState<EnhanceModeKey>(state.settings.processing.defaultMode)
  // Stage 19: the same finishing look the Enhance strip holds, as a
  // per-run choice. It defaults to the persisted processing settings so a
  // batch matches what the user just used on one image.
  const [filter, setFilter] = useState<FilterKey>(state.settings.processing.defaultFilter)
  const [intensity, setIntensity] = useState(state.settings.processing.defaultIntensity)
  const filterOptions = useMemo(() => availableFilterKeys(status?.filters ?? null), [status])

  // The plan's layer on the engine's options (Stage 20) — a batch is one run
  // of many images, so a choice that is merely unselectable in the controls
  // is not enough: the queued recipe itself has to be one this plan can pay
  // for. Anything carried over from the persisted defaults that the plan (or
  // a removed model) cannot run is *derived* to the nearest runnable value —
  // the stored choice is left alone, so a lapsed Pro that stored 4× comes back
  // to 4× the moment the key returns, and the screen always describes the run
  // that would actually happen.
  const ceiling = planScaleCeiling(plan)
  const runnableScales = useMemo(
    () => scales.filter((s) => ceiling === null || s <= ceiling),
    [scales, ceiling],
  )
  const runnableModes = useMemo(
    () => [...availableModes].filter((m) => modeLock(plan, m as EnhanceModeKey) === null),
    [availableModes, plan],
  )
  const effectiveScale = runnableScales.includes(scale)
    ? scale
    : (runnableScales[runnableScales.length - 1] ?? scale)
  const effectiveMode = runnableModes.includes(mode)
    ? mode
    : ((runnableModes[0] as EnhanceModeKey | undefined) ?? mode)
  const filterUsable = filterOptions.includes(filter) && filterLock(plan, filter) === null
  const effectiveFilter = filterUsable ? filter : 'original'
  const choices = useMemo(
    () => ({ scale: effectiveScale, mode: effectiveMode, filter: effectiveFilter, intensity }),
    [effectiveScale, effectiveMode, effectiveFilter, intensity],
  )
  const activePreset = matchingPreset(choices)
  // False only in the corner where the plan and the installed models together
  // leave nothing to run; then Run is disabled rather than queueing a refusal.
  const recipeRunnable =
    runnableScales.includes(effectiveScale) &&
    runnableModes.includes(effectiveMode) &&
    filterLock(plan, effectiveFilter) === null
  // The meter charges one credit per finished image, so a queue larger than
  // what is left this month is refused whole — never started and stopped
  // half-way through.
  const quota = planQuota(plan)
  const creditsShort = quota !== null && images.length > quota.remaining

  // Output settings — default to the configured export choice (folder:
  // "" = Fovea's own batch folder inside Documents, named by the native
  // layer so this screen can show the real place the files land).
  const [folder, setFolder] = useState(state.settings.export.folder)
  const [format, setFormat] = useState<ExportFormatKey>(state.settings.export.format)
  const foveaBatchFolder = state.systemInfo?.defaultBatchExportDir ?? ''
  const shownFolder = folder || foveaBatchFolder

  const chooseFolder = useCallback(async () => {
    try {
      const chosen = await pickExportFolder()
      if (chosen) setFolder(chosen)
    } catch {
      // A canceled/failed picker keeps the default — not a data problem.
    }
  }, [])

  // Reveal the folder the last run wrote to. The path is the one the native
  // layer recorded, never one guessed here — and a refusal is reported.
  const openFolder = useCallback(async () => {
    try {
      const path = await openExportFolder()
      notify('success', `Opened ${path}`)
    } catch (err) {
      notify('warning', toAppError(err).message)
    }
  }, [notify])

  const runBatch = useCallback(() => {
    if (images.length === 0) return
    const items = images.map((img) => ({
      path: img.id,
      name: img.name,
      scale: effectiveScale,
      mode: effectiveMode,
      filter: effectiveFilter,
      intensity,
    }))
    const output: BatchConfigPayload = { folder, format, quality: state.settings.export.quality }
    void batchApi.start(items, output)
  }, [
    images,
    effectiveScale,
    effectiveMode,
    effectiveFilter,
    intensity,
    folder,
    format,
    state.settings.export.quality,
    batchApi,
  ])

  /** A preset writes this run's four processing values — the same mechanism
   * as the Enhance strip, just held per-run instead of persisted. Format is
   * deliberately left alone: this view has its own Format control, and a
   * preset that quietly moved something off-screen would be a hidden change. */
  const applyPreset = (key: PresetKey) => {
    const preset = presetByKey(key)
    if (!preset || presetLock(plan, preset) !== null) return
    setScale(preset.processing.scale)
    setMode(preset.processing.mode)
    setFilter(preset.processing.filter)
    setIntensity(preset.processing.intensity)
  }

  // Empty collection → honest empty state, no fake table.
  if (images.length === 0 && !batch) {
    return (
      <div className="fovea-view anim-fade">
        <ViewHeader />
        <EmptyState
          icon={<IconLayers size="lg" />}
          title="Nothing to batch yet"
          description={
            <>
              Import a few images on the Enhance screen, then come back to run them all through the
              same enhancement in one pass — one at a time, so memory stays bounded.
            </>
          }
          actions={
            <Button variant="secondary" iconStart={<IconTune size="sm" />} onClick={onGoToEnhance}>
              Import images
            </Button>
          }
        />
      </div>
    )
  }

  const items = batch?.items ?? []
  const running = batchApi.running
  const doneCount = items.filter((i) => i.state === 'completed').length
  const failedCount = items.filter((i) => i.state === 'failed' || i.state === 'cancelled').length
  const settled =
    items.length > 0 &&
    !running &&
    items.every((i) => i.state !== 'processing' && i.state !== 'waiting')
  const hasRetryable = items.some((i) => i.state === 'failed' || i.state === 'cancelled')

  return (
    <div className="fovea-view anim-fade">
      <ViewHeader />

      <div className="pix-batch">
        {/* Preset strip: what every item runs with. */}
        <section className="pix-batch__preset" aria-label="Batch preset">
          <div className="pix-batch__preset-grid">
            <PresetChips
              active={activePreset?.key ?? null}
              disabled={running}
              lockFor={(preset) => presetLock(plan, preset)}
              onPick={applyPreset}
            />
            {scales.length > 1 && (
              <SegmentedField
                label="Scale"
                name="fovea-batch-scale"
                value={String(effectiveScale)}
                onChange={(v) => setScale(Number(v))}
                disabled={running}
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
            )}
            {availableModes.size > 1 && (
              <SegmentedField
                label="Mode"
                name="fovea-batch-mode"
                value={effectiveMode}
                onChange={(v) => setMode(v as EnhanceModeKey)}
                disabled={running}
                options={[...availableModes].map((m) => {
                  const tier = modeLock(plan, m as EnhanceModeKey)
                  const label = MODE_LABEL[m] ?? m
                  return {
                    value: m,
                    label,
                    locked: tier !== null,
                    badge: tier === null ? undefined : planBadge(tier),
                    lockHint:
                      tier === null
                        ? undefined
                        : `${label} is a restoration mode — ${planName(tier)}`,
                  }
                })}
              />
            )}
            <LookFields
              filter={effectiveFilter}
              intensity={intensity}
              filters={status?.filters ?? null}
              disabled={running}
              lockFor={(key) => filterLock(plan, key)}
              onChange={(patch) => {
                if (patch.filter !== undefined) setFilter(patch.filter)
                if (patch.intensity !== undefined) setIntensity(patch.intensity)
              }}
            />
            <SegmentedField
              label="Format"
              name="fovea-batch-format"
              value={format}
              onChange={(v) => setFormat(v as ExportFormatKey)}
              disabled={running}
              options={FORMATS.map((f) => ({ value: f.value, label: f.label }))}
              hint={FORMATS.find((f) => f.value === format)?.hint}
            />
          </div>

          <div className="pix-batch__output">
            <span className="pix-batch__output-label">Save to</span>
            <div className="pix-batch__folder">
              <span className="pix-batch__path" title={shownFolder || undefined}>
                {shownFolder || "Fovea's batch folder"}
              </span>
              <Button
                variant="secondary"
                size="sm"
                iconStart={<IconFolder size="sm" />}
                disabled={running}
                onClick={() => void chooseFolder()}
              >
                Change…
              </Button>
              {doneCount > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!native}
                  onClick={() => void openFolder()}
                >
                  Open folder
                </Button>
              ) : null}
            </div>
          </div>

          <div className="pix-batch__run">
            <span className="pix-batch__summary">
              {images.length} image{images.length === 1 ? '' : 's'} · {choices.scale}× ·{' '}
              {MODE_LABEL[choices.mode] ?? choices.mode} ·{' '}
              {status?.filters.find((f) => f.key === effectiveFilter)?.label ??
                FILTER_LABEL[effectiveFilter]}
            </span>
            {/* The meter, in the same words the Enhance strip uses — one
                plan, two surfaces, one sentence. A batch spends one credit per
                finished image, so the queue size is stated next to it. */}
            {quota && (
              <span className={cx('pix-batch__meter', creditsShort && 'pix-batch__meter--short')}>
                {creditsShort
                  ? `Needs ${images.length} of the ${quota.remaining} free enhancements left in ${periodLabel(quota.period)}`
                  : `${quota.remaining} of ${quota.limit} free enhancements left in ${periodLabel(quota.period)}`}
              </span>
            )}
            <Tooltip
              content={
                !native
                  ? 'Batch processing runs in the desktop app'
                  : images.length === 0
                    ? 'Import images first'
                    : running
                      ? 'A batch is already running'
                      : creditsShort
                        ? `A batch of ${images.length} spends ${images.length} enhancements and only ${quota?.remaining ?? 0} are left this month — ${planName('pro')} lifts the count`
                        : !recipeRunnable
                          ? 'No installed model offers an option this plan can run — change the preset above'
                          : undefined
              }
              side="bottom"
            >
              <Button
                variant="primary"
                size="md"
                iconStart={running ? <Spinner /> : <IconLayers size="sm" />}
                disabled={
                  !native || running || images.length === 0 || creditsShort || !recipeRunnable
                }
                onClick={runBatch}
              >
                {running ? 'Batching…' : `Enhance ${images.length} as a batch`}
              </Button>
            </Tooltip>
          </div>
        </section>

        {/* The queue — only when a batch exists. */}
        {batch && (
          <section className="pix-batch__queue" aria-label="Batch queue">
            <header className="pix-batch__queue-head">
              <h2 className="pix-batch__queue-title">Queue</h2>
              <span className="pix-batch__queue-count u-tabular">
                {doneCount}/{items.length} done
                {failedCount > 0 ? ` · ${failedCount} stopped` : ''}
              </span>
              <span className="pix-batch__spacer" aria-hidden="true" />
              {running && (
                <Button variant="ghost" size="sm" onClick={() => void batchApi.cancelAll()}>
                  Cancel all
                </Button>
              )}
              {settled && hasRetryable && (
                <Button
                  variant="secondary"
                  size="sm"
                  iconStart={<IconRetry size="sm" />}
                  onClick={() => void batchApi.retryFailed()}
                >
                  Retry failed
                </Button>
              )}
              {settled && (
                <Button variant="ghost" size="sm" onClick={batchApi.dismiss}>
                  Clear
                </Button>
              )}
            </header>

            <ol className="pix-batch__list">
              {items.map((item) => (
                <BatchRow
                  key={item.id}
                  item={item}
                  running={running}
                  onCancel={batchApi.cancelItem}
                />
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  )
}

function ViewHeader() {
  return (
    <div className="fovea-view__header">
      <div>
        <h1 className="fovea-view__title">Batch</h1>
        <p className="fovea-view__subtitle">
          Enhance a set in one pass — Fovea works through them one at a time so your machine never
          runs out of room.
        </p>
      </div>
    </div>
  )
}

function BatchRow({
  item,
  running,
  onCancel,
}: {
  item: BatchItemDto
  running: boolean
  onCancel: (id: string) => void
}) {
  const active = item.state === 'processing'
  const percent =
    item.total > 0 ? Math.min(100, Math.round((item.done / item.total) * 100)) : undefined
  const canCancel = running && (item.state === 'processing' || item.state === 'waiting')
  return (
    <li className={`pix-batch__row pix-batch__row--${item.state}`}>
      <div className="pix-batch__row-main">
        <div className="pix-batch__row-line">
          <span className="pix-batch__name" title={item.name}>
            {item.name}
          </span>
          <Badge tone={badgeTone(item.state)} dot={active}>
            {stateLabel(item)}
          </Badge>
          {item.device && active && (
            <span className="pix-batch__device">{item.device === 'CPU' ? 'Processor' : 'GPU'}</span>
          )}
          <span className="pix-batch__spacer" aria-hidden="true" />
          {canCancel && (
            <IconButton label={`Cancel ${item.name}`} onClick={() => void onCancel(item.id)}>
              <IconClose size="sm" />
            </IconButton>
          )}
        </div>
        {active && <ProgressBar value={percent} label={`${item.name} progress`} />}
        {item.state === 'completed' && item.output && (
          <span className="pix-batch__result">
            {formatDimensions(item.output.sourceWidth, item.output.sourceHeight)} →{' '}
            {formatDimensions(item.output.outputWidth, item.output.outputHeight)} · saved to{' '}
            {item.output.folder}
          </span>
        )}
        {item.state === 'failed' && item.error && (
          <span className="pix-batch__error">{item.error.message}</span>
        )}
        {item.state === 'cancelled' && (
          <span className="pix-batch__muted">Cancelled — nothing new was written.</span>
        )}
      </div>
    </li>
  )
}
