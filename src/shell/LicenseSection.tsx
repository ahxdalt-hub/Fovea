/**
 * License (Stage 13, gated by Stage 20) — the activation experience, kept
 * small and honest.
 *
 * The four questions this section must answer without a manual:
 * 1. Where does a license come from?  (purchased; the key arrives with
 *    the order — never from inside the app)
 * 2. How do I enter it?               (paste below; whitespace-tolerant)
 * 3. Did activation work?             (a named edition + holder, and the
 *    options that came with it)
 * 4. What if it failed?               (the native layer's human-readable
 *    message, which always ends in an action)
 *
 * And the product promise, stated straight: this record decides *which
 * options Fovea offers you*, and nothing else. Verification happens on the
 * machine with no network, an enhancement already running is never interrupted
 * by a license question, and every file already written stays yours whatever
 * the record later says.
 */
import { useState } from 'react'
import { activateLicense, deactivateLicense } from '../ipc/bridge'
import { toAppError, type LicenseStatusDto } from '../types/ipc'
import { FREE_MAX_SCALE, periodLabel, planName, planQuota, planView } from '../lib/entitlements'
import { useAppState } from '../state/useAppState'
import { Badge, type BadgeTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import './Dialogs.css'

const STATE_HEADLINE: Record<LicenseStatusDto['state'], string> = {
  not_activated: 'Fovea is running unactivated, on the free plan.',
  active: 'Fovea is activated.',
  expired: 'This license has expired.',
  wrong_machine: 'This license key is bound to a different computer.',
  tampered: 'The stored license record is damaged.',
  revoked: 'This license was revoked by its issuer.',
  clock_suspect: "This computer's clock is set behind the last time Fovea ran.",
}

/** Each sentence answers the one question this screen exists to answer:
 * what does the record mean for the options on screen? A lapsed, damaged,
 * foreign or revoked key all mean the same thing commercially — this machine
 * is back on the free plan — so each one says it plainly instead of hiding
 * behind "unavailable". Nothing about the work itself is ever at stake. */
const STATE_SENTENCE: Record<LicenseStatusDto['state'], string> = {
  not_activated:
    'Every option marked Pro or Studio belongs to a key. The rest runs on this machine without one, ' +
    'and without a network connection.',
  active: 'Thank you for supporting Fovea.',
  expired:
    'Its period has closed, so this machine is on the free plan again. Renew with the store you bought it ' +
    'from — the paid options return the moment the key verifies.',
  wrong_machine:
    'The key was issued for a specific computer and this is not it, so its options are not offered here. ' +
    'Ask the store you bought it from to re-issue for this machine.',
  tampered:
    'The record stored on this machine no longer verifies, so the free plan is in force. Nothing is broken — ' +
    'paste your key again below to restore it.',
  revoked:
    'Its issuer withdrew it, so this machine runs on the free plan. ' +
    'Contact the store you bought the key from.',
  clock_suspect:
    'Fix the date and time in Windows settings (Fovea keeps the highest clock it has seen, so rewinding the ' +
    'clock does not extend a license). Once the clock is right this resolves itself; meanwhile the copy runs ' +
    'on the free plan.',
}

const STATE_TONE: Record<LicenseStatusDto['state'], BadgeTone> = {
  not_activated: 'neutral',
  active: 'success',
  expired: 'warning',
  wrong_machine: 'warning',
  tampered: 'warning',
  revoked: 'danger',
  clock_suspect: 'warning',
}

function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function LicenseSection() {
  // The plan record belongs to the shell, not to this section (Stage 20): the
  // Enhance strip, Batch and Settings all read the same one, so activation has
  // to land in a single place. Reading it is the bootstrap's job; this screen
  // renders it and writes the two changes a user can make to it.
  const { state, dispatch } = useAppState()
  const status = state.license
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const activate = async () => {
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await activateLicense(key)
      dispatch({ type: 'license/set', status: result.status })
      setKey('')
      const edition = result.status.edition ? titleCase(result.status.edition) : 'Fovea'
      setSuccess(
        result.alreadyActive
          ? `Already active — this key is the license in use on this machine (${edition}).`
          : `License activated: Fovea ${edition}${
              result.status.holder ? ` for ${result.status.holder}` : ''
            }. Its options are open now — no restart and no second download.`,
      )
    } catch (err) {
      setError(toAppError(err).message)
    } finally {
      setBusy(false)
    }
  }

  const deactivate = async () => {
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      dispatch({ type: 'license/set', status: await deactivateLicense() })
    } catch (err) {
      setError(toAppError(err).message)
    } finally {
      setBusy(false)
    }
  }

  if (state.licenseStatus === 'error') {
    return (
      <>
        <SectionIntro />
        <p className="pix-settings__note">
          The license record could not be read on this machine. Nothing is taken away and nothing is
          marked as paid — the plan simply stays unknown, and your images and enhancement are
          unaffected.
        </p>
        {/* Back to `loading` is the whole retry: the shell's bootstrap reads
            the record again when it sees a plan it has not resolved. */}
        <div className="pix-license__actions">
          <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'license/loading' })}>
            Check again
          </Button>
        </div>
      </>
    )
  }
  if (!status) {
    return (
      <>
        <SectionIntro />
        <p className="pix-settings__note">Reading the license record…</p>
      </>
    )
  }

  const isActive = status.state === 'active'
  const showsDetail =
    status.edition !== null || isActive || status.state === 'expired' || status.state === 'revoked'

  return (
    <>
      <SectionIntro />

      <div className="pix-settings__group">
        <div className="pix-license__head">
          <Badge tone={STATE_TONE[status.state]} dot>
            {isActive ? `Fovea ${titleCase(status.edition ?? 'licensed')}` : 'Not activated'}
          </Badge>
          <p className="pix-settings__note">{STATE_HEADLINE[status.state]}</p>
        </div>
        <p className="pix-settings__note">{STATE_SENTENCE[status.state]}</p>

        <PlanSummary status={status} />

        {showsDetail && (
          <div className="pix-settings__diag">
            {status.holder && <LicenseRow label="Licensed to" value={status.holder} />}
            {status.licenseId && <LicenseRow label="License id" value={status.licenseId} />}
            {status.expiresAt === null && status.edition && (
              <LicenseRow label="Validity" value="Perpetual" />
            )}
            {status.expiresAt !== null && (
              <LicenseRow label="Expires" value={formatDate(status.expiresAt)} />
            )}
            {status.activatedAt !== null && (
              <LicenseRow label="Activated" value={formatDate(status.activatedAt)} />
            )}
            <LicenseRow
              label="Machine bound"
              value={status.machineBound ? 'Yes — this machine only' : 'No'}
            />
            <LicenseRow label="This machine" value={status.machineHint} />
          </div>
        )}
      </div>

      <div className="pix-settings__group">
        <label className="pix-field__label" htmlFor="fovea-license-key">
          License key
        </label>
        <textarea
          id="fovea-license-key"
          className="pix-input pix-license__key"
          rows={3}
          spellCheck={false}
          placeholder="FOVEA1.…"
          value={key}
          disabled={busy}
          onChange={(event) => setKey(event.target.value)}
        />
        <p className="pix-field__message">
          Issued when you purchase Fovea — check your order confirmation. Keys are verified on this
          machine; activation needs no internet connection.
        </p>
        {error && (
          <p className="pix-field__message pix-field__message--error" role="alert">
            {error}
          </p>
        )}
        {success && (
          <p className="pix-field__message" role="status">
            {success}
          </p>
        )}
        <div className="pix-license__actions">
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !key.trim()}
            onClick={() => void activate()}
          >
            {busy ? 'Checking…' : 'Activate'}
          </Button>
          {isActive && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void deactivate()}>
              Deactivate
            </Button>
          )}
        </div>
      </div>

      <p className="pix-settings__footnote">
        A key changes which options Fovea offers you, and nothing else. It is verified on this
        machine, never online. An enhancement in progress is never interrupted by a license
        question, and every file already written stays yours whatever this record later says. The
        one exception is the free plan's monthly count, which Fovea's server keeps so that this
        machine's clock cannot mint an allowance; nothing about your images is sent, and paid plans
        make no call at all.
      </p>
    </>
  )
}

