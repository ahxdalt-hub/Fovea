/**
 * Batch view — planned home of queue processing.
 *
 * Intentionally an empty state with a short description of what the section
 * will do. No fake queue table, no disabled buttons everywhere: one honest
 * sentence and a route back to the starting point of the workflow.
 */
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/States'
import { IconLayers, IconTune } from '../ui/Icons'
import './Views.css'

export interface BatchViewProps {
  onGoToEnhance: () => void
}

export function BatchView({ onGoToEnhance }: BatchViewProps) {
  return (
    <div className="pixora-view anim-fade">
      <div className="pixora-view__header">
        <div>
          <h1 className="pixora-view__title">Batch</h1>
          <p className="pixora-view__subtitle">Enhance a whole folder in one pass.</p>
        </div>
      </div>

      <EmptyState
        icon={<IconLayers size="lg" />}
        title="Batch processing is coming next"
        description={
          <>
            Soon you will queue multiple images, choose a shared enhancement preset, and let Pixora
            work through them while you keep browsing. Start with a single image to see the workflow
            you will batch over.
          </>
        }
        actions={
          <Button variant="secondary" iconStart={<IconTune size="sm" />} onClick={onGoToEnhance}>
            Go to Enhance
          </Button>
        }
      />
    </div>
  )
}
