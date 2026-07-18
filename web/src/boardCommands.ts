// orchestra-native slash commands — executed client-side against the daemon API,
// never posted to /agents/:id/task, so they cost zero agent tokens (#44)

export type MenuItem = { name: string; description: string; source: string }

// injected into #40's autocomplete menu via its extraItems prop
export const BOARD_COMMANDS: MenuItem[] = [
  { name: '/board', description: 'show the board — cards by column', source: 'orchestra' },
  { name: '/card', description: '/card <title> creates · /card move <id> <column> moves', source: 'orchestra' },
  { name: '/ask', description: '/ask <agent> <question> — board message, answered on their next turn', source: 'orchestra' },
  { name: '/handoff', description: "/handoff <agent> — assign this agent's ticket to another agent", source: 'orchestra' },
  { name: '/interrupt', description: 'stop this agent’s current turn', source: 'orchestra' },
  { name: '/resume', description: '/resume [name] — revive a stopped agent from its stored session', source: 'orchestra' },
]

export type BoardCmdCtx = {
  boardId: number
  agent: { id: number; name: string }
  cards: { id: number; title: string; column: string; owner: string | null }[]
  api: (method: string, p: string, body?: unknown) => Promise<any>
}

const VERBS = new Set(BOARD_COMMANDS.map((c) => c.name))

// only lines starting with one of our verbs are claimed; /compact etc. fall through to the SDK
export function isBoardCommand(line: string): boolean {
  return VERBS.has(line.trim().split(/\s+/)[0])
}

const COLUMN_ORDER = ['in_progress', 'review', 'blocked', 'backlog', 'done']

export async function runBoardCommand(line: string, ctx: BoardCmdCtx): Promise<string[]> {
  const [verb, ...rest] = line.trim().split(/\s+/)
  const arg = (n: number) => rest.slice(n).join(' ')
  try {
    switch (verb) {
      case '/board': {
        const snap = await ctx.api('GET', `/boards/${ctx.boardId}/snapshot`)
        const cards: any[] = snap.cards ?? []
        if (!cards.length) return ['board is empty']
        const out: string[] = []
        for (const col of COLUMN_ORDER) {
          const inCol = cards.filter((c) => c.column === col)
          if (!inCol.length) continue
          if (col === 'done') { out.push(`done: ${inCol.length} card${inCol.length === 1 ? '' : 's'}`); continue }
          out.push(`${col}:`)
          for (const c of inCol) out.push(`  #${c.id} ${c.title}${c.owner ? ` (${c.owner})` : ''}`)
        }
        return out
      }
      case '/card': {
        if (rest[0] === 'move') {
          const id = Number(rest[1])
          const column = rest[2]
          if (!id || !column) return ['usage: /card move <id> <column>']
          const r = await ctx.api('PATCH', `/cards/${id}`, { column })
          return [`card #${r.card.id} → ${r.card.column}`]
        }
        const title = arg(0)
        if (!title) return ['usage: /card <title> · /card move <id> <column>']
        const r = await ctx.api('POST', '/cards', { board_id: ctx.boardId, title })
        const out = [`card #${r.card.id} created [${r.card.column}] ${r.card.title}`]
        for (const o of r.overlaps ?? []) out.push(`⚠ overlap with #${o.id} "${o.title}"${o.owner ? ` (${o.owner})` : ''}`)
        for (const s of r.similar ?? []) out.push(`≈ similar to #${s.id} "${s.title}"${s.owner ? ` (${s.owner})` : ''}`)
        for (const d of r.done_similar ?? []) out.push(`✓ already shipped? #${d.id} "${d.title}" is done`)
        return out
      }
      case '/ask': {
        const to = rest[0]
        const body = arg(1)
        if (!to || !body) return ['usage: /ask <agent> <question>']
        const m = await ctx.api('POST', '/messages', { board_id: ctx.boardId, to, body })
        return [`asked ${to} (msg #${m.id})${m.delivered_at ? ' · delivered' : ' · delivered on their next turn'}`]
      }
      case '/handoff': {
        const to = rest[0]
        if (!to) return ['usage: /handoff <agent>']
        const mine = ctx.cards.filter((c) => c.owner === ctx.agent.name && c.column !== 'done')
        const card = mine.find((c) => c.column === 'in_progress') ?? mine[0]
        if (!card) return [`✗ ${ctx.agent.name} owns no open card to hand off`]
        await ctx.api('POST', `/cards/${card.id}/assign`, { agent: to })
        return [`card #${card.id} "${card.title}" handed to ${to}`]
      }
      case '/interrupt': {
        await ctx.api('POST', `/agents/${ctx.agent.id}/interrupt`)
        return ['interrupt sent']
      }
      case '/resume': {
        const name = rest[0] || ctx.agent.name
        const snap = await ctx.api('GET', `/boards/${ctx.boardId}/snapshot`)
        const row = (snap.agents ?? []).find((a: any) => a.name === name)
        if (!row) return [`✗ no agent named ${name} on this board`]
        if (!row.sdk_session) return [`✗ ${name} has no stored session to resume`]
        await ctx.api('POST', `/boards/${ctx.boardId}/hire`, {
          name,
          resumeSession: row.sdk_session,
          // resumed agents keep their persisted permission mode (#45 contract)
          ...(row.permission_mode ? { permissionMode: row.permission_mode } : {}),
        })
        return [`resumed ${name} — previous session continues${row.permission_mode ? ` · ${row.permission_mode}` : ''}`]
      }
      default:
        return [`✗ unknown board command ${verb}`]
    }
  } catch (e: any) {
    // daemon errors arrive as JSON bodies (e.g. #47's 409 gone-recipient) — show the text, not the wrapper
    const raw = String(e?.message ?? e)
    let msg = raw
    try { msg = JSON.parse(raw)?.error ?? raw } catch { /* not a json body */ }
    return [`✗ ${msg.slice(0, 200)}`]
  }
}
