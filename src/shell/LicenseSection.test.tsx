/**
 * License section (Stage 13, gated by Stage 20) — the activation experience
 * under test: honest status rendering, the plan a record puts in force, the
 * month's meter, human-readable success/failure copy, idempotent
 * re-activation, and the deactivate round trip. The bridge is mocked at the
 * boundary; the real cryptographic behaviour it mirrors is covered by the
 * Rust suite (services/license).
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ActivationResultDto,
  AppConfigDto,
  LicenseStatusDto,
  SystemInfoDto,
} from '../types/ipc'

const activateLicense = vi.fn()
const deactivateLicense = vi.fn()
vi.mock('../ipc/bridge', () => ({
  getLicenseStatus: () => Promise.reject(new Error('the section does not read it')),
  activateLicense: (key: string) => activateLicense(key),
  deactivateLicense: () => deactivateLicense(),
}))

import { LicenseSection } from './LicenseSection'
import { AppStateProvider } from '../state/AppState'
import { useAppState } from '../state/useAppState'

/** The free plan's record: the four ungated capabilities and a full month. */
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
  quota: { period: '2026-10', limit: 10, used: 3, remaining: 7, counted: true },
}

const active: LicenseStatusDto = {
  ...unactivated,
  state: 'active',
  edition: 'pro',
  holder: 'ada@example.com',
  licenseId: 'PL-2026-000001',
  issuedAt: 1759990000,
  activatedAt: 1760000000,
  capabilities: [
    'enhance',
    'export',
    'batch',
    'journal',
    'upscale_4x',
    'advanced_restoration',
    'face_enhancement',
    'unlimited_processing',
  ],
  // An unlimited plan has no meter, so native reports none.
  quota: null,
}

const asResult = (status: LicenseStatusDto, alreadyActive = false): ActivationResultDto => ({
  status,
  alreadyActive,
})

/** What the installer reports about itself (Stage 20 packaging): the free
 * build, and the two branded ones. `productName` follows the build, exactly
 * as `config.rs` derives both from one marker. */
const systemInfo: SystemInfoDto = {
  osFamily: 'windows',
  arch: 'x86_64',
  appDataDir: 'C:/Users/test/AppData',
  logsDir: 'C:/Users/test/AppData/logs',
  defaultExportDir: 'C:/Users/test/Documents/Fovea',
  defaultBatchExportDir: 'C:/Users/test/Documents/Fovea/Batch',
}

function build(plan: AppConfigDto['buildPlan']): AppConfigDto {
  return {
    productName: plan === 'free' ? 'Fovea' : `Fovea ${plan === 'pro' ? 'Pro' : 'Studio'}`,
    version: '1.3.0',
    identifier: 'com.fovea.desktop',
    debug: false,
    buildPlan: plan,
  }
}

const FREE_BUILD = build('free')
const PRO_BUILD = build('pro')
const STUDIO_BUILD = build('studio')

/** The section reads the shell's license record, so the tests seed it the
 * way the bootstrap does — by dispatch, never by reaching into state. */
function Harness({ seed, installer }: { seed: LicenseStatusDto | null; installer: AppConfigDto }) {
  const { dispatch } = useAppState()
  useEffect(() => {
    dispatch({ type: 'core/ready', config: installer, systemInfo })
    dispatch(seed === null ? { type: 'license/error' } : { type: 'license/set', status: seed })
  }, [dispatch, seed, installer])
  return <LicenseSection />
}

function renderSection(seed: LicenseStatusDto | null = unactivated, installer = FREE_BUILD) {
  return render(
    <AppStateProvider>
      <Harness seed={seed} installer={installer} />
    </AppStateProvider>,
  )
}

beforeEach(() => {
  activateLicense.mockReset()
  deactivateLicense.mockReset()
})