/** The commercial result of the record, in the same words the rest of the app
 * uses: which options are open right now and, on a metered plan, how much of
 * the month is left. Both numbers come from native — the capability list and
 * the meter — so this screen can never promise an option the strip refuses. */
function PlanSummary({ status }: { status: LicenseStatusDto }) {
  const plan = planView(status)
  const quota = planQuota(plan)
  const line =
    plan.tier === 'free'
      ? `The free plan: up to ${FREE_MAX_SCALE}× upscaling, Standard restoration, every finishing look except Portrait, and a monthly allowance of enhancements. Import, batch and export are never counted.`
      : plan.tier === 'pro'
        ? 'Fovea Pro: 4× upscaling, all three restoration modes, every finishing look, and no monthly count. Choosing the hardware path yourself is ' +
          planName('studio') +
          '.'
        : `Fovea Studio: everything in Pro, plus the switches on the Processing and Performance pages — force the processor, or ask for every core.`
  return (
    <div className="pix-license__plan">
      <span className="pix-field__label">Open on this machine</span>
      <p className="pix-settings__note">{line}</p>
      {quota && (
        <p className="pix-settings__note">
          {quota.counted ? (
            <>
              {quota.remaining} of {quota.limit} free enhancements left in{' '}
              {periodLabel(quota.period)}. One is used per finished image, so a run that fails or is
              cancelled uses none; the count resets on the 1st.
            </>
          ) : (
            <>
              The free plan allows {quota.limit} enhancements a month. That count is kept on Fovea's
              server rather than on this machine's clock, so the first enhancement needs one
              internet connection — after that it works offline, and the allowance resets on the
              1st.
            </>
          )}
        </p>
      )}
    </div>
  )
}

function SectionIntro() {
  return (
    <SectionHeader
      title="License"
      blurb="Your commercial record for this copy of Fovea — it decides which options the app offers you, and nothing about where your files go."
    />
  )
}

function SectionHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <header className="pix-settings__section-head">
      <h3 className="pix-settings__section-title">{title}</h3>
      <p className="pix-settings__section-blurb">{blurb}</p>
    </header>
  )
}

function LicenseRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="pix-settings__row">
      <span className="pix-settings__label">{label}</span>
      <span className="pix-settings__value u-tabular">{value}</span>
    </div>
  )
}
