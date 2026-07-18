import { Command } from 'commander'
import { ensureDaemon, serve, stopDaemon, baseUrl } from './daemon.js'
import { api, projectPath } from './client.js'
import { VERSION } from './version.js'
import { runHook } from './hooks.js'
import { installHooks, uninstallHooks } from './install.js'

const program = new Command().name('orchestra').version(VERSION)
const csv = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean)
const envAgent = () => process.env.ORCHESTRA_AGENT

async function up() { if (!(await ensureDaemon())) { console.error('daemon unreachable'); process.exit(1) } }
async function board() { return api('POST', '/boards/resolve', { project_path: projectPath() }) }
// explicit flag > env > sole active agent on the board
async function inferAgent(boardId: number, explicit?: string): Promise<string | undefined> {
  if (explicit ?? envAgent()) return explicit ?? envAgent()
  const snap = await api('GET', `/boards/${boardId}/snapshot`)
  const live = snap.agents.filter((a: any) => a.status !== 'gone')
  return live.length === 1 ? live[0].name : undefined
}

program.command('serve').description('run daemon in foreground').action(async () => {
  await serve(); console.log(`orchestra on ${baseUrl()}`)
})
program.command('stop').action(() => { console.log(stopDaemon() ? 'stopped' : 'not running') })

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
const printOverlaps = (overlaps: any[], similar: any[] = []) => {
  for (const o of overlaps) console.log(`⚠ overlap with card #${o.id} "${o.title}" (${o.owner}) on ${o.paths.join(', ')}`)
  for (const s of similar) console.log(`≈ similar work in progress: card #${s.id} "${s.title}" (${s.owner}) — check with them before proceeding: orchestra ask ${s.owner} "..."`)
}
card.command('create <title>').option('--desc <d>').option('--paths <p>', '', csv)
  .option('--column <c>').option('--agent <a>').action(async (title, o) => {
    await up(); const b = await board()
    const r = await api('POST', '/cards', { board_id: b.id, title, description: o.desc, paths: o.paths, column: o.column, agent: await inferAgent(b.id, o.agent) })
    console.log(`card #${r.card.id} created [${r.card.column}]`); printOverlaps(r.overlaps, r.similar)
  })
card.command('update <id>').option('--title <t>').option('--desc <d>').option('--paths <p>', '', csv)
  .option('--column <c>').option('--agent <a>').action(async (id, o) => {
    await up()
    const r = await api('PATCH', `/cards/${id}`, { title: o.title, description: o.desc, paths: o.paths, column: o.column, agent: o.agent ?? envAgent() })
    console.log(`card #${r.card.id} updated [${r.card.column}]`); printOverlaps(r.overlaps, r.similar)
  })
card.command('move <id> <column>').option('--agent <a>').action(async (id, column, o) => {
  await up()
  const r = await api('POST', `/cards/${id}/move`, { column, agent: o.agent ?? envAgent() })
  console.log(`card #${r.card.id} → ${r.card.column}`)
})

program.command('ask <to> <body>').option('--card <id>').option('--from <a>').action(async (to, body, o) => {
  await up(); const b = await board()
  const m = await api('POST', '/messages', { board_id: b.id, from: await inferAgent(b.id, o.from), to, body, card_id: o.card ? Number(o.card) : undefined })
  console.log(`asked ${to} (msg #${m.id})`)
})
program.command('reply <msgId> <body>').option('--from <a>').action(async (msgId, body, o) => {
  await up(); const b = await board()
  const m = await api('POST', '/messages', { board_id: b.id, from: await inferAgent(b.id, o.from), body, reply_to: Number(msgId) })
  console.log(`replied (msg #${m.id})`)
})

program.command('pulse').option('--agent-id <id>').action(async (o) => {
  await up()
  const id = o.agentId ?? process.env.ORCHESTRA_AGENT_ID
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

program.command('hire').description('spawn an autonomous agent on this project (runs inside the daemon)')
  .option('--name <name>').option('--model <m>').option('--cwd <dir>')
  .action(async (o) => {
    await up(); const b = await board()
    const a = await api('POST', `/boards/${b.id}/hire`, { name: o.name, model: o.model, cwd: o.cwd })
    console.log(`hired ${a.name} (agent #${a.id}) — give it work: orchestra task ${a.name} "<task>"`)
  })
program.command('task <name> <text>').description('give a hired agent a task')
  .action(async (name, text) => {
    await up(); const b = await board()
    const snap = await api('GET', `/boards/${b.id}/snapshot`)
    const a = snap.agents.find((x: any) => x.name === name)
    if (!a) { console.error(`no agent named ${name}`); process.exit(1) }
    await api('POST', `/agents/${a.id}/task`, { text })
    console.log(`tasked ${name}`)
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

program.command('hook <event>').action(async (event) => { await runHook(event) })
program.command('install').option('--project', 'install into ./.claude instead of ~/.claude')
  .action((o) => installHooks(o.project ? 'project' : 'global'))
program.command('uninstall').option('--project').action((o) => uninstallHooks(o.project ? 'project' : 'global'))

program.parseAsync().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
