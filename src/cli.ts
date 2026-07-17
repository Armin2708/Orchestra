import { Command } from 'commander'
import { ensureDaemon, serve, stopDaemon, baseUrl } from './daemon.js'
import { api, projectPath } from './client.js'
import { VERSION } from './version.js'
import { runHook } from './hooks.js'
import { installHooks, uninstallHooks } from './install.js'

const program = new Command().name('agentboard').version(VERSION)
const csv = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean)
const envAgent = () => process.env.AGENTBOARD_AGENT

async function up() { if (!(await ensureDaemon())) { console.error('daemon unreachable'); process.exit(1) } }
async function board() { return api('POST', '/boards/resolve', { project_path: projectPath() }) }

program.command('serve').description('run daemon in foreground').action(async () => {
  await serve(); console.log(`agentboard on ${baseUrl()}`)
})
program.command('stop').action(() => { console.log(stopDaemon() ? 'stopped' : 'not running') })

program.command('join').option('--name <name>').option('--session <id>').action(async (o) => {
  await up()
  const b = await board()
  const a = await api('POST', '/agents/register', { board_id: b.id, name: o.name ?? process.env.AGENTBOARD_NAME, session_id: o.session })
  console.log(`AGENT_ID=${a.id} AGENT_NAME=${a.name} BOARD_ID=${b.id}`)
  const snap = await api('GET', `/boards/${b.id}/snapshot`)
  for (const ag of snap.agents.filter((x: any) => x.status !== 'gone' && x.id !== a.id))
    console.log(`agent ${ag.name} (${ag.status})`)
  for (const c of snap.cards.filter((c: any) => c.column !== 'done'))
    console.log(`card #${c.id} [${c.column}] ${c.title} — ${c.owner ?? 'unowned'} — paths: ${c.paths.join(', ') || '-'}`)
})

const card = program.command('card')
const printOverlaps = (overlaps: any[]) => {
  for (const o of overlaps) console.log(`⚠ overlap with card #${o.id} "${o.title}" (${o.owner}) on ${o.paths.join(', ')}`)
}
card.command('create <title>').option('--desc <d>').option('--paths <p>', '', csv)
  .option('--column <c>').option('--agent <a>').action(async (title, o) => {
    await up(); const b = await board()
    const r = await api('POST', '/cards', { board_id: b.id, title, description: o.desc, paths: o.paths, column: o.column, agent: o.agent ?? envAgent() })
    console.log(`card #${r.card.id} created [${r.card.column}]`); printOverlaps(r.overlaps)
  })
card.command('update <id>').option('--title <t>').option('--desc <d>').option('--paths <p>', '', csv)
  .option('--column <c>').option('--agent <a>').action(async (id, o) => {
    await up()
    const r = await api('PATCH', `/cards/${id}`, { title: o.title, description: o.desc, paths: o.paths, column: o.column, agent: o.agent ?? envAgent() })
    console.log(`card #${r.card.id} updated [${r.card.column}]`); printOverlaps(r.overlaps)
  })
card.command('move <id> <column>').option('--agent <a>').action(async (id, column, o) => {
  await up()
  const r = await api('POST', `/cards/${id}/move`, { column, agent: o.agent ?? envAgent() })
  console.log(`card #${r.card.id} → ${r.card.column}`)
})

program.command('ask <to> <body>').option('--card <id>').option('--from <a>').action(async (to, body, o) => {
  await up(); const b = await board()
  const m = await api('POST', '/messages', { board_id: b.id, from: o.from ?? envAgent(), to, body, card_id: o.card ? Number(o.card) : undefined })
  console.log(`asked ${to} (msg #${m.id})`)
})
program.command('reply <msgId> <body>').option('--from <a>').action(async (msgId, body, o) => {
  await up(); const b = await board()
  const m = await api('POST', '/messages', { board_id: b.id, from: o.from ?? envAgent(), body, reply_to: Number(msgId) })
  console.log(`replied (msg #${m.id})`)
})

program.command('pulse').option('--agent-id <id>').action(async (o) => {
  await up()
  const id = o.agentId ?? process.env.AGENTBOARD_AGENT_ID
  if (!id) return
  const r = await api('POST', `/agents/${id}/pulse`)
  for (const m of r.messages) console.log(`[${m.from_name ?? 'human'}] ${m.body} (msg #${m.id})`)
})

program.command('snapshot').option('--board <id>').action(async (o) => {
  await up()
  const b = o.board ? { id: Number(o.board) } : await board()
  const snap = await api('GET', `/boards/${b.id}/snapshot`)
  console.log(JSON.stringify(snap, null, 2))
})

program.command('hook <event>').action(async (event) => { await runHook(event) })
program.command('install').option('--project', 'install into ./.claude instead of ~/.claude')
  .action((o) => installHooks(o.project ? 'project' : 'global'))
program.command('uninstall').option('--project').action((o) => uninstallHooks(o.project ? 'project' : 'global'))

program.parseAsync().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
