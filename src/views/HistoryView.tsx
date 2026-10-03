/**
 * History view (Stage 09) — the local processing journal.
 *
 * A read of the native store, never a second copy of it: entries carry
 * the file name, true original → output dimensions, scale, mode, outcome,
 * timestamp, and — for completed work — where the result was written.
 * No image bytes are stored; the journal points at files, and existence
 * flags (computed at read time by Rust) say whether those points still
 * lead somewhere.
 *
 * The view reads the shared `history` slice (loaded through `useHistory`,
 * which syncs via dispatch) so it and the cold-start recent row never
 * diverge. The UX is deliberately small: it helps you *return to work*
 * (reopen a past source in the workspace) without becoming a management
 * dashboard. A moved or deleted file is shown honestly and its open
 * action disabled — the row stays as history — rather than being silently
 * dropped or offering a click that would fail. Clearing the journal is
 * confirmed, because wiping history is destructive and Pixora never does
 * it silently.
 */
import { useEffect, useState } from 'react'
import type { HistoryEntryDto } from '../types/ipc'
import { useHistory } from '../state/useHistory'
import { useAppState } from '../state/useAppState'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { EmptyState, ErrorState, LoadingState } from '../ui/States'
import { IconHistory, IconImport, IconTune } from '../ui/Icons'
import { formatDimensions } from '../lib/format'
import { isTauriRuntime } from '../state/useNativeFileDrop'
import './Views.css'

export interface HistoryViewProps {
  onGoToEnhance: () => void
  /** Reopen a still-present source in the workspace (import + navigate). */
  onReopen: (sourcePath: string) => void
}

/** "4× · Standard" preset label for a journal row. */
function presetLabel(entry: HistoryEntryDto): string {
  const mode = entry.mode.charAt(0).toUpperCase() + entry.mode.slice(1)
  return `${entry.scale}× · ${mode}`
}

/** A date + time is a fact, not a computation — no fake "just now" decay. */
function whenLabel(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

function dimensionsLabel(entry: HistoryEntryDto): string {
  if (entry.status === 'failed') return 'no output'
  if (entry.originalWidth === 0 || entry.outputWidth === 0) {
    return entry.outputWidth > 0
      ? `→ ${formatDimensions(entry.outputWidth, entry.outputHeight)}`
      : '—'
  }
  return `${formatDimensions(entry.originalWidth, entry.originalHeight)} → ${formatDimensions(entry.outputWidth, entry.outputHeight)}`
}

export function HistoryView({ onGoToEnhance, onReopen }: HistoryViewProps) {
  const { state } = useAppState()
  const { status, error, load, clear } = useHistory()
  const [confirmClear, setConfirmClear] = useState(false)

  // Fresh read on entry: the journal is native-sourced and must never
  // show a stale cache after work happened elsewhere. Synced by dispatch
  // (no setState-in-effect), so the shared slice updates for every reader.
  useEffect(() => {
    void load()
  }, [load])

  const entries = state.history?.entries ?? []

  return (
    <div className="pixora-view anim-fade">
      <div className="pixora-view__header">
        <div>
          <h1 className="pixora-view__title">History</h1>
          <p className="pixora-view__subtitle">
            Everything you have enhanced, kept on this machine.
          </p>
        </div>
        {entries.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
            Clear history
          </Button>
        )}
      </div>

      <div className="pix-history__body">
        {status === 'loading' && <LoadingState label="Reading your journal…" />}
        {status === 'error' && (
          <ErrorState
            title="History is unavailable"
            description={error ?? 'The local journal could not be read.'}
            onRetry={() => void load()}
          />
        )}
        {status === 'ready' && entries.length === 0 && (
          <EmptyState
            icon={<IconHistory size="lg" />}
            title="No enhancements yet"
            description={
              <>
                Once you start enhancing images, this becomes your private journal — reopen a past
                source, see where its result was saved, or re-run it with new settings. Everything
                here is local: Pixora stores paths and measurements, never copies of your images.
              </>
            }
            actions={
              <Button
                variant="secondary"
                iconStart={<IconTune size="sm" />}
                onClick={onGoToEnhance}
              >
                Open Enhance
              </Button>
            }
          />
        )}
        {status === 'ready' && entries.length > 0 && (
          <ul className="pix-history__list">
            {entries.map((entry) => (
              <HistoryRow key={entry.id} entry={entry} onReopen={onReopen} />
            ))}
          </ul>
        )}
      </div>

      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear history?"
        size="sm"
        description="This removes the journal and recent list. Your enhanced files stay exactly where they are — Pixora only deletes records, never your work."
        footer={
          <>
            <span className="pix-history__confirm-spacer" aria-hidden="true" />
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
              Keep history
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setConfirmClear(false) // done means done — the dialog closes
                void clear()
              }}
            >
              Clear history
            </Button>
          </>
        }
      >
        <p className="pix-history__confirm-body">
          {entries.length} record{entries.length === 1 ? '' : 's'} will be forgotten on this device.
        </p>
      </Dialog>
    </div>
  )
}

function HistoryRow({
  entry,
  onReopen,
}: {
  entry: HistoryEntryDto
  onReopen: (p: string) => void
}) {
  const failed = entry.status === 'failed'
  const sourceGone = !entry.sourceExists
  const canReopen = isTauriRuntime() && !sourceGone
  const tone = failed ? 'danger' : sourceGone ? 'warning' : 'success'
  return (
    <li className={`pix-history__row${sourceGone ? ' pix-history__row--stale' : ''}`}>
      <div className="pix-history__row-main">
        <div className="pix-history__row-line">
          <span className="pix-history__name" title={entry.sourcePath}>
            {entry.fileName}
          </span>
          {entry.kind === 'batch' && (
            <Badge tone="neutral" title="Enhanced as part of a batch">
              Batch
            </Badge>
          )}
          <Badge tone={tone} dot>
            {failed ? 'Failed' : sourceGone ? 'Missing' : 'Done'}
          </Badge>
        </div>
        <div className="pix-history__meta">
          <span className="u-tabular">{presetLabel(entry)}</span>
          <span aria-hidden="true"> · </span>
          <span className="u-tabular">{dimensionsLabel(entry)}</span>
          <span aria-hidden="true"> · </span>
          <span>{whenLabel(entry.createdAt)}</span>
        </div>
        {failed && entry.errorMessage && (
          <span className="pix-history__error">{entry.errorMessage}</span>
        )}
        {!failed && entry.outputPath && (
          <span className="pix-history__output" title={entry.outputPath}>
            Saved: {entry.outputPath}
            {!entry.outputExists && ' (no longer there)'}
          </span>
        )}
      </div>
      <div className="pix-history__actions">
        {canReopen ? (
          <Button
            variant="secondary"
            size="sm"
            iconStart={<IconImport size="sm" />}
            onClick={() => onReopen(entry.sourcePath)}
          >
            Open
          </Button>
        ) : (
          <span className="pix-history__muted" title="The file is no longer where it was">
            {sourceGone ? 'File moved or deleted' : 'Open in the desktop app'}
          </span>
        )}
      </div>
    </li>
  )
}
