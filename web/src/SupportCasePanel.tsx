import React, { useState } from 'react'
import { getToken } from './api'
import './supportCase.css'

const CONSENT = 'I_CONSENT_TO_LOCAL_EXPORT_AND_REVIEW_BEFORE_SHARING'
const SHA256 = /^[a-f0-9]{64}$/
const CONTENT_DISPOSITION = /^attachment; filename="(orchestra-support-case-[A-Za-z0-9-]+-[a-f0-9]{12}\.json)"$/

type SupportDraft = {
  title: string
  summary: string
  reproduction: string
  expected: string
  actual: string
  exactCommit: string
  version: string
}

const emptyDraft: SupportDraft = {
  title: '',
  summary: '',
  reproduction: '',
  expected: '',
  actual: '',
  exactCommit: '',
  version: '0.1.0',
}

const sha256 = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export function SupportCasePanel() {
  const [draft, setDraft] = useState(emptyDraft)
  const [consented, setConsented] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState<{ filename: string; sha256: string } | null>(null)
  const update = (key: keyof SupportDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }))

  const exportCase = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!consented || busy) return
    setBusy(true)
    setError(null)
    setCompleted(null)
    try {
      const token = getToken()
      if (!token) throw new Error('Local owner authorization is required.')
      const reproductionSteps = draft.reproduction.split('\n').map((step) => step.trim()).filter(Boolean)
      const response = await fetch('/api/v1/ops/support-case', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: draft.title,
          summary: draft.summary,
          reproduction_steps: reproductionSteps,
          expected: draft.expected,
          actual: draft.actual,
          exact_commit: draft.exactCommit,
          orchestra_version: draft.version,
          consent: CONSENT,
        }),
      })
      const disposition = response.headers.get('content-disposition') ?? ''
      const filename = CONTENT_DISPOSITION.exec(disposition)?.[1]
      const expectedDigest = response.headers.get('x-content-sha256') ?? ''
      const bytes = await response.arrayBuffer()
      if (!response.ok
        || !response.headers.get('content-type')?.startsWith('application/json')
        || !filename
        || !SHA256.test(expectedDigest)
        || bytes.byteLength <= 0
        || bytes.byteLength > 16 * 1024 * 1024
        || await sha256(bytes) !== expectedDigest) {
        throw new Error('The verified support-case export was rejected.')
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }))
      try {
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        link.rel = 'noopener'
        link.click()
      } finally {
        URL.revokeObjectURL(url)
      }
      setCompleted({ filename, sha256: expectedDigest })
      setConsented(false)
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Support-case export failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="support-case-panel" aria-labelledby="support-case-title">
      <header>
        <div>
          <p className="settings-kicker">Local support export</p>
          <h2 id="support-case-title">Prepare a bug report</h2>
          <p>Creates one local JSON file containing the report and the exact strictly verified redacted diagnostics bytes. Nothing is uploaded.</p>
        </div>
        <span>Manual review required</span>
      </header>
      <form onSubmit={exportCase}>
        <label>Title<input required maxLength={240} value={draft.title}
          onChange={(event) => update('title', event.target.value)} /></label>
        <label>Summary<textarea required maxLength={4000} value={draft.summary}
          onChange={(event) => update('summary', event.target.value)} /></label>
        <label>Reproduction steps <small>One step per line</small><textarea required maxLength={8000}
          value={draft.reproduction} onChange={(event) => update('reproduction', event.target.value)} /></label>
        <div className="support-case-pair">
          <label>Expected<textarea required maxLength={4000} value={draft.expected}
            onChange={(event) => update('expected', event.target.value)} /></label>
          <label>Actual<textarea required maxLength={4000} value={draft.actual}
            onChange={(event) => update('actual', event.target.value)} /></label>
        </div>
        <div className="support-case-pair">
          <label>Exact commit<input required pattern="[a-f0-9]{40}" maxLength={40} value={draft.exactCommit}
            onChange={(event) => update('exactCommit', event.target.value)} /></label>
          <label>Orchestra version<input required pattern="[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?"
            maxLength={80} value={draft.version} onChange={(event) => update('version', event.target.value)} /></label>
        </div>
        <label className="support-case-consent">
          <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />
          <span>I consent to creating a local export and will decode and review it before sharing. I understand no report is submitted automatically.</span>
        </label>
        <div className="support-case-actions">
          <button type="submit" disabled={!consented || busy}>{busy ? 'Verifying…' : 'Create local export'}</button>
          <p aria-live="polite">{error
            ? <span className="error">{error}</span>
            : completed
              ? <span className="saved">Saved {completed.filename} · SHA-256 {completed.sha256.slice(0, 12)}… Review before sharing.</span>
              : 'The daemon generates fresh allowlisted diagnostics and verifies the exact bytes before export.'}</p>
        </div>
      </form>
    </section>
  )
}
