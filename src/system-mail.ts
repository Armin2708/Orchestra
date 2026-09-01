import type Database from 'better-sqlite3'

export type SystemMailType = 'question' | 'action' | 'update' | 'blocker' | 'fyi'

/**
 * Insert operator mail (to_human) that the daemon originates itself, not an
 * agent — e.g. a provider health alert. Uses the same `messages` shape the
 * /api/v1/messages mail path writes, so it renders in the Inbox identically.
 * Internal callers only: mail_type is a typed literal, not runtime-validated
 * like the HTTP boundary in server.ts.
 */
export const insertSystemMail = (
  db: Database.Database,
  boardId: number,
  mail: { subject: string; body: string; mailType: SystemMailType },
): void => {
  db.prepare(`
    INSERT INTO messages (board_id, from_agent_id, to_agent_id, card_id, kind, body, reply_to, to_human, subject, mail_type)
    VALUES (?, NULL, NULL, NULL, 'announce', ?, NULL, 1, ?, ?)`)
    .run(boardId, mail.body, mail.subject.slice(0, 200), mail.mailType)
}
