/**
 * Top bar identity (Stage 20 packaging): the name on the bar is the name the
 * installer carries, and the plan a key puts in force gets a mark of its own.
 * Both are things a customer should be able to see without opening Settings —
 * the same reason a locked control stays on screen instead of disappearing.
 */
import { render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AppConfigDto, LicenseStatusDto } from '../types/ipc'
import { TopBar } from './TopBar'
import { AppStateProvider } from '../state/AppState'
import { useAppState } from '../state/useAppState'

const FREE_CAPS = ['enhance', 'export', 'batch', 'journal']

function build(plan: AppConfigDto['buildPlan']): AppConfigDto {
  return {
    productName: plan === 'free' ? 'Fovea' : `Fovea ${plan === 'pro' ? 'Pro' : 'Studio'}`,
    version: '1.3.0',
    identifier: 'com.fovea.desktop',
    debug: false,
    buildPlan: plan,
  }
}

const proKey: LicenseStatusDto = {
  state: 'active',
  edition: 'pro',
  holder: 'ada@example.com',
  licenseId: 'PL-1',
  issuedAt: 1,
  expiresAt: null,
  activatedAt: 2,
  machineBound: false,
  capabilities: [...FREE_CAPS, 'upscale_4x', 'advanced_restoration', 'face_enhancement'],
  machineHint: 'abcd1234',
  quota: null,
}

function Harness({
  installer,
  license,
}: {
  installer: AppConfigDto
  license: LicenseStatusDto | null
}) {
  const { dispatch } = useAppState()
  useEffect(() => {
    dispatch({
      type: 'core/ready',
      config: installer,
      systemInfo: {
        osFamily: 'windows',
        arch: 'x86_64',
        appDataDir: 'C:/Users/test/AppData',
        logsDir: 'C:/Users/test/AppData/logs',
        defaultExportDir: '',
        defaultBatchExportDir: '',
      },
    })
    if (license) dispatch({ type: 'license/set', status: license })
  }, [dispatch, installer, license])
  return (
    <TopBar
      onOpenSettings={vi.fn()}
      onOpenShortcuts={vi.fn()}
      onOpenAbout={vi.fn()}
      onSetTheme={vi.fn()}
    />
  )
}

function renderBar(installer: AppConfigDto, license: LicenseStatusDto | null = null) {
  return render(
    <AppStateProvider>
      <Harness installer={installer} license={license} />
    </AppStateProvider>,
  )
}

describe('the top bar name', () => {
  it('shows the name the installer was built under', async () => {
    renderBar(build('studio'))
    expect(await screen.findByText('Fovea Studio')).toBeInTheDocument()
  })

  it('marks a paid plan running under the plain name', async () => {
    renderBar(build('free'), proKey)
    expect(await screen.findByText('Fovea')).toBeInTheDocument()
    expect(screen.getByText('Pro')).toBeInTheDocument()
  })

  it('does not label a plan twice when the name already carries it', async () => {
    renderBar(build('pro'), proKey)
    expect(await screen.findByText('Fovea Pro')).toBeInTheDocument()
    expect(screen.queryByText('Pro')).not.toBeInTheDocument()
  })

  it('shows no mark at all for the free plan', async () => {
    renderBar(build('free'))
    await screen.findByText('Fovea')
    expect(screen.queryByText('Pro')).not.toBeInTheDocument()
    expect(screen.queryByText('Studio')).not.toBeInTheDocument()
  })
})
