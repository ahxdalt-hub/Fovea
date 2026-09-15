import { describe, expect, it } from 'vitest'
import { appReducer, initialState } from './appReducer'
import type { AppConfigDto, AppErrorPayload, SystemInfoDto } from '../types/ipc'

const config: AppConfigDto = {
  productName: 'Test App',
  version: '0.1.0',
  identifier: 'test.example',
  debug: true,
}

const systemInfo: SystemInfoDto = {
  osFamily: 'windows',
  arch: 'x86_64',
  appDataDir: 'C:/Fake/AppData',
}

const failure: AppErrorPayload = { code: 'unexpected_error', message: 'nope' }

describe('appReducer', () => {
  it('starts in connecting state', () => {
    expect(initialState.coreStatus).toBe('connecting')
    expect(initialState.config).toBeNull()
  })

  it('moves to ready with config and system info', () => {
    const next = appReducer(initialState, { type: 'core/ready', config, systemInfo })
    expect(next.coreStatus).toBe('ready')
    expect(next.config).toEqual(config)
    expect(next.systemInfo).toEqual(systemInfo)
    expect(next.error).toBeNull()
  })

  it('records a user-safe error and clears stale data views', () => {
    const ready = appReducer(initialState, { type: 'core/ready', config, systemInfo })
    const failed = appReducer(ready, { type: 'core/error', error: failure })
    expect(failed.coreStatus).toBe('error')
    expect(failed.error).toEqual(failure)
  })

  it('clears the previous error when reconnecting', () => {
    const failed = appReducer(initialState, { type: 'core/error', error: failure })
    const retry = appReducer(failed, { type: 'core/connecting' })
    expect(retry.error).toBeNull()
    expect(retry.coreStatus).toBe('connecting')
  })
})
