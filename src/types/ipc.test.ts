import { describe, expect, it } from 'vitest'
import { isAppErrorPayload, toAppError } from './ipc'

describe('ipc error normalization', () => {
  it('recognizes the native AppError shape', () => {
    const payload = { code: 'processing_failed', message: 'failed' }
    expect(isAppErrorPayload(payload)).toBe(true)
    expect(isAppErrorPayload('string error')).toBe(false)
    expect(isAppErrorPayload({ code: 'x' })).toBe(false)
    expect(isAppErrorPayload({ code: 1, message: 2 })).toBe(false)
  })

  it('passes through a recognized payload unchanged', () => {
    const payload = { code: 'permission_denied', message: 'denied' } as const
    expect(toAppError(payload)).toEqual(payload)
  })

  it('converts anything else into a safe generic error', () => {
    const fromString = toAppError('raw rust panic text with \\Users\\secret path')
    expect(fromString.code).toBe('unexpected_error')
    expect(fromString.message).not.toContain('secret')
    expect(toAppError(undefined).code).toBe('unexpected_error')
  })
})
