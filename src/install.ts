import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MARKER = 'orchestra hook'
const HOOKS: Record<string, any> = {
  SessionStart: { hooks: [{ type: 'command', command: `${MARKER} session-start` }] },
  PostToolUse: { matcher: '*', hooks: [{ type: 'command', command: `${MARKER} post-tool-use` }] },
  Stop: { hooks: [{ type: 'command', command: `${MARKER} stop` }] },
  SessionEnd: { hooks: [{ type: 'command', command: `${MARKER} session-end` }] },
}

function defaultPath(scope: 'global' | 'project'): string {
  return scope === 'global'
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(process.cwd(), '.claude', 'settings.json')
}
const hasMarker = (entry: any) =>
  JSON.stringify(entry?.hooks ?? []).includes(MARKER)

export function installHooks(scope: 'global' | 'project', settingsPath = defaultPath(scope)): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  const s = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {}
  s.hooks ??= {}
  for (const [event, entry] of Object.entries(HOOKS)) {
    s.hooks[event] ??= []
    if (!s.hooks[event].some(hasMarker)) s.hooks[event].push(entry)
  }
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
  console.log(`orchestra hooks installed in ${settingsPath}`)
}

export function uninstallHooks(scope: 'global' | 'project', settingsPath = defaultPath(scope)): void {
  if (!fs.existsSync(settingsPath)) return
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  for (const event of Object.keys(s.hooks ?? {})) {
    s.hooks[event] = s.hooks[event].filter((e: any) => !hasMarker(e))
    if (s.hooks[event].length === 0) delete s.hooks[event]
  }
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
  console.log(`orchestra hooks removed from ${settingsPath}`)
}
