import { describe, expect, it } from 'vitest'
import { isAppErrorPayload, isImageView, isImportOutcome, toAppError } from './ipc'

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

describe('isImportOutcome', () => {
  const image = {
    id: 'C:\\Photos\\a.png',
    name: 'a.png',
    format: 'PNG',
    width: 800,
    height: 600,
    sizeBytes: 12345,
    previewDataUrl: 'data:image/png;base64,AAAA',
  }

  it('accepts a well-formed imported outcome', () => {
    expect(isImportOutcome({ status: 'imported', image })).toBe(true)
  })

  it('accepts a well-formed failed outcome', () => {
    expect(
      isImportOutcome({
        status: 'failed',
        name: 'x.txt',
        error: { code: 'unsupported_format', message: 'nope' },
      }),
    ).toBe(true)
  })

  it('rejects malformed payloads', () => {
    expect(isImportOutcome(null)).toBe(false)
    expect(isImportOutcome('imported')).toBe(false)
    expect(isImportOutcome({ status: 'weird' })).toBe(false)
    expect(isImportOutcome({ status: 'imported' })).toBe(false)
    expect(isImportOutcome({ status: 'imported', image: { ...image, width: '800' } })).toBe(false)
    expect(isImportOutcome({ status: 'failed', name: 'x' })).toBe(false)
  })
})

describe('isImageView (Stage 04)', () => {
  const view = {
    width: 4032,
    height: 3024,
    deliveredEdge: 2600,
    original: false,
    dataUrl: 'data:image/jpeg;base64,AAAA',
  }

  it('accepts a well-formed payload', () => {
    expect(isImageView(view)).toBe(true)
  })

  it('rejects malformed payloads', () => {
    expect(isImageView(null)).toBe(false)
    expect(isImageView('view')).toBe(false)
    expect(isImageView({ ...view, original: 'false' })).toBe(false)
    expect(isImageView({ ...view, dataUrl: undefined })).toBe(false)
  })
})
