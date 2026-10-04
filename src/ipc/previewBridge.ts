/**
 * Dev-only browser preview of the native core.
 *
 * `npm run dev` in a plain browser has no Tauri runtime. To keep the shell
 * reviewable visually (design QA, screenshots, later UI stages) without a
 * native window, we serve canned responses for the three app-level commands
 * — only when DEV, not under tests, and only when `__TAURI_INTERNALS__` is
 * absent. The real handshake still runs inside Tauri; release builds strip
 * this entirely (Vite replaces import.meta.env.DEV with false).
 *
 * The values are honest about being a preview: they are never presented as
 * processing capabilities, and no fake image results exist here.
 */
import type { AppConfigDto, SystemInfoDto } from '../types/ipc'

/** True when running in a browser without the Tauri runtime. */
export function shouldUsePreviewBridge(): boolean {
  return (
    import.meta.env.DEV && import.meta.env.MODE !== 'test' && !('__TAURI_INTERNALS__' in window)
  )
}

export function previewInvoke(cmd: string): Promise<unknown> {
  const config: AppConfigDto = {
    productName: 'Fovea',
    version: '0.0.0-preview',
    identifier: 'com.fovea.desktop',
    debug: true,
  }
  const systemInfo: SystemInfoDto = {
    osFamily: 'browser',
    arch: 'js',
    appDataDir: '(browser preview — no native storage)',
    logsDir: '(browser preview — no native logs)',
    defaultExportDir: '',
    defaultBatchExportDir: '',
  }
  switch (cmd) {
    case 'get_config':
      return Promise.resolve(config)
    case 'get_system_info':
      return Promise.resolve(systemInfo)
    // Import has no meaning in the browser preview: the picker behaves
    // like a cancel (empty list) and imports return no outcomes. The real
    // validation pipeline exists only in the native build.
    case 'pick_image_files':
      return Promise.resolve([])
    case 'import_images':
      return Promise.resolve([])
    // Stage 13: there is no local license store in a browser. The
    // honest answer is "not activated" — which since Stage 20 genuinely
    // means the free plan, so the preview shows the locked controls the
    // free plan ships with (4×, Natural, Detail, Portrait, the hardware
    // switches) and an untouched month meter. Activation itself refuses
    // (see bridge.ts).
    case 'get_license_status': {
      const now = new Date()
      return Promise.resolve({
        state: 'not_activated',
        edition: null,
        holder: null,
        licenseId: null,
        issuedAt: null,
        expiresAt: null,
        activatedAt: null,
        machineBound: false,
        capabilities: ['enhance', 'export', 'batch', 'journal'],
        machineHint: 'preview',
        quota: {
          period: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
          limit: 10,
          used: 0,
          remaining: 10,
        },
      })
    }
    default:
      return Promise.resolve(null)
  }
}
