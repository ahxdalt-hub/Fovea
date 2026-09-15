/**
 * History view — planned home of the local processing journal.
 *
 * Same principle as Batch: honest placeholder, no invented rows. When
 * Stage 04+ writes history, this view lists real entries from the store.
 */
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/States'
import { IconHistory, IconTune } from '../ui/Icons'
import './Views.css'

export interface HistoryViewProps {
  onGoToEnhance: () => void
}

export function HistoryView({ onGoToEnhance }: HistoryViewProps) {
  return (
    <div className="pixora-view anim-fade">
      <div className="pixora-view__header">
        <div>
          <h1 className="pixora-view__title">History</h1>
          <p className="pixora-view__subtitle">
            Everything you have enhanced, kept on this machine.
          </p>
        </div>
      </div>

      <EmptyState
        icon={<IconHistory size="lg" />}
        title="No enhancements yet"
        description={
          <>
            Once you start enhancing images, this section becomes your private journal — reopen a
            past result, re-export it, or re-run it with new settings.
          </>
        }
        actions={
          <Button variant="secondary" iconStart={<IconTune size="sm" />} onClick={onGoToEnhance}>
            Open Enhance
          </Button>
        }
      />
    </div>
  )
}
