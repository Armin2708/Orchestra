import fs from 'node:fs'
import path from 'node:path'

// Provider-agnostic agent memory: a plain-text file store under a caller-supplied root
// (the CLI passes `path.join(dataDir(), 'memory')`). Nothing here touches the daemon, the
// database, or a provider SDK, so both the Claude and Codex session-start hooks can read it.
//
// Layout per board:
//   board-<id>/today-YYYY-MM-DD.md   entries appended during that day
//   board-<id>/recent.md             the last 7 days, newest section first
//   board-<id>/archive.md            everything older, appended oldest first
//   board-<id>/handoff.md            the one-shot note for the next session
//   board-<id>/last-handoff.md       the handoff that was already delivered

const RECENT_DAYS = 7
const DEFAULT_MAX_CHARS = 4000
const TODAY_FILE = /^today-(\d{4}-\d{2}-\d{2})\.md$/
const SECTION_HEADER = /^# (\d{4}-\d{2}-\d{2})$/

type Section = { stamp: string; body: string }

const boardDir = (root: string, boardId: number) => path.join(root, `board-${boardId}`)
// UTC everywhere: a board is read by agents and hooks in whatever timezone they happen to
// run in, so the day a note lands in must not depend on the writer's clock offset.
const dayStamp = (d: Date) => d.toISOString().slice(0, 10)
const timeStamp = (d: Date) => d.toISOString().slice(11, 16)
const todayPath = (dir: string, stamp: string) => path.join(dir, `today-${stamp}.md`)

const readIfExists = (file: string): string => {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

const listDay = (dir: string): { stamp: string; file: string }[] => {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names
    .map(name => ({ match: TODAY_FILE.exec(name), name }))
    .filter((entry): entry is { match: RegExpExecArray; name: string } => entry.match !== null)
    .map(entry => ({ stamp: entry.match[1], file: path.join(dir, entry.name) }))
    .sort((a, b) => a.stamp.localeCompare(b.stamp))
}

const parseSections = (text: string): Section[] => {
  const sections: Section[] = []
  let current: Section | undefined
  for (const line of text.split('\n')) {
    const header = SECTION_HEADER.exec(line)
    if (header) {
      current = { stamp: header[1], body: '' }
      sections.push(current)
      continue
    }
    if (current) current.body += `${line}\n`
  }
  return sections.filter(section => section.body.trim() !== '')
}

const renderSections = (sections: Section[]): string =>
  sections.map(section => `# ${section.stamp}\n${section.body.trim()}\n`).join('\n')

/**
 * Fold every day file that is not `today` into recent.md (newest section first), then push
 * anything past the 7-day window on into archive.md. Runs on append so a board that goes
 * quiet for a month still rotates correctly the moment it wakes up.
 */
function rotate(dir: string, today: string, now: Date): void {
  const stale = listDay(dir).filter(day => day.stamp !== today)
  const recentPath = path.join(dir, 'recent.md')
  const hadRecent = fs.existsSync(recentPath)
  if (stale.length === 0 && !hadRecent) return

  const sections = [...parseSections(readIfExists(recentPath))]
  for (const day of stale) {
    sections.push({ stamp: day.stamp, body: readIfExists(day.file) })
    fs.rmSync(day.file, { force: true })
  }
  sections.sort((a, b) => b.stamp.localeCompare(a.stamp))

  const cutoff = dayStamp(new Date(now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000))
  const kept = sections.filter(section => section.stamp >= cutoff)
  const expired = sections.filter(section => section.stamp < cutoff).reverse()
  if (expired.length > 0) fs.appendFileSync(path.join(dir, 'archive.md'), renderSections(expired))
  fs.writeFileSync(recentPath, renderSections(kept))
}

/** Append one stamped entry to today's file for a board, rotating older days out first. */
export function appendMemory(root: string, boardId: number, agent: string, text: string, now: Date = new Date()): void {
  const dir = boardDir(root, boardId)
  fs.mkdirSync(dir, { recursive: true })
  const today = dayStamp(now)
  rotate(dir, today, now)
  fs.appendFileSync(todayPath(dir, today), `## ${timeStamp(now)} | ${agent}\n${text.trim()}\n`)
}

/**
 * Render the board's memory for injection into a session, oldest first so that trimming to
 * `maxChars` drops the least useful lines. Returns '' when the board has never remembered
 * anything — callers concatenate the result and must not emit an empty header.
 */
export function readMemoryInjection(root: string, boardId: number, maxChars: number = DEFAULT_MAX_CHARS): string {
  const dir = boardDir(root, boardId)
  // Read every day file, not just the current UTC day: a session opened after midnight
  // should still see the entries written minutes earlier, before the next append rotates.
  const days = listDay(dir).map(day => readIfExists(day.file))
  const recent = parseSections(readIfExists(path.join(dir, 'recent.md')))
    .sort((a, b) => a.stamp.localeCompare(b.stamp))
  const body = [renderSections(recent), ...days].filter(part => part.trim() !== '').join('\n').trim()
  if (body === '') return ''

  const header = `=== MEMORY ===\nhistory: ${dir}${path.sep} (today, recent 7d, archive)`
  const lines = body.split('\n')
  while (lines.length > 1 && header.length + 1 + lines.join('\n').length > maxChars) lines.shift()
  return `${header}\n${lines.join('\n')}`
}

/** Overwrite the board's one-shot handoff note. The next session start consumes it. */
export function writeHandoff(root: string, boardId: number, agent: string, text: string): void {
  const dir = boardDir(root, boardId)
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString()
  fs.writeFileSync(path.join(dir, 'handoff.md'), `# Handoff (${agent}, ${stamp})\n\n${text.trim()}\n`)
}

/** Read and retire the handoff note, so it is delivered exactly once. Null when there is none. */
export function consumeHandoff(root: string, boardId: number): string | null {
  const dir = boardDir(root, boardId)
  const pending = path.join(dir, 'handoff.md')
  if (!fs.existsSync(pending)) return null
  const content = readIfExists(pending)
  fs.rmSync(path.join(dir, 'last-handoff.md'), { force: true })
  fs.renameSync(pending, path.join(dir, 'last-handoff.md'))
  return content
}