describe('License section', () => {
  it('renders the unactivated story, and names the plan it means', async () => {
    renderSection(unactivated)
    expect(await screen.findByText(/running unactivated, on the free plan/i)).toBeInTheDocument()
    expect(
      screen.getByText(/every option marked pro or studio belongs to a key/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/the free plan: up to 2× upscaling, standard restoration/i),
    ).toBeInTheDocument()
  })

  it('shows the month meter with native’s own numbers', async () => {
    renderSection(unactivated)
    expect(await screen.findByText(/7 of 10 free enhancements left in october 2026/i)).toBeVisible()
    expect(screen.getByText(/a run that fails or is cancelled uses none/i)).toBeInTheDocument()
  })

  it('an unlimited plan reports no counter at all', async () => {
    renderSection(active)
    expect(await screen.findByText(/no monthly count/i)).toBeInTheDocument()
    expect(screen.queryByText(/free enhancements left/i)).not.toBeInTheDocument()
  })

  it('shows the full activation record when a license is active', async () => {
    renderSection(active)
    expect(await screen.findByText('Fovea Pro')).toBeInTheDocument()
    expect(screen.getByText('Licensed to')).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByText('PL-2026-000001')).toBeInTheDocument()
    expect(screen.getByText('Perpetual')).toBeInTheDocument()
    expect(screen.getByText('This machine')).toBeInTheDocument()
    expect(screen.getByText('d442e094')).toBeInTheDocument()
  })

  it('the activate button waits for a key, then reports success in plain words', async () => {
    renderSection(unactivated)
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

  it('activating switches the plan on screen, in the same render', async () => {
    renderSection(unactivated)
    const box = await screen.findByLabelText('License key')
    activateLicense.mockResolvedValue(asResult(active))
    fireEvent.change(box, { target: { value: 'FOVEA1.abc.def' } })
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }))
    // The meter is gone and the paid options are named — the record the
    // strip reads is this one, so the two surfaces cannot disagree.
    expect(await screen.findByText(/4× upscaling, all three restoration modes/i)).toBeVisible()
    expect(screen.queryByText(/free enhancements left/i)).not.toBeInTheDocument()
  })

  it('a repeated key says so honestly instead of pretending it is new', async () => {
    renderSection(active)
    await screen.findByText('Fovea Pro')
    const box = screen.getByLabelText('License key')
    fireEvent.change(box, { target: { value: 'FOVEA1.abc.def' } })
    activateLicense.mockResolvedValue(asResult(active, true))
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/already active/i)
  })

  it('a failed activation shows the native human-readable message, and recovers', async () => {
    renderSection(unactivated)
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

  it('expired licenses say who held them, when they lapsed, and what plan is left', async () => {
    renderSection({ ...active, state: 'expired', expiresAt: 1760000000 })
    expect(await screen.findByText(/license has expired/i)).toBeInTheDocument()
    expect(screen.getByText(/Renew with the store/i)).toBeInTheDocument()
    expect(screen.getByText(/on the free plan again/i)).toBeInTheDocument()
    expect(screen.getByText('Expires')).toBeInTheDocument()
  })

  it('a damaged local record invites re-pasting the key, not panic', async () => {
    renderSection({ ...unactivated, state: 'tampered' })
    expect(await screen.findByText(/record is damaged/i)).toBeInTheDocument()
    expect(screen.getByText(/paste your key again/i)).toBeInTheDocument()
  })

  it('a wound-back clock explains the fix in Windows settings', async () => {
    renderSection({ ...active, state: 'clock_suspect' })
    expect(await screen.findByText(/clock is set behind/i)).toBeInTheDocument()
    expect(screen.getByText(/Fix the date and time in Windows settings/i)).toBeInTheDocument()
  })

  it('deactivation runs through the bridge and lands back unactivated', async () => {
    renderSection(active)
    await screen.findByText('Fovea Pro')
    deactivateLicense.mockResolvedValue(unactivated)
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    expect(await screen.findByText(/running unactivated/i)).toBeInTheDocument()
    expect(deactivateLicense).toHaveBeenCalled()
  })

  it('an unreadable license is said plainly, and takes nothing away', async () => {
    renderSection(null)
    expect(await screen.findByText(/could not be read on this machine/i)).toBeInTheDocument()
    expect(screen.getByText(/images and enhancement are/i)).toBeInTheDocument()
    // The dead end is in the record, not on the screen: asking again puts the
    // plan back to "reading", which is the state the shell re-fetches from.
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(screen.getByText(/reading the license record/i)).toBeInTheDocument()
  })

  it('repeats the product promise where licenses live', async () => {
    renderSection(unactivated)
    expect(await screen.findByText(/never interrupted by a license question/i)).toBeInTheDocument()
    expect(screen.getByText(/verified on this machine, never online/i)).toBeInTheDocument()
  })

  it('shows every plan side by side, computed from the one policy table', async () => {
    renderSection(unactivated)
    const table = await screen.findByRole('table')
    // Nine capabilities, in native's order, none of them dropped.
    expect(within(table).getAllByRole('row')).toHaveLength(10)
    expect(within(table).getByRole('columnheader', { name: /in force/i })).toHaveTextContent(
      /free/i,
    )
    // The Studio-only row: two plans short, one plan that has it.
    const hardware = within(table).getByRole('row', {
      name: /hardware path and power mode/i,
    })
    expect(within(hardware).getAllByText('Not included')).toHaveLength(2)
    expect(within(hardware).getByText('Included')).toBeInTheDocument()
    // The metered row answers with native's own number on the side that does
    // not have the capability — never a figure this screen invented.
    const meter = within(table).getByRole('row', { name: /unlimited processing/i })
    expect(within(meter).getByText('10/mo')).toBeInTheDocument()
  })

  describe('a paid installer ahead of its key', () => {
    it('names what the build owes and how to open it', async () => {
      renderSection(unactivated, PRO_BUILD)
      expect(await screen.findByText('Fovea Pro installer')).toBeInTheDocument()
      expect(
        screen.getByText(/takes its paid options from a license key, not from the installer/i),
      ).toBeInTheDocument()
      expect(
        screen.getByText(/4× upscaling, the natural and detail models, the portrait look/i),
      ).toBeInTheDocument()
      // The one action the notice offers points at the box below it.
      fireEvent.click(screen.getByRole('button', { name: 'Paste the key now' }))
      expect(screen.getByLabelText('License key')).toHaveFocus()
    })

    it('says so differently once a shorter key is in force', async () => {
      renderSection(active, STUDIO_BUILD)
      expect(
        await screen.findByText(/one plan short of what this installer is named for/i),
      ).toBeInTheDocument()
      expect(screen.getByText(/choosing the hardware path and the power mode/i)).toBeInTheDocument()
    })

    it('goes quiet when the build’s own key is the one in force', async () => {
      renderSection(active, PRO_BUILD)
      expect(await screen.findByText('Fovea Pro')).toBeInTheDocument()
      expect(screen.queryByText(/nothing is wrong with this download/i)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Paste the key now' })).not.toBeInTheDocument()
    })

    it('never appears in the free build, which owes its user nothing', async () => {
      renderSection(unactivated, FREE_BUILD)
      expect(await screen.findByText(/running unactivated/i)).toBeInTheDocument()
      expect(screen.queryByText(/nothing is wrong with this download/i)).not.toBeInTheDocument()
    })
  })
})
