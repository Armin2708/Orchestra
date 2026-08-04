import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('ask, pulse-deliver, reply round-trip', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a1 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  const a2 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })).json()

  const q = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', to: 'jade-lynx', body: 'changing auth middleware?' } })).json()

  const p1 = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a2.id}/pulse` })).json()
  expect(p1.messages).toHaveLength(1)
  expect(p1.messages[0].body).toBe('changing auth middleware?')
  const p1b = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a2.id}/pulse` })).json()
  expect(p1b.messages).toHaveLength(0) // delivered once

  await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'jade-lynx', to: 'amber-fox', body: 'yes, hold off', reply_to: q.id } })
  const p2 = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a1.id}/pulse` })).json()
  expect(p2.messages[0].reply_to).toBe(q.id)
})

it('ask human lands in the operator inbox instead of failing recipient lookup', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })

  const m = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', to: 'human', kind: 'ask', body: 'Cert expired\nRenew or roll back?' } })).json()
  expect(m.to_agent_id).toBeNull()
  expect(m.to_human).toBe(1)

  const snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(snap.open_questions.map((q: any) => q.id)).toContain(m.id)

  // sentinel recipients only make sense where the operator can answer — notify still 400s
  const bad = await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', to: 'Operator', kind: 'notify', body: 'x' } })
  expect(bad.statusCode).toBe(400)
})

it('operator mail carries subject, type, and attachments; file preview stays inside the project', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-'))
  fs.writeFileSync(path.join(root, 'notes.md'), '# release notes')

  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: root } })).json()
  await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })

  const m = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', to: 'human', kind: 'ask',
    subject: 'Release notes ready', mail_type: 'action',
    attachments: [{ type: 'file', ref: 'notes.md' }, { type: 'card', ref: '12' }],
    body: 'Please review the attached notes and approve the release.' } })).json()
  expect(m.subject).toBe('Release notes ready')
  expect(m.mail_type).toBe('action')
  expect(JSON.parse(m.attachments)).toHaveLength(2)

  const ok = (await s.inject({ method: 'GET', url: `/api/v1/messages/${m.id}/attachments/0` })).json()
  expect(ok.content).toBe('# release notes')

  // non-file attachments have no readable content; escapes never leave the project
  expect((await s.inject({ method: 'GET', url: `/api/v1/messages/${m.id}/attachments/1` })).statusCode).toBe(400)
  const evil = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', to: 'human', kind: 'ask', subject: 'x', body: 'x',
    attachments: [{ type: 'file', ref: '../../etc/passwd' }] } })).json()
  const escape = await s.inject({ method: 'GET', url: `/api/v1/messages/${evil.id}/attachments/0` })
  expect([403, 404]).toContain(escape.statusCode)

  // mail fields without the human recipient are a contract violation, not board spam
  const stray = await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', subject: 'oops', body: 'x' } })
  expect(stray.statusCode).toBe(400)
  const badType = await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', to: 'human', kind: 'ask', mail_type: 'shout', body: 'x' } })
  expect(badType.statusCode).toBe(400)
})

it('operator reply on a human-rooted thread reaches the latest agent participant', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a1 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()

  const root = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, to: 'amber-fox', kind: 'ask', body: 'Status?' } })).json()
  await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', body: 'shipping tonight', reply_to: root.id } })

  // human follow-up: no explicit recipient, root sender is the human — route to amber-fox
  const followUp = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, body: 'send evidence when done', reply_to: root.id } })).json()
  expect(followUp.to_agent_id).toBe(a1.id)
})
