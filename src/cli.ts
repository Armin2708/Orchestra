import { Command, InvalidArgumentError } from 'commander'
import { ensureDaemon, serve, stopDaemon, baseUrl } from './daemon.js'
import { api, projectPath } from './client.js'
import { VERSION } from './version.js'
import { runHook } from './hooks.js'
import { installHooks, uninstallHooks } from './install.js'
import { ensureToken } from './token.js'
import {
  enableNewRemotePairing,
  pairUrl,
  rollbackRemoteAccess,
  startRemote,
  stopRemote,
} from './remote.js'
import { messageBody } from './msgsafe.js'
import { registerAgentOsCommands } from './agent-os-cli.js'
import { registerDoctorCommand } from './doctor-cli.js'
import qrcode from 'qrcode-terminal'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from './daemon.js'
import { openDb } from './db.js'
import {
  assertSafeChildPath,
  createDatabaseBackup,
  restoreDatabaseBackup,
  retireDatabaseBackups,
  verifyDatabaseBackup,
} from './agent-os/database-recovery.js'
import { acquireDatabaseRestoreQuiescenceGuard } from './agent-os/database-quiescence.js'
import { OperationsRetentionService } from './agent-os/operations-recovery.js'
import {
  ProtectedCredentialVault,
  createPlatformCredentialStore,
  type ProtectedCredentialReference,
} from './operations/credentials.js'

const program = new Command().name('orchestra').version(VERSION)
const csv = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean)
const envAgent = () => process.env.ORCHESTRA_AGENT
const resolveOperationsStateDirectory = async (
  stateRoot: string,
  requestedRoot: string,
  create: boolean,
): Promise<string> => {
  const candidate = await assertSafeChildPath(stateRoot, requestedRoot)
  if (create) fs.mkdirSync(candidate, { recursive: true, mode: 0o700 })
  const canonicalStateRoot = fs.realpathSync(stateRoot)
  const canonicalCandidate = fs.realpathSync(candidate)
  const relative = path.relative(canonicalStateRoot, canonicalCandidate)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('backup root must remain inside Orchestra state')
  }
  return canonicalCandidate
}
const providerOption = (allowBoth: boolean) => (value: string) => {
  const accepted = allowBoth ? ['claude', 'codex', 'both'] : ['claude', 'codex']
  if (!accepted.includes(value))
    throw new InvalidArgumentError(`expected ${accepted.join('|')}`)
  return value
}

async function up() { if (!(await ensureDaemon())) { console.error('daemon unreachable'); process.exit(1) } }
async function board() { return api('POST', '/boards/resolve', { project_path: projectPath() }) }
// explicit flag > env > sole active agent on the board
async function inferAgent(boardId: number, explicit?: string): Promise<string | undefined> {
  if (explicit ?? envAgent()) return explicit ?? envAgent()
  const snap = await api('GET', `/boards/${boardId}/snapshot`)
  const live = snap.agents.filter((a: any) => a.status !== 'gone')
  return live.length === 1 ? live[0].name : undefined
}

program.command('serve').description('run daemon in foreground')
  .option('--expose', 'listen on all interfaces instead of localhost (requires token auth)')
  .action(async (o) => {
    await serve({ expose: o.expose }); console.log(`orchestra on ${baseUrl()}${o.expose ? ' (exposed on all interfaces)' : ''}`)
  })
program.command('stop').action(() => { console.log(stopDaemon() ? 'stopped' : 'not running') })
program.command('restart').description('gracefully restart the daemon — defers while hired agents are live')
  .option('--force', 'restart anyway (hired agents resume from saved sessions; one-shot auditors do not survive)')
  .action(async (o) => {
    const alive = async () => { try { return (await (await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(300) })).json()).ok === true } catch { return false } }
    if (await alive()) {
      const sys = await api('GET', '/system').catch(() => undefined)
      if (!o.force && sys && sys.hired > 0) {
        console.error(`deferred: ${sys.hired} hired agent(s) still live — drain them first or use --force.`)
        console.error('Run the restart from an interactive terminal so you can approve the keychain prompt ("Always Allow") for the usage meters.')
        process.exit(1)
      }
      stopDaemon()
      for (let i = 0; i < 50 && (await alive()); i++) await new Promise((r) => setTimeout(r, 100))
    }
    console.log((await ensureDaemon()) ? `daemon restarted on ${baseUrl()}` : 'daemon failed to restart')
  })
