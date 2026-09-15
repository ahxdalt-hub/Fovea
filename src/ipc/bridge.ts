/**
 * Typed bridge to native Tauri commands.
 *
 * This module is the ONLY place the frontend imports @tauri-apps/api invoke.
 * Components and state call these functions; if the native API changes,
 * only this file changes. Errors arrive as `AppErrorPayload`
 * (`{ code, message }`) — see `src/types/ipc.ts`.
 */
import { invoke } from '@tauri-apps/api/core'
import type { AppConfigDto, SystemInfoDto } from '../types/ipc'

/** Build configuration owned by the native side. */
export function getConfig(): Promise<AppConfigDto> {
  return invoke<AppConfigDto>('get_config')
}

/** Native runtime snapshot (OS, arch, app data location). */
export function getSystemInfo(): Promise<SystemInfoDto> {
  return invoke<SystemInfoDto>('get_system_info')
}

/** Relay a console message into the native log file. Fire-and-forget. */
export function writeFrontendLog(level: 'debug' | 'info' | 'warn' | 'error', message: string) {
  void invoke('write_frontend_log', { level, message }).catch(() => {
    // Log relay failing must never break the UI or loop.
  })
}
