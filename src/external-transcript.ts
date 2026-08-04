import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Read-side tailer for agents running in their own terminal (hooks-only sessions).
// The daemon never launched them, so their conversation lives only in the provider's
// local transcript JSONL. Hooks report that path on every pulse/heartbeat; this
// service lazily tails the file on transcript reads and projects entries into the
// same line shape the Conductor produces for hired agents, so AgentTerminal renders
// both with one code path.

export type ExternalTranscriptLine = {
  at: string
  kind: 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result' | 'thinking'
  text: string
}

const MAX_LINES = 500
// a session file can be huge; on first sight only read the tail so the UI opens fast
const FIRST_READ_TAIL_BYTES = 2 * 1024 * 1024

function toolSummary(name: string, input: any): string {
  const arg = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.query
  const s = typeof arg === 'string' ? arg : JSON.stringify(input ?? {})
  return `${name}(${s.length > 90 ? s.slice(0, 90) + '…' : s})`
}

function resultSummary(content: unknown): string {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('\n') : ''
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return '(no output)'
  const first = lines[0].length > 110 ? lines[0].slice(0, 110) + '…' : lines[0]
  return lines.length > 1 ? `${first}  … +${lines.length - 1} lines` : first
}

// Claude Code transcript entries carry hook/system noise the terminal never shows:
// command echoes, injected reminders, attachment stubs. Keep only real conversation.
function userText(content: unknown): string | null {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('\n') : ''
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('<command-name>') || trimmed.startsWith('<local-command')
    || trimmed.startsWith('<system-reminder>') || trimmed.startsWith('Caveat:')) return null
  return trimmed
}

export function parseTranscriptEntry(entry: unknown): ExternalTranscriptLine[] {
  if (!entry || typeof entry !== 'object') return []
  const e = entry as Record<string, any>
  // subagent (Task tool) sidechains interleave in the same file — the parent's
  // tool_use/tool_result lines already summarize them
  if (e.isSidechain === true || e.isMeta === true) return []
  const at = typeof e.timestamp === 'string' ? e.timestamp : new Date().toISOString()
  const message = e.message
  if (e.type === 'assistant' && message && typeof message === 'object') {
    const blocks = Array.isArray(message.content) ? message.content : []
    const out: ExternalTranscriptLine[] = []
    for (const b of blocks) {
      if (b?.type === 'text' && b.text) out.push({ at, kind: 'text', text: b.text })
      else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim())
        out.push({ at, kind: 'thinking', text: b.thinking })
      else if (b?.type === 'tool_use') out.push({ at, kind: 'tool', text: toolSummary(b.name, b.input) })
    }
    return out
  }
  if (e.type === 'user' && message && typeof message === 'object') {
    const out: ExternalTranscriptLine[] = []
    if (Array.isArray(message.content)) {
      for (const b of message.content) {
        if (b?.type === 'tool_result') out.push({ at, kind: 'tool_result', text: resultSummary(b.content) })
      }
    }
    const text = userText(message.content)
    if (text) out.push({ at, kind: 'user', text })
    return out
  }
  return []
}

// hook-supplied paths are authenticated but still external input — only ever read
// .jsonl files that truly live under the invoking user's home directory
export function validTranscriptPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p) || !p.endsWith('.jsonl')) return null
  let real: string
  try { real = fs.realpathSync(p) } catch { return null }
  const home = fs.realpathSync(os.homedir())
  if (real !== home && !real.startsWith(home + path.sep)) return null
  return real
}

type Tail = {
  path: string
  offset: number
  carry: string
  head: string // first bytes at last read — a changed head means the file was rewritten
  lines: ExternalTranscriptLine[]
}

const HEAD_BYTES = 64

export class ExternalTranscriptService {
  private tails = new Map<number, Tail>()

  track(agentId: number, transcriptPath: unknown): void {
    const real = validTranscriptPath(transcriptPath)
    if (!real) return
    const existing = this.tails.get(agentId)
    // session restarts and /resume switch files — start the new one from its tail
    if (!existing || existing.path !== real) {
      this.tails.set(agentId, { path: real, offset: -1, carry: '', head: '', lines: [] })
    }
  }

  transcript(agentId: number): { lines: ExternalTranscriptLine[] } {
    const tail = this.tails.get(agentId)
    if (!tail) return { lines: [] }
    this.read(tail)
    return { lines: tail.lines }
  }

  private read(tail: Tail): void {
    let stat: fs.Stats
    try { stat = fs.statSync(tail.path) } catch { return }
    let fd: number
    try { fd = fs.openSync(tail.path, 'r') } catch { return }
    try {
      const headBuf = Buffer.alloc(Math.min(HEAD_BYTES, stat.size))
      fs.readSync(fd, headBuf, 0, headBuf.length, 0)
      const head = headBuf.toString('base64')
      if (tail.offset === -1) {
        // first sight: skip deep history so the console opens fast
        tail.offset = Math.max(0, stat.size - FIRST_READ_TAIL_BYTES)
      } else if (stat.size < tail.offset || head !== tail.head) {
        tail.offset = 0; tail.carry = ''; tail.lines = [] // truncated or rewritten
      }
      tail.head = head
      if (stat.size <= tail.offset) return
      const buf = Buffer.alloc(stat.size - tail.offset)
      const read = fs.readSync(fd, buf, 0, buf.length, tail.offset)
      tail.offset += read
      const chunk = tail.carry + buf.toString('utf8', 0, read)
      const rows = chunk.split('\n')
      tail.carry = rows.pop() ?? ''
      for (const row of rows) {
        if (!row.trim()) continue
        let entry: unknown
        try { entry = JSON.parse(row) } catch { continue } // first partial line after a tail-seek
        tail.lines.push(...parseTranscriptEntry(entry))
      }
      if (tail.lines.length > MAX_LINES) tail.lines.splice(0, tail.lines.length - MAX_LINES)
    } finally {
      fs.closeSync(fd)
    }
  }
}