program.command('token').description('print the API token (paste it into the web UI login)')
  .action(() => {
    const scoped = process.env.ORCHESTRA_AGENT_TOKEN?.trim()
    if (process.env.ORCHESTRA_MANAGED_AGENT === '1') {
      if (!scoped) throw new Error('managed agent credential is unavailable')
      console.log(scoped)
      return
    }
    console.log(ensureToken())
  })

const ops = program.command('ops').description('local operations, recovery, and retention controls')
ops.command('diagnostics <destination>')
  .description('write one allowlisted redacted diagnostics bundle to a new owner-only file')
  .action(async (destination) => {
    await up()
    const response = await fetch(`${baseUrl()}/api/v1/ops/diagnostics`, {
      redirect: 'error', cache: 'no-store',
      headers: { authorization: `Bearer ${ensureToken()}`, accept: 'application/gzip' },
    })
    if (!response.ok || response.headers.get('content-type') !== 'application/gzip') {
      throw new Error('the daemon could not create a redacted diagnostics bundle')
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
      throw new Error('diagnostics bundle size is invalid')
    }
    const resolved = path.resolve(destination)
    const descriptor = fs.openSync(resolved, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
    try {
      fs.writeFileSync(descriptor, bytes)
      fs.fsyncSync(descriptor)
    } catch (error) {
      try { fs.unlinkSync(resolved) } catch { /* retain original write failure */ }
      throw error
    } finally { fs.closeSync(descriptor) }
    console.log(JSON.stringify({
      path: resolved,
      bytes: bytes.length,
      sha256: response.headers.get('x-content-sha256'),
      review_before_sharing: true,
    }, null, 2))
  })
ops.command('backup [name]').option('--root <directory>', 'backup root under the Orchestra state directory')
  .action(async (name, o) => {
    const stateRoot = dataDir()
    const backupRoot = await resolveOperationsStateDirectory(
      stateRoot,
      path.resolve(o.root ?? path.join(stateRoot, 'backups')),
      true,
    )
    const db = openDb(path.join(stateRoot, 'orchestra.db'))
    try {
      const backup = await createDatabaseBackup(db, { backupRoot, name })
      console.log(JSON.stringify(backup, null, 2))
    } finally { db.close() }
  })
ops.command('verify-backup <manifest>').action(async (manifest) => {
  console.log(JSON.stringify(await verifyDatabaseBackup(manifest), null, 2))
})
ops.command('restore <manifest>')
  .requiredOption('--confirm-quiesced', 'require a recorded clean daemon/provider shutdown proof')
  .action(async (manifest, o) => {
    if (!o.confirmQuiesced) throw new Error('restore requires --confirm-quiesced')
    const stateRoot = dataDir()
    const destinationPath = path.join(stateRoot, 'orchestra.db')
    const quiescence = acquireDatabaseRestoreQuiescenceGuard({ stateRoot, destinationPath })
    try {
      const restored = await restoreDatabaseBackup({
        manifestPath: manifest,
        stateRoot,
        destinationPath,
        isQuiesced: quiescence.verify,
      })
      quiescence.consume()
      console.log(JSON.stringify(restored, null, 2))
    } finally {
      quiescence.release()
    }
  })
ops.command('retire-backups')
  .option('--root <directory>', 'backup root under the Orchestra state directory')
  .requiredOption('--keep <count>', 'number of newest backups to keep')
  .action(async (o) => {
    const stateRoot = dataDir()
    const backupRoot = await resolveOperationsStateDirectory(
      stateRoot,
      path.resolve(o.root ?? path.join(stateRoot, 'backups')),
      false,
    )
    const retired = await retireDatabaseBackups({ backupRoot, keep: Number(o.keep) })
    console.log(JSON.stringify({ retired }, null, 2))
  })
ops.command('configure-retention')
  .requiredOption('--board <id>').requiredOption('--events <days>')
  .requiredOption('--transcripts <days>').requiredOption('--pty <days>')
  .requiredOption('--artifacts <days>')
  .action((o) => {
    const db = openDb(path.join(dataDir(), 'orchestra.db'))
    try {
      const service = new OperationsRetentionService(db)
      const policy = db.transaction(() => {
        const configured = service.configure({
          boardId: Number(o.board), eventDays: Number(o.events),
          transcriptDays: Number(o.transcripts), ptyDays: Number(o.pty),
          artifactDays: Number(o.artifacts),
        })
        const eventId = `retention-auth:${randomUUID()}`
        db.prepare(`INSERT INTO os_events (
          id, board_id, kind, source, payload, actor_type, actor_id, idempotency_key
        ) VALUES (?, ?, 'operations.retention.authorized', 'local-cli', ?,
          'local_operator', 'local-owner', ?)`).run(
          eventId,
          configured.board_id,
          JSON.stringify({ policy_updated_at: configured.updated_at }),
          eventId,
        )
        return configured
      }).immediate()
      console.log(JSON.stringify(policy, null, 2))
    } finally { db.close() }
  })
ops.command('credential-store').description('verify the platform credential facility').action(async () => {
  const store = createPlatformCredentialStore()
  const available = await store.isAvailable()
  console.log(JSON.stringify({ facility: store.facility, available }))
  if (!available) process.exitCode = 1
})
const readCredentialReference = (referencePath: string): ProtectedCredentialReference => {
  const resolved = path.resolve(referencePath)
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as ProtectedCredentialReference
  if (!parsed || typeof parsed !== 'object') throw new Error('credential reference file is invalid')
  return parsed
}
const readCredentialStdin = (): Uint8Array => {
  const material = fs.readFileSync(0)
  if (material.byteLength < 16) {
    material.fill(0)
    throw new Error('credential stdin must contain at least 16 bytes')
  }
  return material
}
ops.command('protect-credential')
  .description('store credential bytes from stdin and print only an opaque reference')
  .requiredOption('--ttl-ms <milliseconds>')
  .action(async (o) => {
    const material = readCredentialStdin()
    try {
      const reference = await new ProtectedCredentialVault(createPlatformCredentialStore())
        .protect(material, Number(o.ttlMs))
      console.log(JSON.stringify(reference, null, 2))
    } finally { material.fill(0) }
  })
ops.command('check-credential <reference>')
  .description('verify an opaque credential reference without printing secret material')
  .action(async (referencePath) => {
    const vault = new ProtectedCredentialVault(createPlatformCredentialStore())
    const material = await vault.resolve(readCredentialReference(referencePath))
    material.fill(0)
    console.log(JSON.stringify({ available: true }))
  })
ops.command('rotate-credential <reference>')
  .description('atomically replace a credential using bytes from stdin and print the new reference')
  .requiredOption('--ttl-ms <milliseconds>')
  .action(async (referencePath, o) => {
    const material = readCredentialStdin()
    try {
      const reference = await new ProtectedCredentialVault(createPlatformCredentialStore())
        .rotate(readCredentialReference(referencePath), material, Number(o.ttlMs))
      console.log(JSON.stringify(reference, null, 2))
    } finally { material.fill(0) }
  })
ops.command('revoke-credential <reference>')
  .description('individually revoke an opaque credential reference')
  .action(async (referencePath) => {
    await new ProtectedCredentialVault(createPlatformCredentialStore())
      .revoke(readCredentialReference(referencePath))
    console.log(JSON.stringify({ revoked: true }))
  })

program.command('remote').description('start private remote access with secure device pairing')
  .option('--stop', 'stop the verified Orchestra-owned tunnel')
  .option('--rollback <confirmation>', 'durably revoke all remote authority; requires REVOKE_ALL_REMOTE_AUTHORITY')
  .option('--reason <reason>', 'operator reason recorded with an emergency rollback')
  .option('--enable-new-pairing <confirmation>', 're-enable only new pairing; requires ENABLE_NEW_REMOTE_PAIRING')
  .option('--public', 'confirm public Cloudflare exposure (also requires ORCHESTRA_REMOTE_PUBLIC_TUNNEL=1)')
  .option('--board <id...>', 'grant this device access only to the selected board ids')
  .option('--scope <scope...>', 'explicit device scopes: observe stream message approve agent-control terminal-write admin')
  .action(async (o) => {
    const controlActions = [o.stop === true, Boolean(o.rollback), Boolean(o.enableNewPairing)]
      .filter(Boolean).length
    if (controlActions > 1) throw new Error('--stop, --rollback, and --enable-new-pairing are mutually exclusive')
    if (o.rollback) {
      const result = await rollbackRemoteAccess(String(o.rollback), o.reason)
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (o.enableNewPairing) {
      const result = await enableNewRemotePairing(String(o.enableNewPairing))
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (o.stop) {
      const s = stopRemote()
      console.log(s
        ? `remote stop requested for ${s.provider}; verify ${s.url} is unreachable`
        : 'no recorded remote access state was found')
      return
    }
    const boardIds = (o.board ?? []).map((value: string) => Number(value))
    if (boardIds.some((value: number) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error('--board values must be positive integer board ids')
    }
    const scopes = o.scope as string[] | undefined
    const allowedScopes = new Set(['observe', 'stream', 'message', 'approve', 'agent-control', 'terminal-write', 'admin'])
    if (scopes?.some((scope) => !allowedScopes.has(scope))) {
      throw new Error('--scope contains an unsupported device scope')
    }
    if (scopes?.some((scope) => ['agent-control', 'terminal-write', 'admin'].includes(scope))) {
      console.error('WARNING: high-risk device authority requested; keep the device locked and revoke it immediately if lost.')
    }
    const { state, reused } = await startRemote({ confirmPublic: o.public === true })
    try {
      const url = await pairUrl(state, boardIds, scopes as never)
      console.log(`board exposed via ${state.provider}: ${state.url}${reused ? ' (already running)' : ''}`)
      console.log(state.provider === 'tailscale'
        ? 'Private tailnet exposure selected. Pair only a device you control:\n'
        : 'PUBLIC exposure selected. Pair promptly, keep scopes narrow, and stop the tunnel when finished:\n')
      qrcode.generate(url, { small: true })
      console.log(`\n${url}`)
      console.log('stop the verified tunnel with: orchestra remote --stop')
    } catch (error) {
      if (!reused) stopRemote()
      throw error
    }
  })

program.command('join').description('register this agent session on the project board (agents only)')
  .option('--name <name>').option('--session <id>')
  .option('--force', 'allow joining from outside an agent session (scripts/CI)')
  .action(async (o) => {
  if (!process.env.CLAUDECODE && !o.force && !process.env.ORCHESTRA_FORCE_JOIN) {
    console.error('join runs inside an agent session — open a Claude Code session and it joins automatically via hooks.')
    console.error('Scripting a headless agent? Use --force.')
    process.exit(1)
  }
  await up()
  const b = await board()
  const a = await api('POST', '/agents/register', { board_id: b.id, name: o.name ?? process.env.ORCHESTRA_NAME, session_id: o.session })
  console.log(`AGENT_ID=${a.id} AGENT_NAME=${a.name} BOARD_ID=${b.id}`)
  const snap = await api('GET', `/boards/${b.id}/snapshot`)
  for (const ag of snap.agents.filter((x: any) => x.status !== 'gone' && x.id !== a.id))
    console.log(`agent ${ag.name} (${ag.status})`)
  for (const c of snap.cards.filter((c: any) => c.column !== 'done'))
    console.log(`card #${c.id} [${c.column}] ${c.title} — ${c.owner ?? 'unowned'} — paths: ${c.paths.join(', ') || '-'}`)
})

const card = program.command('card')
const printOverlaps = (overlaps: any[], similar: any[] = [], doneSimilar: any[] = []) => {
  for (const o of overlaps) console.log(`⚠ overlap with card #${o.id} "${o.title}" (${o.owner}) on ${o.paths.join(', ')}`)
  for (const s of similar) console.log(`≈ similar work in progress: card #${s.id} "${s.title}" (${s.owner}) — check with them before proceeding: orchestra ask ${s.owner} "..."`)
  for (const d of doneSimilar) console.log(`≈ looks already shipped: card #${d.id} "${d.title}" (done) — verify with git log before starting`)
}
card.command('create <title>').option('--desc <d>').option('--paths <p>', '', csv)
  .option('--column <c>').option('--agent <a>')
  .option('--no-owner', 'leave the card unassigned (tickets meant to outlive their author)')
  .action(async (title, o) => {
    await up(); const b = await board()
    // commander maps --no-owner to o.owner === false
    const r = await api('POST', '/cards', { board_id: b.id, title, description: o.desc, paths: o.paths, column: o.column, agent: o.owner === false ? undefined : await inferAgent(b.id, o.agent) })
    console.log(`card #${r.card.id} created [${r.card.column}]`); printOverlaps(r.overlaps, r.similar, r.done_similar)
  })
card.command('update <id>').option('--title <t>').option('--desc <d>').option('--paths <p>', '', csv)
  .option('--column <c>').option('--agent <a>').action(async (id, o) => {
    await up()
    const r = await api('PATCH', `/cards/${id}`, { title: o.title, description: o.desc, paths: o.paths, column: o.column, agent: o.agent ?? envAgent() })
    console.log(`card #${r.card.id} updated [${r.card.column}]`); printOverlaps(r.overlaps, r.similar, r.done_similar)
  })
card.command('move <id> <column>').option('--agent <a>').action(async (id, column, o) => {
  await up()
  const r = await api('POST', `/cards/${id}/move`, { column, agent: o.agent ?? envAgent() })
  console.log(`card #${r.card.id} → ${r.card.column}`)
})

program.command('ask <to> [body]').option('--card <id>').option('--from <a>')
  .option('--stdin', 'read the body from stdin (no shell interpolation)')
  .action(async (to, body, o) => {
    const text = await messageBody(body, o.stdin)
    await up(); const b = await board()
    const m = await api('POST', '/messages', { board_id: b.id, from: await inferAgent(b.id, o.from), to, kind: 'ask', body: text, card_id: o.card ? Number(o.card) : undefined })
    console.log(`asked ${to} (msg #${m.id})`)
  })
program.command('reply <msgId> [body]').option('--from <a>')
  .option('--stdin', 'read the body from stdin (no shell interpolation)')
  .action(async (msgId, body, o) => {
    const text = await messageBody(body, o.stdin)
    await up(); const b = await board()
    const m = await api('POST', '/messages', { board_id: b.id, from: await inferAgent(b.id, o.from), kind: 'reply', body: text, reply_to: Number(msgId) })
    console.log(`replied (msg #${m.id})`)
  })

program.command('pulse').option('--agent-id <id>').action(async (o) => {
  await up()
  const id = o.agentId ?? process.env.ORCHESTRA_AGENT_ID
  if (!id) return
  const r = await api('POST', `/agents/${id}/pulse`)
  for (const m of r.messages) console.log(`[${m.from_name ?? 'human'}] ${m.body} (msg #${m.id})`)
})

program.command('snapshot').option('--board <id>').option('--full', 'complete board state as JSON').action(async (o) => {
  await up()
  const b = o.board ? { id: Number(o.board) } : await board()
  const snap = await api('GET', `/boards/${b.id}/snapshot`)
  if (o.full) return console.log(JSON.stringify(snap, null, 2))
  const active = snap.agents.filter((a: any) => a.status !== 'gone')
  console.log(`board "${snap.board.name}" — ${active.length} active agent(s): ${active.map((a: any) => a.name).join(', ') || '-'}`)
  for (const c of snap.cards.filter((c: any) => c.column !== 'done'))
    console.log(`#${c.id} [${c.column}] "${c.title}" (${c.owner ?? 'unowned'}) paths: ${c.paths.join(', ') || '-'}`)
  for (const q of snap.open_questions)
    console.log(`Q#${q.id} ${q.from_name ?? 'human'} → ${q.to_name ?? 'all'}: ${q.body.length > 140 ? q.body.slice(0, 140) + '…' : q.body}`)
  for (const m of (snap.dead_letters ?? []).filter((m: any) => !m.bounced))
    console.log(`✖#${m.id} undelivered to ${m.to_name} (gone), from ${m.from_name ?? 'human'}: ${m.body.length > 100 ? m.body.slice(0, 100) + '…' : m.body}`)
  console.log(`(descriptions, milestones, ideas, threads: orchestra snapshot --full)`)
})

program.command('idea <text>').description('add a roadmap idea (first line = title)')
  .option('--desc <d>', 'longer scope for the idea')
  .action(async (text, o) => {
    await up(); const b = await board()
    const i = await api('POST', '/ideas', { board_id: b.id, text: o.desc ? `${text}\n${o.desc}` : text })
    console.log(`idea #${i.id} added to the roadmap`)
  })
program.command('idea-done <id>').description('remove a roadmap idea (after converting it to a ticket)')
  .action(async (id) => {
    await up()
    await api('DELETE', `/ideas/${id}`)
    console.log(`idea #${id} removed from the roadmap`)
  })
program.command('ideas').description('list roadmap ideas').action(async () => {
  await up(); const b = await board()
  const snap = await api('GET', `/boards/${b.id}/snapshot`)
  for (const i of snap.ideas ?? []) console.log(`#${i.id} ${i.text.split('\n')[0]}`)
})

program.command('shipped <cardId> <hash>').description('record the merge commit that shipped a card')
  .option('--from <a>').action(async (cardId, hash, o) => {
    await up()
    const r = await api('POST', `/cards/${cardId}/shipped`, { hash, by: o.from ?? envAgent() })
    const p = JSON.parse(r.event.payload)
    console.log(`card #${cardId} shipped @ ${p.hash} "${p.subject}"${r.created ? '' : ' (already recorded)'}`)
  })

program.command('note [text]').description('post a note to the board (visible to everyone as a thread)')
  .option('--from <a>')
  .option('--stdin', 'read the body from stdin (no shell interpolation)')
  .action(async (text, o) => {
    const body = await messageBody(text, o.stdin)
    await up(); const b = await board()
    const m = await api('POST', '/messages', { board_id: b.id, from: await inferAgent(b.id, o.from), kind: 'announce', body })
    console.log(`note posted (msg #${m.id})`)
  })

program.command('announce [text]').description('post a board-only announcement; wakes no agents')
  .option('--from <a>')
  .option('--stdin', 'read the body from stdin (no shell interpolation)')
  .action(async (text, o) => {
    const body = await messageBody(text, o.stdin)
    await up(); const b = await board()
    const m = await api('POST', '/messages', { board_id: b.id, from: await inferAgent(b.id, o.from), kind: 'announce', body })
    console.log(`announcement posted without waking agents (msg #${m.id})`)
  })

program.command('swarm [body]').description('ask every currently-live agent; requires explicit fan-out confirmation')
  .option('--from <a>')
  .option('--card <id>')
  .option('--confirm', 'confirm waking every snapshotted recipient')
  .option('--stdin', 'read the body from stdin (no shell interpolation)')
  .action(async (body, o) => {
    const text = await messageBody(body, o.stdin)
    await up(); const b = await board()
    const m = await api('POST', '/messages', {
      board_id: b.id, from: await inferAgent(b.id, o.from), kind: 'swarm', confirm: o.confirm === true,
      body: text, card_id: o.card ? Number(o.card) : undefined,
    })
    console.log(`swarm sent to ${m.recipient_count} agent${m.recipient_count === 1 ? '' : 's'} (msg #${m.id})`)
  })

program.command('milestone <title>').description('create a milestone (a major goal made of ordered steps)')
  .option('--desc <d>').action(async (title, o) => {
    await up(); const b = await board()
    const m = await api('POST', '/milestones', { board_id: b.id, title, description: o.desc })
    console.log(`milestone #${m.id} "${m.title}" created — add steps with: orchestra step ${m.id} "<title>" --desc "<prompt>"`)
  })
program.command('step <milestoneId> <title>').description('append an ordered step to a milestone')
  .option('--desc <d>').action(async (milestoneId, title, o) => {
    await up()
    const r = await api('POST', `/milestones/${milestoneId}/steps`, { title, description: o.desc })
    console.log(`step #${r.card.id} added (order ${r.card.step_order})`)
  })

program.command('hire').description('spawn an ambient autonomous agent (not attached to a card contract)')
  .option('--name <name>')
  .option('--provider <provider>', 'agent provider (claude|codex); omitted uses the board default', providerOption(false))
  .option('--model <m>')
  .option('--effort <level>')
  .option('--access-profile <profile>', 'read_only|workspace_write|full_access')
  .option('--cwd <dir>')
  .action(async (o) => {
    await up(); const b = await board()
    if (o.accessProfile && !['read_only', 'workspace_write', 'full_access'].includes(o.accessProfile))
      throw new Error('--access-profile must be read_only, workspace_write, or full_access')
    const a = await api('POST', `/boards/${b.id}/hire`, {
      name: o.name,
      provider: o.provider,
      model: o.model,
      effort: o.effort,
      access_profile: o.accessProfile,
      cwd: o.cwd,
    })
    console.log(`hired ${a.mode ?? 'ambient'} agent ${a.name} with ${a.provider ?? o.provider ?? 'the board default'} (agent #${a.id}) — not contract-attached; give it work: orchestra task ${a.name} "<task>"`)
  })
program.command('task <name> <text>').description('give an agent work while preserving its ambient/legacy/canonical identity')
  .action(async (name, text) => {
    await up(); const b = await board()
    const snap = await api('GET', `/boards/${b.id}/snapshot`)
    const a = snap.agents.find((x: any) => x.name === name)
    if (!a) { console.error(`no agent named ${name}`); process.exit(1) }
    const result = await api('POST', `/agents/${a.id}/task`, { text })
    console.log(`tasked ${name} (${result.mode ?? 'ambient'} lifecycle)`)
  })
program.command('wake').description('resume every usage-limit-paused agent now instead of waiting for the window reset')
  .option('--board <id>')
  .action(async (o) => {
    await up()
    const b = o.board ? { id: Number(o.board) } : await board()
    const r = await api('POST', `/boards/${b.id}/wake`)
    console.log(`woke ${r.woke.length}${r.woke.length ? ` (${r.woke.join(', ')})` : ''} · queued ${r.queued.length}${r.queued.length ? ` (${r.queued.join(', ')})` : ''}${r.skipped.length ? ` · skipped ${r.skipped.length} already live/ineligible` : ''}`)
  })
program.command('fire <name>').description('stop a hired agent (its cards are removed)')
  .action(async (name) => {
    await up(); const b = await board()
    const snap = await api('GET', `/boards/${b.id}/snapshot`)
    const a = snap.agents.find((x: any) => x.name === name)
    if (!a) { console.error(`no agent named ${name}`); process.exit(1) }
    await api('POST', `/agents/${a.id}/fire`)
    console.log(`fired ${name}`)
  })

program.command('notify [to] [body]').description('queue an agent notification, or manage phone notifications when no agent is given')
  .option('--card <id>')
  .option('--from <a>')
  .option('--stdin', 'read the body from stdin (no shell interpolation)')
  .option('--ntfy <topic>', 'also push via https://ntfy.sh/<topic> (for phones without the PWA)')
  .option('--off', 'disable the ntfy fallback')
  .option('--test', 'send a test notification to every subscribed device')
  .action(async (to, body, o) => {
    if (to) {
      if (o.ntfy || o.off || o.test) throw new Error('agent notification flags cannot be combined with phone notification flags')
      const text = await messageBody(body, o.stdin)
      await up(); const b = await board()
      const m = await api('POST', '/messages', {
        board_id: b.id, from: await inferAgent(b.id, o.from), to, kind: 'notify', body: text,
        card_id: o.card ? Number(o.card) : undefined,
      })
      console.log(`notification queued for ${to}; no reply requested (msg #${m.id})`)
      return
    }
    await up()
    if (o.ntfy) console.log(`ntfy fallback set: https://ntfy.sh/${(await api('POST', '/push/ntfy', { topic: o.ntfy })).ntfy_topic}`)
    if (o.off) { await api('POST', '/push/ntfy', { topic: null }); console.log('ntfy fallback disabled') }
    if (o.test) { await api('POST', '/push/test'); console.log('test notification sent') }
    const s = await api('GET', '/push/status')
    console.log(`devices subscribed: ${s.subscriptions} · ntfy: ${s.ntfy_topic ? `https://ntfy.sh/${s.ntfy_topic}` : 'off'} · links point to ${s.public_base}`)
  })

program.command('hook <event>')
  .option('--provider <provider>', 'hook provider (claude|codex)', providerOption(false))
  .action(async (event, o) => { await runHook(event, o.provider) })
program.command('install')
  .option('--project', 'install into the current project instead of the user config')
  .option('--provider <provider>', 'hooks to install (claude|codex|both)', providerOption(true), 'claude')
  .action((o) => installHooks(o.project ? 'project' : 'global', { provider: o.provider }))
program.command('uninstall')
  .option('--project', 'remove hooks from the current project instead of the user config')
  .option('--provider <provider>', 'hooks to remove (claude|codex|both)', providerOption(true), 'claude')
  .action((o) => uninstallHooks(o.project ? 'project' : 'global', { provider: o.provider }))

registerAgentOsCommands(program, { api, ensureReady: up, resolveBoard: board })
registerDoctorCommand(program)

program.parseAsync().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
