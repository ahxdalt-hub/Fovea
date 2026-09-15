/**
 * Enhance view — the core workflow (Import → Enhance → Compare → Export).
 *
 * Stage 02 ships the honest empty workspace: importing is not wired yet,
 * so the primary action is disabled with an explanatory tooltip rather than
 * faking behavior. The workflow strip teaches the eventual loop; the privacy
 * card states what the engine will guarantee. When Stage 03 wires the file
 * picker, `onImport` becomes real and the empty state swaps for the canvas.
 */
import { Button } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'
import { EmptyState } from '../ui/States'
import { Badge } from '../ui/Badge'
import { IconImage, IconImport } from '../ui/Icons'
import './Views.css'

const WORKFLOW = [
  { id: 'import', n: '1', title: 'Import', detail: 'Drop a photo or pick a file' },
  { id: 'enhance', n: '2', title: 'Enhance', detail: 'Upscale 2×/4× and refine detail' },
  { id: 'compare', n: '3', title: 'Compare', detail: 'Slide between original and result' },
  { id: 'export', n: '4', title: 'Export', detail: 'Save anywhere on this machine' },
]

export interface EnhanceViewProps {
  /** Provided once Stage 03 wires native file picking. */
  onImport?: () => void
}

export function EnhanceView({ onImport }: EnhanceViewProps) {
  const importDisabled = !onImport
  return (
    <div className="pixora-view pixora-view--enhance anim-fade">
      <h1 className="u-visually-hidden">Enhance</h1>
      <div className="pixora-workflow" aria-label="Workflow">
        {WORKFLOW.map((step, index) => (
          <div className="pixora-workflow__step" key={step.id}>
            {index > 0 && <span className="pixora-workflow__chevron" aria-hidden="true" />}
            <span className="pixora-workflow__n u-tabular">{step.n}</span>
            <span className="pixora-workflow__text">
              <span className="pixora-workflow__title">{step.title}</span>
              <span className="pixora-workflow__detail">{step.detail}</span>
            </span>
          </div>
        ))}
      </div>

      <EmptyState
        icon={<IconImage size="lg" />}
        title="Your images, enhanced on your machine"
        description={
          <>
            Open an image to begin. Pixora upscales and refines it locally with AI — nothing is
            uploaded, nothing is shared, at any point.
          </>
        }
        actions={
          <Tooltip
            content={importDisabled ? 'Image import arrives in the next stage' : undefined}
            side="bottom"
          >
            <Button
              variant="primary"
              size="lg"
              iconStart={<IconImport />}
              disabled={importDisabled}
              onClick={onImport}
            >
              Import image
            </Button>
          </Tooltip>
        }
      />

      <div className="pixora-view__footnote">
        <Badge tone="success" dot>
          Local processing
        </Badge>
        <span>PNG and JPEG support first · GPU acceleration with automatic CPU fallback</span>
      </div>
    </div>
  )
}
