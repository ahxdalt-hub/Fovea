/**
 * License (Stage 13) — the activation experience, kept small and honest.
 *
 * The four questions this section must answer without a manual:
 * 1. Where does a license come from?  (purchased; the key arrives with
 *    the order — never from inside the app)
 * 2. How do I enter it?               (paste below; whitespace-tolerant)
 * 3. Did activation work?             (a named edition + holder, or a
 *    plain sentence about what happened)
 * 4. What if it failed?               (the native layer's human-readable
 *    message, which always ends in an action)
 *
 * And the product promise, repeated where licenses live: activation
 * changes the commercial record of this copy — it never gates image
 * processing, which runs on this machine either way.
 */
import { useEffect, useState } from 'react'
import { activateLicense, deactivateLicense, getLicenseStatus } from '../ipc/bridge'
import { toAppError, type LicenseStatusDto } from '../types/ipc'
import { Badge, type BadgeTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import './Dialogs.css'

const STATE_HEADLINE: Record<LicenseStatusDto['state'], string> = {
  not_activated: 'Fovea is running unactivated.',
  active: 'Fovea is activated.',
  expired: 'This license has expired.',
  wrong_machine: 'This license key is bound to a different computer.',
  tampered: 'The stored license record is damaged.',
  revoked: 'This license was revoked by its issuer.',
  clock_suspect: "This computer's clock is set behind the last time Fovea ran.",
}

const STATE_SENTENCE: Record<LicenseStatusDto['state'], string> = {
  not_activated:
    'Everything Fovea does — import, enhance, batch, export — runs on this machine with or without a key. ' +
    'Activating records your commercial license for this copy.',
  active: 'Thank you for supporting Fovea.',
  expired:
    'Your key was valid but its period has closed. Renew with the store you bought it from; ' +
    'enhancement on this machine continues meanwhile.',
  wrong_machine:
    'The key was issued for a specific computer and this is not it. Ask the store you bought it from ' +
    'to re-issue for this machine.',
  tampered:
    'The license record stored on this machine no longer verifies. Nothing is broken — ' +
    'paste your key again below to restore it.',
  revoked:
    'Contact the store you bought the key from. Enhancement on this machine continues meanwhile.',
  clock_suspect:
    'Fix the date and time in Windows settings (Fovea keeps the highest clock it has seen, ' +
    'so rewinding the clock does not extend a license). Once the clock is right, this resolves itself.',
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
  const [status, setStatus] = useState<LicenseStatusDto | null>(null)
  const [failed, setFailed] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getLicenseStatus()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const activate = async () => {
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await activateLicense(key)
      setStatus(result.status)
      setKey('')
      const edition = result.status.edition ? titleCase(result.status.edition) : 'Fovea'
      setSuccess(
        result.alreadyActive
          ? `Already active — this key is the license in use on this machine (${edition}).`
          : `License activated: Fovea ${edition}${
              result.status.holder ? ` for ${result.status.holder}` : ''
            }.`,
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
      setStatus(await deactivateLicense())
    } catch (err) {
      setError(toAppError(err).message)
    } finally {
      setBusy(false)
    }
  }

  if (failed) {
    return (
      <>
        <SectionIntro />
        <p className="pix-settings__note">
          License information is unavailable right now. Restart Fovea if this persists — your
          images and enhancement are unaffected.
        </p>
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
        Licensing is a record about this copy of Fovea, never a dependency of your work: the
        enhancement engine processes images locally and will not wait on a license check.
      </p>
    </>
  )
}

function SectionIntro() {
  return (
    <SectionHeader
      title="License"
      blurb="Your commercial record for this copy of Fovea. Nothing here changes what the app can do on your machine."
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
