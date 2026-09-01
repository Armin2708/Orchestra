import type Database from 'better-sqlite3'
import { insertSystemMail } from '../system-mail.js'
import type { CodexProviderService } from './provider-service.js'

const DRIFT_MAIL_SUBJECT = 'Codex CLI drifted off the pin'
const DRIFT_MAIL_FALLBACK_BODY =
  'Codex CLI drifted off its pinned version. Still running, on an unverified version.'

/**
 * Re-probe the Codex CLI version and, if it just drifted off the protocol pin,
 * mail every board's inbox once. One `codex` install serves every board on this
 * daemon, so the alert is daemon-wide, not board-scoped. Edge-triggered by
 * CodexProviderService.recheckVersion(): a tick after the alert already fired
 * returns false and sends nothing.
 *
 * fyi, not blocker: orchestra keeps running on the unverified version (see
 * CodexProviderService.unverifiedDetail) — this is a heads-up in case something
 * downstream breaks, not a report that codex stopped working.
 */
export const checkCodexDriftAndAlert = async (
  db: Database.Database,
  codexProvider: Pick<CodexProviderService, 'recheckVersion' | 'health'>,
): Promise<boolean> => {
  if (!codexProvider.recheckVersion()) return false
  const health = await codexProvider.health()
  const body = health.detail ?? DRIFT_MAIL_FALLBACK_BODY
  const boards = db.prepare(`SELECT id FROM boards`).all() as { id: number }[]
  for (const board of boards) {
    insertSystemMail(db, board.id, { subject: DRIFT_MAIL_SUBJECT, body, mailType: 'fyi' })
  }
  return true
}
