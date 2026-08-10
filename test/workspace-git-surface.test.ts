import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const servers: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  },
})

let root: string
let repo: string
let topicWorktree: string

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-git-surface-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'seed-commit-message')
  git(repo, 'branch', 'feature/topic')
  topicWorktree = path.join(root, 'wt-topic')
  git(repo, 'worktree', 'add', topicWorktree, 'feature/topic')
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const fixture = async (rootPath: string, remote = false) => {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES (?, 'git surface')`).run(rootPath).lastInsertRowid)
  db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
    VALUES ('workspace-1', ?, 'terminal', 'shared', ?, 'active')`).run(boardId, rootPath)
  const server = buildServer(db, undefined, {
    agentOs: {
      resolveTerminalAccessContext: () => remote
        ? {
            authenticated: true,
            principal: 'remote_device' as const,
            surface: 'unknown' as const,
            scopes: [],
          }
        : {
            authenticated: true,
            principal: 'local_operator' as const,
            surface: 'desktop' as const,
            scopes: [],
          },
    },
  })
  servers.push(server)
  await server.ready()
  return server
}

describe('workspace git surface (#179)', () => {
  it('lists worktrees and branches with names and short heads only', async () => {
    const server = await fixture(repo)
    const response = await server.inject({ method: 'GET', url: '/api/v1/os/workspaces/workspace-1/git' })
    expect(response.statusCode).toBe(200)
    const surface = response.json().git

    expect(surface.is_repository).toBe(true)
    expect(surface.current_branch).toBe('main')
    expect(surface.worktrees.map((worktree: { branch: string }) => worktree.branch).sort())
      .toEqual(['feature/topic', 'main'])
    const current = surface.worktrees.find((worktree: { is_current: boolean }) => worktree.is_current)
    expect(current.branch).toBe('main')
    expect(current.head).toMatch(/^[0-9a-f]{7}$/)

    const names = surface.branches.map((branch: { name: string }) => branch.name)
    expect(names).toContain('main')
    expect(names).toContain('feature/topic')
    const topic = surface.branches.find((branch: { name: string }) => branch.name === 'feature/topic')
    expect(topic.is_current).toBe(false)
    expect(String(topic.worktree_path).endsWith('wt-topic')).toBe(true)
    expect(topic.head).toMatch(/^[0-9a-f]{7}$/)

    // project content stays out: no commit messages, diffs, or file names
    expect(response.body).not.toContain('seed-commit-message')
    expect(response.body).not.toContain('a.txt')
  })

  it('answers is_repository false for a workspace outside any git repository', async () => {
    const bare = path.join(root, 'plain')
    fs.mkdirSync(bare, { recursive: true })
    const server = await fixture(bare)
    const response = await server.inject({ method: 'GET', url: '/api/v1/os/workspaces/workspace-1/git' })
    expect(response.statusCode).toBe(200)
    expect(response.json().git).toMatchObject({
      is_repository: false, current_branch: null, worktrees: [], branches: [],
    })
  })

  // the rail is gated exactly like terminal view: any authenticated principal may
  // read it (remote view already streams full terminal output, a broader surface),
  // and unauthenticated contexts are refused outright
  it('tracks the terminal view gate for remote and unauthenticated contexts', async () => {
    const remote = await fixture(repo, true)
    const allowed = await remote.inject({ method: 'GET', url: '/api/v1/os/workspaces/workspace-1/git' })
    expect(allowed.statusCode).toBe(200)

    const db = openDb(':memory:')
    const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES (?, 'git surface')`).run(repo).lastInsertRowid)
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
      VALUES ('workspace-1', ?, 'terminal', 'shared', ?, 'active')`).run(boardId, repo)
    const server = buildServer(db, undefined, {
      agentOs: {
        resolveTerminalAccessContext: () => ({
          authenticated: false,
          principal: 'unknown' as const,
          surface: 'unknown' as const,
          scopes: [],
        }),
      },
    })
    servers.push(server)
    await server.ready()
    const denied = await server.inject({ method: 'GET', url: '/api/v1/os/workspaces/workspace-1/git' })
    expect(denied.statusCode).toBe(403)
  })

  it('404s for an unknown workspace', async () => {
    const server = await fixture(repo)
    const response = await server.inject({ method: 'GET', url: '/api/v1/os/workspaces/missing/git' })
    expect(response.statusCode).toBe(404)
  })
})
