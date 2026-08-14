import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  assertDeployable, DeployRefused, deployStatus, describeDeployStatus, isLinkedWorktree, repoRoot,
} from '../src/deploy.js'

const temps: string[] = []
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

const scratchRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-deploy-'))
  temps.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'test')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'web/src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(root, 'web/src/a.tsx'), 'export const a = 1\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  return root
}

const buildArtifacts = (root: string, at: number) => {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.mkdirSync(path.join(root, 'web/dist'), { recursive: true })
  for (const file of ['dist/cli.js', 'web/dist/index.html']) {
    const full = path.join(root, file)
    fs.writeFileSync(full, 'built')
    fs.utimesSync(full, at / 1000, at / 1000)
  }
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

it('calls a build stale until every artifact is newer than the newest source', () => {
  const root = scratchRepo()
  expect(deployStatus(root).stale).toBe(true) // nothing built yet

  buildArtifacts(root, Date.now() + 1000)
  const fresh = deployStatus(root)
  expect(fresh.stale).toBe(false)
  expect(fresh.artifacts.map((a) => a.label)).toEqual(['server', 'web'])

  // a source edit after the build puts it behind again
  const edited = path.join(root, 'web/src/a.tsx')
  fs.writeFileSync(edited, 'export const a = 2\n')
  fs.utimesSync(edited, (Date.now() + 5000) / 1000, (Date.now() + 5000) / 1000)
  const stale = deployStatus(root)
  expect(stale.stale).toBe(true)
  expect(stale.artifacts.find((a) => a.label === 'web')?.stale).toBe(true)
  expect(describeDeployStatus(stale)).toContain('older than the source')
})

it('refuses to deploy from a linked worktree, and allows the shared checkout', () => {
  const root = scratchRepo()
  const linked = path.join(root, '..', `${path.basename(root)}-wt`)
  temps.push(linked)
  git(root, 'worktree', 'add', '-q', '-b', 'feature', linked)

  expect(isLinkedWorktree(root)).toBe(false)
  expect(isLinkedWorktree(linked)).toBe(true)

  expect(() => assertDeployable(deployStatus(root))).not.toThrow()
  try {
    assertDeployable(deployStatus(linked))
    throw new Error('expected the worktree deploy to be refused')
  } catch (error) {
    expect(error).toBeInstanceOf(DeployRefused)
    // the message has to say why, or the next agent just works around it
    expect((error as Error).message).toContain("agent's in-flight work")
    expect((error as Error).message).toContain('shared checkout')
  }
})

it('ignores node_modules and dotted directories when dating the source', () => {
  const root = scratchRepo()
  buildArtifacts(root, Date.now())
  const buried = path.join(root, 'src/node_modules/dep')
  fs.mkdirSync(buried, { recursive: true })
  const dep = path.join(buried, 'index.ts')
  fs.writeFileSync(dep, 'export const dep = 1\n')
  fs.utimesSync(dep, (Date.now() + 60_000) / 1000, (Date.now() + 60_000) / 1000)

  expect(deployStatus(root).stale).toBe(false)
})

it('resolves this repository as its own root', () => {
  expect(fs.existsSync(path.join(repoRoot(), 'package.json'))).toBe(true)
})
