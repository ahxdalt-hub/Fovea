/**
 * License section (Stage 13) — the activation experience under test:
 * honest status rendering, human-readable success/failure copy,
 * idempotent re-activation, and the deactivate round trip. The bridge is
 * mocked at the boundary; the real cryptographic behaviour it mirrors is
 * covered by the Rust suite (services/license).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivationResultDto, LicenseStatusDto } from '../types/ipc'

const getLicenseStatus = vi.fn()
const activateLicense = vi.fn()
const deactivateLicense = vi.fn()
vi.mock('../ipc/bridge', () => ({
  getLicenseStatus: () => getLicenseStatus(),
  activateLicense: (key: string) => activateLicense(key),
  deactivateLicense: () => deactivateLicense(),
}))

import { LicenseSection } from './LicenseSection'

const unactivated: LicenseStatusDto = {
  state: 'not_activated',
  edition: null,
  holder: null,
  licenseId: null,
  issuedAt: null,
  expiresAt: null,
  activatedAt: null,
  machineBound: false,
  capabilities: ['enhance', 'export', 'batch', 'journal'],
  machineHint: 'd442e094',
}

const active: LicenseStatusDto = {
  ...unactivated,
  state: 'active',
  edition: 'pro',
  holder: 'ada@example.com',
  licenseId: 'PL-2026-000001',
  issuedAt: 1759990000,
  activatedAt: 1760000000,
}

const asResult = (status: LicenseStatusDto, alreadyActive = false): ActivationResultDto => ({
  status,
  alreadyActive,
})

describe('License section', () => {
  beforeEach(() => {
    getLicenseStatus.mockReset()
    activateLicense.mockReset()
    deactivateLicense.mockReset()
  })

  it('reads the license on open and lands on the unactivated story', async () => {
    getLicenseStatus.mockResolvedValue(unactivated)
    render(<LicenseSection />)
    expect(await screen.findByText(/running unactivated/i)).toBeInTheDocument()
    expect(screen.getByText(/runs on this machine with or without a key/i)).toBeInTheDocument()
  })

  it('shows the full activation record when a license is active', async () => {
    getLicenseStatus.mockResolvedValue(active)
    render(<LicenseSection />)
    expect(await screen.findByText('Fovea Pro')).toBeInTheDocument()
    expect(screen.getByText('Licensed to')).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByText('PL-2026-000001')).toBeInTheDocument()
    expect(screen.getByText('Perpetual')).toBeInTheDocument()
    expect(screen.getByText('This machine')).toBeInTheDocument()
    expect(screen.getByText('d442e094')).toBeInTheDocument()
  })

  it('the activate button waits for a key, then reports success in plain words', async () => {
    getLicenseStatus.mockResolvedValue(unactivated)
    render(<LicenseSection />)
    const box = await screen.findByLabelText('License key')
    const activate = screen.getByRole('button', { name: 'Activate' })
    expect(activate).toBeDisabled()

    fireEvent.change(box, { target: { value: '  FOVEA1.abc.def  ' } })
    expect(activate).toBeEnabled()

    activateLicense.mockResolvedValue(asResult(active))
    fireEvent.click(activate)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'License activated: Fovea Pro for ada@example.com.',
    )
    expect(activateLicense).toHaveBeenCalledWith('  FOVEA1.abc.def  ')
    // The pasted key is cleared once it worked.
    expect((box as HTMLTextAreaElement).value).toBe('')
    expect(await screen.findByText('Fovea Pro')).toBeInTheDocument()
  })

  it('a repeated key says so honestly instead of pretending it is new', async () => {
    getLicenseStatus.mockResolvedValue(active)
    render(<LicenseSection />)
    await screen.findByText('Fovea Pro')
    const box = screen.getByLabelText('License key')
    fireEvent.change(box, { target: { value: 'FOVEA1.abc.def' } })
    activateLicense.mockResolvedValue(asResult(active, true))
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/already active/i)
  })

  it('a failed activation shows the native human-readable message, and recovers', async () => {
    getLicenseStatus.mockResolvedValue(unactivated)
    render(<LicenseSection />)
    const box = await screen.findByLabelText('License key')
    fireEvent.change(box, { target: { value: 'FOVEA1.nonsense.nonsense' } })
    activateLicense.mockRejectedValue({
      code: 'license_invalid',
      message:
        "That doesn't read as a Fovea license key. Copy it again from your purchase email and try once more.",
    })
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Copy it again from your purchase email and try once more.',
    )
    // The state stays honest: still unactivated, and the box keeps the
    // key so the user can fix the paste.
    expect(screen.getByText(/running unactivated/i)).toBeInTheDocument()
    expect((box as HTMLTextAreaElement).value).toBe('FOVEA1.nonsense.nonsense')

    // Recovery: the good key now activates.
    activateLicense.mockResolvedValue(asResult(active))
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/License activated/i)
  })

  it('expired licenses say who held them and when they lapsed', async () => {
    getLicenseStatus.mockResolvedValue({
      ...active,
      state: 'expired',
      expiresAt: 1760000000,
    })
    render(<LicenseSection />)
    expect(await screen.findByText(/license has expired/i)).toBeInTheDocument()
    expect(screen.getByText(/Renew with the store/i)).toBeInTheDocument()
    expect(screen.getByText('Expires')).toBeInTheDocument()
  })

  it('a damaged local record invites re-pasting the key, not panic', async () => {
    getLicenseStatus.mockResolvedValue({ ...unactivated, state: 'tampered' })
    render(<LicenseSection />)
    expect(await screen.findByText(/record is damaged/i)).toBeInTheDocument()
    expect(screen.getByText(/paste your key again/i)).toBeInTheDocument()
  })

  it('a wound-back clock explains the fix in Windows settings', async () => {
    getLicenseStatus.mockResolvedValue({ ...active, state: 'clock_suspect' })
    render(<LicenseSection />)
    expect(await screen.findByText(/clock is set behind/i)).toBeInTheDocument()
    expect(screen.getByText(/Fix the date and time in Windows settings/i)).toBeInTheDocument()
  })

  it('deactivation runs through the bridge and lands back unactivated', async () => {
    getLicenseStatus.mockResolvedValue(active)
    render(<LicenseSection />)
    await screen.findByText('Fovea Pro')
    deactivateLicense.mockResolvedValue(unactivated)
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    expect(await screen.findByText(/running unactivated/i)).toBeInTheDocument()
    expect(deactivateLicense).toHaveBeenCalled()
  })

  it('an unreadable license degrades to a note, never a stack of errors', async () => {
    getLicenseStatus.mockRejectedValue({ code: 'unexpected_error', message: 'no' })
    render(<LicenseSection />)
    expect(await screen.findByText(/License information is unavailable/i)).toBeInTheDocument()
    expect(screen.getByText(/images and enhancement are unaffected/i)).toBeInTheDocument()
  })

  it('repeats the product promise where licenses live', async () => {
    getLicenseStatus.mockResolvedValue(unactivated)
    render(<LicenseSection />)
    expect(await screen.findByText(/will not wait on a license check/i)).toBeInTheDocument()
  })
})
