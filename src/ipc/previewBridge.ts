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
    productName: 'Pixora',
    version: '0.0.0-preview',
    identifier: 'com.pixora.desktop',
    debug: true,
  }
  const systemInfo: SystemInfoDto = {
    osFamily: 'browser',
    arch: 'js',
    appDataDir: '(browser preview — no native storage)',
  }
  switch (cmd) {
    case 'get_config':
      return Promise.resolve(config)
    case 'get_system_info':
      return Promise.resolve(systemInfo)
    default:
      return Promise.resolve(null)
  }
}
