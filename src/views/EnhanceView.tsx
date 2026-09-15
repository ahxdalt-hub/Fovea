/**
 * Enhance view — the core workflow (Import → Enhance → Compare → Export).
 *
 * Stage 03 makes Import real. Two shapes:
 * - Collection empty → the honest drop zone: native drag & drop is the
 *   hero interaction, the file picker is the keyboard path.
 * - Collection populated → a thumbnail rail plus an inspector for the
 *   selected image (local preview + verified metadata).
 *
 * Enhance/Compare/Export stay planned; this view never fakes them.
 * Native file drag & drop is owned by the Tauri core (see
 * useNativeFileDrop), so no HTML5 drag handlers appear here.
 */
import { useState } from 'react'
import type { ImportedImageDto } from '../types/ipc'
import { Button, IconButton } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'
import { EmptyState } from '../ui/States'
import { Badge } from '../ui/Badge'
import { Card } from '../ui/Card'
import { Spinner } from '../ui/Progress'
import { IconClose, IconImage, IconImport } from '../ui/Icons'
import { collectionSummary, type ImportApi } from '../state/useImport'
import { isTauriRuntime } from '../state/useNativeFileDrop'
import { formatBytes, formatDimensions } from '../lib/format'
import './Views.css'

const WORKFLOW = [
  { id: 'import', n: '1', title: 'Import', detail: 'Drop a photo or pick a file' },
  { id: 'enhance', n: '2', title: 'Enhance', detail: 'Upscale 2×/4× and refine detail' },
  { id: 'compare', n: '3', title: 'Compare', detail: 'Slide between original and result' },
  { id: 'export', n: '4', title: 'Export', detail: 'Save anywhere on this machine' },
]

export interface EnhanceViewProps {
  importApi: ImportApi
  images: ImportedImageDto[]
}

export function EnhanceView({ importApi, images }: EnhanceViewProps) {
  const { importing } = importApi
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

      {images.length === 0 ? (
        <WorkspaceEmpty importApi={importApi} importing={importing} />
      ) : (
        <WorkspaceCollection importApi={importApi} images={images} importing={importing} />
      )}

      <div className="pixora-view__footnote">
        <Badge tone="success" dot>
          Local processing
        </Badge>
        <span>JPG, PNG and WebP · validation and previews run on this machine</span>
      </div>
    </div>
  )
}

function WorkspaceEmpty({ importApi, importing }: { importApi: ImportApi; importing: boolean }) {
  const native = isTauriRuntime()
  const disabled = !native || importing
  const reason = !native
    ? 'Image import runs in the desktop app'
    : importing
      ? 'Checking the files you selected…'
      : undefined
  return (
    <EmptyState
      icon={<IconImage size="lg" />}
      title="Drop an image anywhere to begin"
      description={
        <>
          Drag JPG, PNG, or WebP files onto Pixora, or choose files from disk. Every file is checked
          on this machine and the full image stays where it is — nothing is uploaded, at any point.
        </>
      }
      actions={
        <Tooltip content={reason} side="bottom">
          <Button
            variant="primary"
            size="lg"
            iconStart={importing ? <Spinner /> : <IconImport />}
            disabled={disabled}
            onClick={() => void importApi.browse()}
          >
            {importing ? 'Importing…' : 'Choose files…'}
          </Button>
        </Tooltip>
      }
    />
  )
}

interface CollectionProps {
  importApi: ImportApi
  images: ImportedImageDto[]
  importing: boolean
}

function WorkspaceCollection({ importApi, images, importing }: CollectionProps) {
  // Selection is derived: a stored id that no longer exists (removed or
  // cleared) simply falls back to the first image — no sync effect needed.
  const [selectedId, setSelectedId] = useState<string>('')
  const selected = images.find((img) => img.id === selectedId) ?? images[0]
  if (!selected) return null

  return (
    <div className="pixora-collection anim-rise">
      <div className="pixora-collection__bar">
        <h2 className="pixora-collection__heading">
          Imported
          <span className="pixora-collection__count u-tabular">{collectionSummary(images)}</span>
        </h2>
        <div className="pixora-collection__actions">
          {importing && (
            <span className="pixora-collection__busy" role="status">
              <Spinner /> Checking files…
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            iconStart={<IconImport size="sm" />}
            disabled={importing || !isTauriRuntime()}
            onClick={() => void importApi.browse()}
          >
            Add more
          </Button>
          <Button variant="ghost" size="sm" onClick={importApi.clearImages}>
            Clear all
          </Button>
        </div>
      </div>

      <div className="pixora-collection__body">
        <ol className="pixora-thumbs" aria-label="Imported images">
          {images.map((img) => (
            <li key={img.id}>
              <button
                type="button"
                className={`pixora-thumb${img.id === selected.id ? ' pixora-thumb--active' : ''}`}
                aria-current={img.id === selected.id || undefined}
                onClick={() => setSelectedId(img.id)}
                title={img.name}
              >
                <img className="pixora-thumb__img" src={img.previewDataUrl} alt="" />
                <span className="pixora-thumb__name">{img.name}</span>
              </button>
              <IconButton
                label={`Remove ${img.name} from the collection`}
                className="pixora-thumb__remove"
                onClick={() => importApi.removeImage(img.id)}
              >
                <IconClose size="sm" />
              </IconButton>
            </li>
          ))}
        </ol>

        <div className="pixora-inspector">
          <Card className="pixora-inspector__canvas">
            <img
              className="pixora-inspector__image"
              src={selected.previewDataUrl}
              alt={`${selected.name} — local preview`}
            />
          </Card>

          <Card className="pixora-inspector__meta">
            <h3 className="pixora-inspector__file">{selected.name}</h3>
            <dl className="pixora-meta">
              <div className="pixora-meta__row">
                <dt>Format</dt>
                <dd>{selected.format}</dd>
              </div>
              <div className="pixora-meta__row">
                <dt>Dimensions</dt>
                <dd className="u-tabular">{formatDimensions(selected.width, selected.height)}</dd>
              </div>
              <div className="pixora-meta__row">
                <dt>File size</dt>
                <dd className="u-tabular">{formatBytes(selected.sizeBytes)}</dd>
              </div>
              <div className="pixora-meta__row">
                <dt>Status</dt>
                <dd>
                  <Badge tone="success" dot>
                    Ready
                  </Badge>
                </dd>
              </div>
            </dl>
            <p className="pixora-inspector__note">
              Verified locally. The enhancement engine arrives in the next stage — the image stays
              in your collection for this session.
            </p>
          </Card>
        </div>
      </div>
    </div>
  )
}
