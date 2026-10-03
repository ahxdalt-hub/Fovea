import { describe, expect, it } from 'vitest'
import {
  isActivationResult,
  isAppErrorPayload,
  isBatchEvent,
  isBatchSnapshot,
  isDiagnostics,
  isEnhanceEvent,
  isEnhanceResult,
  isExportResult,
  isHistorySnapshot,
  isInferenceStatus,
  isImageView,
  isImportOutcome,
  isLicenseStatus,
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
    expect(isEnhanceEvent({ phase: 'device', device: 'DirectML GPU', tile: 256 })).toBe(true)
    expect(isEnhanceEvent({ phase: 'processing', done: 3, total: 9 })).toBe(true)
    expect(isEnhanceEvent({ phase: 'completing' })).toBe(true)
    expect(isEnhanceEvent({ phase: 'completed' })).toBe(true)
    expect(isEnhanceEvent({ phase: 'cancelled' })).toBe(true)
    expect(isEnhanceEvent({ phase: 'failed', code: 'model_missing', message: 'x' })).toBe(true)
    expect(isEnhanceEvent({ phase: 'preparing' })).toBe(false) // jobId required
    expect(isEnhanceEvent({ phase: 'device', device: 'CPU' })).toBe(false) // tile required
    expect(isEnhanceEvent({ phase: 'processing', done: 1 })).toBe(false)
    expect(isEnhanceEvent({ phase: 'nope' })).toBe(false)
    expect(isEnhanceEvent(null)).toBe(false)
  })

  it('isDiagnostics guards the hardware payload', () => {
    const ok = {
      hardware: {
        cpuName: 'AMD Ryzen 5 5600',
        physicalCores: 6,
        logicalProcessors: 12,
        totalMemoryBytes: 16000000000,
        availableMemoryBytes: 8000000000,
        gpus: [
          {
            name: 'NVIDIA GeForce RTX 3050',
            vendorId: 4318,
            dedicatedVideoBytes: 4000000000,
            sharedSystemBytes: 8000000000,
            software: false,
            directx12: true,
          },
        ],
      },
      engineDevice: 'DirectML GPU',
      maxTileBytes: 536870912,
      maxBandBytes: 536870912,
      memoryLimit: 'GPU video memory',
    }
    expect(isDiagnostics(ok)).toBe(true)
    expect(isDiagnostics({ ...ok, engineDevice: undefined })).toBe(false)
    expect(isDiagnostics({ ...ok, hardware: { ...ok.hardware, gpus: [{ name: 'x' }] } })).toBe(
      false,
    )
    expect(isDiagnostics(null)).toBe(false)
  })

  it('isEnhanceResult guards the committed result payload', () => {
    const ok = {
      imageId: 'C:a.png',
      filePath: 'C:appdataenhancedjob-1-0.png',
      width: 4000,
      height: 3000,
      sourceWidth: 1000,
      sourceHeight: 750,
      outputWidth: 4000,
      outputHeight: 3000,
      label: '4× · Real-ESRGAN general',
      engine: 'DirectML GPU',
      dataUrl: 'data:image/png;base64,AA',
    }
    expect(isEnhanceResult(ok)).toBe(true)
    // The batch path returns a null view — still a valid committed result.
    expect(isEnhanceResult({ ...ok, dataUrl: null })).toBe(true)
    expect(isEnhanceResult({ ...ok, engine: 3 })).toBe(false)
    expect(isEnhanceResult({ ...ok, sourceWidth: undefined })).toBe(false)
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

  it('isBatchSnapshot guards the queue payload', () => {
    const ok = {
      items: [
        {
          id: 'item-1',
          imageId: 'C:a.png',
          name: 'a.png',
          state: 'waiting',
          done: 0,
          total: 0,
          device: null,
          error: null,
          output: null,
          mode: 'standard',
          scale: 2,
          cancelling: false,
        },
      ],
      running: true,
      workerLimit: 1,
    }
    expect(isBatchSnapshot(ok)).toBe(true)
    expect(isBatchSnapshot({ ...ok, items: [{ ...ok.items[0], state: 'teleporting' }] })).toBe(
      false,
    )
    expect(isBatchSnapshot({ ...ok, running: 'yes' })).toBe(false)
    // A completed item carries a real output record.
    const done = {
      items: [
        {
          ...ok.items[0],
          state: 'completed',
          output: {
            filePath: 'C:/out/a.png',
            fileName: 'a.png',
            folder: 'C:/out',
            bytes: 10,
            sourceWidth: 8,
            sourceHeight: 4,
            outputWidth: 16,
            outputHeight: 8,
            label: '2× · Standard',
            engine: 'CPU',
          },
        },
      ],
      running: false,
      workerLimit: 1,
    }
    expect(isBatchSnapshot(done)).toBe(true)
    expect(isBatchSnapshot({ ...done, items: [{ ...done.items[0], output: { bogus: 1 } }] })).toBe(
      false,
    )
    expect(isBatchSnapshot(null)).toBe(false)
  })

  it('isBatchEvent guards the streamed per-item events', () => {
    expect(isBatchEvent({ type: 'started', itemId: 'i' })).toBe(true)
    expect(isBatchEvent({ type: 'progress', itemId: 'i', done: 2, total: 5 })).toBe(true)
    expect(isBatchEvent({ type: 'progress', itemId: 'i', done: 2 })).toBe(false)
    expect(isBatchEvent({ type: 'device', itemId: 'i', device: 'CPU' })).toBe(true)
    expect(isBatchEvent({ type: 'failed', itemId: 'i', code: 'x', message: 'y' })).toBe(true)
    expect(isBatchEvent({ type: 'failed', itemId: 'i' })).toBe(false)
    expect(isBatchEvent({ type: 'started' })).toBe(false)
    expect(isBatchEvent({ type: 'nope', itemId: 'i' })).toBe(false)
    expect(isBatchEvent(null)).toBe(false)
  })

  it('isHistorySnapshot guards the journal payload', () => {
    const ok = {
      entries: [
        {
          id: 'h-1',
          sourcePath: 'C:/pics/a.png',
          fileName: 'a.png',
          originalWidth: 100,
          originalHeight: 80,
          outputWidth: 400,
          outputHeight: 320,
          scale: 4,
          mode: 'standard',
          status: 'completed',
          errorMessage: null,
          createdAt: 1700000000000,
          kind: 'single',
          outputPath: 'C:/enhanced/a.png',
          sourceExists: true,
          outputExists: true,
        },
      ],
      recents: [{ path: 'C:/pics/a.png', name: 'a.png', lastUsedAt: 1, exists: true }],
    }
    expect(isHistorySnapshot(ok)).toBe(true)
    expect(isHistorySnapshot({ ...ok, entries: [] })).toBe(true)
    expect(isHistorySnapshot({ ...ok, entries: [{ ...ok.entries[0], status: 'pending' }] })).toBe(
      false,
    )
    expect(isHistorySnapshot({ ...ok, recents: 'nope' })).toBe(false)
    expect(isHistorySnapshot(null)).toBe(false)
  })
})

describe('Stage 13 license guards', () => {
  const status = {
    state: 'active',
    edition: 'pro',
    holder: 'ada@example.com',
    licenseId: 'PL-1',
    issuedAt: 1,
    expiresAt: null,
    activatedAt: 2,
    machineBound: false,
    capabilities: ['enhance'],
    machineHint: 'abcd1234',
  }

  it('isLicenseStatus accepts the real shape and rejects drift', () => {
    expect(isLicenseStatus(status)).toBe(true)
    expect(isLicenseStatus({ ...status, state: 'magical' })).toBe(false)
    expect(isLicenseStatus({ ...status, machineBound: 'false' })).toBe(false)
    expect(isLicenseStatus({ ...status, holder: 42 })).toBe(false)
    expect(isLicenseStatus({ ...status, capabilities: 'enhance' })).toBe(false)
    expect(isLicenseStatus(null)).toBe(false)
  })

  it('isActivationResult needs both halves', () => {
    expect(isActivationResult({ status, alreadyActive: true })).toBe(true)
    expect(isActivationResult({ status, alreadyActive: 'yes' })).toBe(false)
    expect(isActivationResult({ alreadyActive: true })).toBe(false)
  })
})
