/**
 * Enhance view — the core workflow (Import → View → Enhance → Compare → Export).
 *
 * Stage 04 makes the workspace real. Two shapes:
 * - Collection empty → the honest drop zone: native drag & drop is the
 *   hero interaction, the file picker is the keyboard path.
 * - Collection populated → a compact thumbnail rail plus the full image
 *   workspace (zoom / pan / fit / compare / fullscreen).
 *
 * Enhanced results come from app state — empty until Stage 05's engine;
 * the compare slider shows an honest pending panel meanwhile, and this
 * view never fakes output.
 * Native file drag & drop is owned by the Tauri core (see
 * useNativeFileDrop), so no HTML5 drag handlers appear here.
 */
import { useCallback, useEffect } from 'react'
import type { ImageEnhancementDto, ImportedImageDto } from '../types/ipc'
import { getInferenceStatus } from '../ipc/bridge'
import { useAppState } from '../state/useAppState'
import { Button, IconButton } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'
import { EmptyState } from '../ui/States'
import { Badge } from '../ui/Badge'
import { Spinner } from '../ui/Progress'
import { IconClose, IconImage, IconImport } from '../ui/Icons'
import { collectionSummary, type ImportApi } from '../state/useImport'
import type { EnhanceApi } from '../state/useEnhance'
import { isTauriRuntime } from '../state/useNativeFileDrop'
import { ImageWorkspace } from '../components/ImageWorkspace'
import { EnhanceControls } from '../components/EnhanceControls'
import './Views.css'

const WORKFLOW = [
  { id: 'import', n: '1', title: 'Import', detail: 'Drop a photo or pick a file' },
  { id: 'enhance', n: '2', title: 'Enhance', detail: 'Upscale 2×/4× and refine detail' },
  { id: 'compare', n: '3', title: 'Compare', detail: 'Slide between original and result' },
  { id: 'export', n: '4', title: 'Export', detail: 'Save anywhere on this machine' },
]

export interface EnhanceViewProps {
  importApi: ImportApi
  enhanceApi: EnhanceApi
  images: ImportedImageDto[]
}

export function EnhanceView({ importApi, enhanceApi, images }: EnhanceViewProps) {
  const { importing } = importApi
  const { state, dispatch } = useAppState()

  // Engine readiness: one fetch per Enhance session (native runtime only).
  // The result gates the Enhance button honestly — a missing/corrupt model
  // says so rather than presenting a button that fails at click time.
  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    getInferenceStatus()
      .then((status) => {
        if (!cancelled) dispatch({ type: 'inference/set', status })
      })
      .catch(() => {
        // Readiness is an enhancement to the UI, not a core dependency;
        // the button's tooltip/disabled logic covers a missing fetch.
      })
    return () => {
      cancelled = true
    }
  }, [dispatch])

  // Selection is derived: a stored id that no longer exists (removed or
  // cleared) simply falls back to the first image — no sync effect needed.
  // The id lives in app state so selection survives navigation.
  const selected = images.find((img) => img.id === state.selectedImageId) ?? images[0] ?? null

  const selectImage = useCallback(
    (id: string) => dispatch({ type: 'images/select', id }),
    [dispatch],
  )

  const enhanced: ImageEnhancementDto | null = selected
    ? (state.enhancements[selected.id] ?? null)
    : null

  const openImport = useCallback(() => void importApi.browse(), [importApi])

  return (
    <div className="pixora-view pixora-view--enhance anim-fade">
      <h1 className="u-visually-hidden">Enhance</h1>

      {images.length === 0 ? (
        <>
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

          <WorkspaceEmpty importApi={importApi} importing={importing} />

          <div className="pixora-view__footnote">
            <Badge tone="success" dot>
              Local processing
            </Badge>
            <span>JPG, PNG and WebP · validation and previews run on this machine</span>
          </div>
        </>
      ) : (
        <div className="pixora-collection anim-rise">
          <div className="pixora-collection__bar">
            <h2 className="pixora-collection__heading">
              Imported
              <span className="pixora-collection__count u-tabular">
                {collectionSummary(images)}
              </span>
            </h2>
            <div className="pixora-collection__actions">
              {importing && (
                <span className="pixora-collection__busy" role="status">
                  <Spinner /> Checking files…
                </span>
              )}
              <Tooltip
                content={isTauriRuntime() ? undefined : 'Import runs in the desktop app'}
                side="bottom"
              >
                <Button
                  variant="secondary"
                  size="sm"
                  iconStart={<IconImport size="sm" />}
                  disabled={importing || !isTauriRuntime()}
                  onClick={openImport}
                >
                  Add more
                </Button>
              </Tooltip>
              <Button variant="ghost" size="sm" onClick={importApi.clearImages}>
                Clear all
              </Button>
            </div>
          </div>

          <EnhanceControls enhanceApi={enhanceApi} selectedId={selected?.id ?? null} />

          <div className="pixora-collection__body">
            <ol className="pixora-thumbs" aria-label="Imported images">
              {images.map((img) => (
                <li key={img.id}>
                  <button
                    type="button"
                    className={`pixora-thumb${img.id === selected?.id ? ' pixora-thumb--active' : ''}`}
                    aria-current={img.id === selected?.id || undefined}
                    onClick={() => selectImage(img.id)}
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

            {selected && (
              <ImageWorkspace
                key={selected.id}
                image={selected}
                enhanced={enhanced}
                onAddMore={openImport}
                onClear={importApi.clearImages}
              />
            )}
          </div>
        </div>
      )}
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
