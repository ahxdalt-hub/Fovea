import { describe, expect, it } from 'vitest'
import {
  isAppErrorPayload,
  isEnhanceEvent,
  isEnhanceResult,
  isExportResult,
  isInferenceStatus,
  isImageView,
  isImportOutcome,
  toAppError,
} from './ipc'

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

describe('Stage 05 guards', () => {
  it('isEnhanceEvent accepts the native stream shapes', () => {
    expect(isEnhanceEvent({ phase: 'preparing', jobId: 'job-1-0' })).toBe(true)
    expect(isEnhanceEvent({ phase: 'processing', done: 3, total: 9 })).toBe(true)
    expect(isEnhanceEvent({ phase: 'completing' })).toBe(true)
    expect(isEnhanceEvent({ phase: 'completed' })).toBe(true)
    expect(isEnhanceEvent({ phase: 'cancelled' })).toBe(true)
    expect(isEnhanceEvent({ phase: 'failed', code: 'model_missing', message: 'x' })).toBe(true)
    expect(isEnhanceEvent({ phase: 'preparing' })).toBe(false) // jobId required
    expect(isEnhanceEvent({ phase: 'processing', done: 1 })).toBe(false)
    expect(isEnhanceEvent({ phase: 'nope' })).toBe(false)
    expect(isEnhanceEvent(null)).toBe(false)
  })

  it('isEnhanceResult guards the committed result payload', () => {
    const ok = {
      imageId: 'C:a.png',
      filePath: 'C:appdataenhancedjob-1-0.png',
      width: 4000,
      height: 3000,
      label: '4× · Real-ESRGAN general',
      engine: 'DirectML GPU',
      dataUrl: 'data:image/png;base64,AA',
    }
    expect(isEnhanceResult(ok)).toBe(true)
    expect(isEnhanceResult({ ...ok, engine: 3 })).toBe(false)
    expect(isEnhanceResult('result')).toBe(false)
  })

  it('isInferenceStatus guards the readiness payload', () => {
    const ok = {
      device: 'DirectML GPU',
      models: [{ id: 'm', label: 'l', scale: 4, state: 'ready', mode: 'standard' }],
      ready: true,
      scales: [2, 4],
      modes: [{ key: 'standard', label: 'Standard', description: 'd', available: true }],
      modelsDirDisplay: 'C:/models',
    }
    expect(isInferenceStatus(ok)).toBe(true)
    expect(isInferenceStatus({ ...ok, models: 'not-an-array' })).toBe(false)
    expect(isInferenceStatus({ ...ok, ready: 'yes' })).toBe(false)
    expect(isInferenceStatus({ ...ok, scales: 'two' })).toBe(false)
    expect(isInferenceStatus({ ...ok, modes: [{ key: 'x' }] })).toBe(false)
    expect(isInferenceStatus(null)).toBe(false)
  })

  it('isExportResult guards the export payload', () => {
    const ok = {
      filePath: 'C:/Users/me/Pictures/sunset.jpg',
      fileName: 'sunset.jpg',
      folder: 'C:/Users/me/Pictures',
      format: 'jpeg',
      bytes: 1234,
    }
    expect(isExportResult(ok)).toBe(true)
    expect(isExportResult({ ...ok, bytes: '1234' })).toBe(false)
    expect(isExportResult(null)).toBe(false)
  })
})
