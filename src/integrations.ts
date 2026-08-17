import fs from 'node:fs'
import path from 'node:path'

/** A knowledge integration orchestra detects in a project — never bundles. */
export type IntegrationStatus = {
  id: 'graphify' | 'obsidian' | 'gitnexus'
  present: boolean
  detail: string
  enable_hint: string
}

const isFile = (target: string): boolean => {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

const isDirectory = (target: string): boolean => {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

const readIfFile = (target: string): string | null => {
  if (!isFile(target)) return null
  try {
    return fs.readFileSync(target, 'utf8')
  } catch {
    return null
  }
}

function detectGraphify(projectRoot: string): IntegrationStatus {
  const present = isFile(path.join(projectRoot, 'graphify-out', 'graph.json'))
  return {
    id: 'graphify',
    present,
    detail: present ? 'knowledge graph at graphify-out/graph.json' : 'no graphify-out/graph.json in this project',
    enable_hint: 'build a knowledge graph for this project: see the graphify docs',
  }
}

// The vault itself lives outside the repo, so the project's own CLAUDE.md naming one is
// the only signal that stays inside the project root.
function detectObsidian(projectRoot: string): IntegrationStatus {
  const claudeMd = readIfFile(path.join(projectRoot, 'CLAUDE.md'))
  const present = claudeMd !== null && /vault/i.test(claudeMd)
  const detail = present
    ? 'CLAUDE.md documents an Obsidian vault for this project'
    : claudeMd === null
      ? 'no CLAUDE.md at the project root'
      : 'CLAUDE.md does not mention a vault'
  return {
    id: 'obsidian',
    present,
    detail,
    enable_hint: 'document your vault in CLAUDE.md so sessions know where to read and record notes',
  }
}

function detectGitnexus(projectRoot: string): IntegrationStatus {
  const present = isDirectory(path.join(projectRoot, '.gitnexus'))
  return {
    id: 'gitnexus',
    present,
    detail: present ? 'code index at .gitnexus/' : 'no .gitnexus/ directory in this project',
    enable_hint: 'index the repo: npx gitnexus analyze',
  }
}

/**
 * Report which knowledge integrations a project has. Always returns all three in a
 * stable order (graphify, obsidian, gitnexus) so callers can render a fixed list, and
 * never throws — an unreadable or missing project root simply reads as "not detected".
 */
export function detectIntegrations(projectRoot: string): IntegrationStatus[] {
  return [detectGraphify(projectRoot), detectObsidian(projectRoot), detectGitnexus(projectRoot)]
}
