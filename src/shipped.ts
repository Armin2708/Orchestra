import { execFile } from 'node:child_process'
import type Database from 'better-sqlite3'
import type { EventEmitter } from 'node:events'

// deterministic card→commit linkage: ground-truth 'shipped' card_events (#54)

const git = (cwd: string, args: string[]) => new Promise<{ ok: boolean; out: string }>((resolve) => {
  execFile('git', args, { cwd, timeout: 5_000, maxBuffer: 256 * 1024 },
    (err, out, errOut) => resolve(err
      ? { ok: false, out: String(errOut || err.message).trim() }
      : { ok: true, out: String(out).trim() }))
})

export async function resolveCommit(cwd: string, ref: string): Promise<{ sha: string; subject: string } | { error: string }> {
  const r = await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])
  if (!r.ok) return { error: r.out }
  const subject = await git(cwd, ['log', '-1', '--format=%s', r.out])
  return { sha: r.out, subject: subject.ok ? subject.out : '' }
}

// resolves ref to a full sha in cwd, records an idempotent 'shipped' card_event
// (same card + same sha returns the existing row), emits SSE only on first record
export async function recordShipped(
  db: Database.Database, bus: EventEmitter | null,
  card: { id: number; board_id: number }, cwd: string,
  opts: { hash: string; by?: string | null; agentId?: number | null },
): Promise<{ event: any; created: boolean } | { error: string }> {
  const resolved = await resolveCommit(cwd, opts.hash)
  if ('error' in resolved) return { error: resolved.error }
  const existing = db.prepare(`
    SELECT * FROM card_events WHERE card_id=? AND type='shipped' AND json_extract(payload, '$.hash')=?
    ORDER BY id DESC LIMIT 1`).get(card.id, resolved.sha)
  if (existing) return { event: existing, created: false }
  const payload = JSON.stringify({ hash: resolved.sha, subject: resolved.subject, by: opts.by ?? null })
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, ?, 'shipped', ?)`)
    .run(card.id, opts.agentId ?? null, payload)
  const event = db.prepare(`SELECT * FROM card_events WHERE id=?`).get(Number(lastInsertRowid))
  bus?.emit('event', { board_id: card.board_id, type: 'card_event', data: event })
  return { event, created: true }
}
