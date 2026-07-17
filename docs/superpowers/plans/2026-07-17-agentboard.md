# agentboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `agentboard` — a local daemon + CLI + Claude Code hooks + web kanban that lets multiple Claude Code agents coordinate work per project — publishable to npm and the plugin marketplace.

**Architecture:** Single Fastify daemon on `localhost:4750` with SQLite (`~/.agentboard/agentboard.db`), consumed by a thin CLI (used by agents and hooks), Claude Code hooks implemented as `agentboard hook <event>` subcommands, and a React web UI served statically by the daemon with SSE live updates.

**Tech Stack:** Node ≥20, TypeScript (ESM, strict), Fastify, better-sqlite3, commander, picomatch, Vitest; web: React + Vite. Build with tsup.

## Global Constraints

- Node `>=20`, `"type": "module"`, TS `strict: true`.
- Default port `4750`; overridable via `AGENTBOARD_PORT`. Data dir `~/.agentboard/`; overridable via `AGENTBOARD_HOME` (tests use temp dirs).
- Columns are exactly: `backlog`, `in_progress`, `blocked`, `review`, `done`.
- Agent statuses: `active`, `idle`, `gone`. Idle after 5 min without heartbeat, gone after 30 min or SessionEnd.
- Hook subcommands MUST always exit 0 and never hang: every `hook` command wraps everything in try/catch and a 2000 ms overall timeout.
- API base path `/api/v1`. `GET /health` → `{ ok: true, version }`.
- Overlap warnings are advisory only — never block a write.
- License MIT. Package name `agentboard`, bin name `agentboard`.
- Commit after every task with the message given in that task.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/version.ts`, `test/version.test.ts`

**Interfaces:**
- Produces: `VERSION` (string) exported from `src/version.ts`; `npm test` runs Vitest; `npm run build` runs tsup (used from Task 10 on).

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "agentboard",
  "version": "0.1.0",
  "description": "Live kanban coordination board for Claude Code agents",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "agentboard": "./dist/cli.js" },
  "files": ["dist", "web/dist", "README.md"],
  "scripts": {
    "build": "tsup src/cli.ts --format esm --clean --banner.js '#!/usr/bin/env node' && node scripts/fix-bin.mjs",
    "test": "vitest run",
    "dev": "tsx src/cli.ts serve"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "skipLibCheck": true, "resolveJsonModule": true,
    "outDir": "dist", "types": ["node"]
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
```

`.gitignore`:
```
node_modules/
dist/
web/dist/
web/node_modules/
*.db
```

`src/version.ts`:
```ts
export const VERSION = '0.1.0'
```

- [ ] **Step 2: Install deps**

Run:
```bash
npm i fastify better-sqlite3 commander picomatch
npm i -D typescript tsup tsx vitest @types/node @types/better-sqlite3 @types/picomatch
```

- [ ] **Step 3: Write smoke test** — `test/version.test.ts`:
```ts
import { expect, it } from 'vitest'
import { VERSION } from '../src/version.js'
it('exports a semver version', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
})
```

- [ ] **Step 4: Run** `npm test` — Expected: 1 passed.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "chore: scaffold TypeScript package"`

---

### Task 2: Database layer

**Files:**
- Create: `src/db.ts`, `test/db.test.ts`

**Interfaces:**
- Produces: `openDb(file: string): Database.Database` — opens SQLite with WAL and runs idempotent migrations. Tables: `boards`, `agents`, `cards`, `card_events`, `messages` (columns below are the source of truth for all later tasks).

- [ ] **Step 1: Write failing test** — `test/db.test.ts`:
```ts
import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'

it('creates schema and enforces board uniqueness', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES (?, ?)`).run('/p/x', 'x')
  expect(() =>
    db.prepare(`INSERT INTO boards (project_path, name) VALUES (?, ?)`).run('/p/x', 'x2')
  ).toThrow()
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
    .map((r: any) => r.name)
  for (const t of ['boards', 'agents', 'cards', 'card_events', 'messages'])
    expect(tables).toContain(t)
})
```

- [ ] **Step 2: Run** `npx vitest run test/db.test.ts` — Expected: FAIL (cannot find `../src/db.js`).

- [ ] **Step 3: Implement** — `src/db.ts`:
```ts
import Database from 'better-sqlite3'

export function openDb(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY,
    project_path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    name TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(board_id, name)
  );
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    column_name TEXT NOT NULL DEFAULT 'backlog',
    owner_agent_id INTEGER REFERENCES agents(id),
    paths TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS card_events (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES cards(id),
    agent_id INTEGER,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    from_agent_id INTEGER,
    to_agent_id INTEGER,
    card_id INTEGER,
    body TEXT NOT NULL,
    reply_to INTEGER,
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `)
  return db
}
```

- [ ] **Step 4: Run** `npx vitest run test/db.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sqlite schema and openDb"`

---

### Task 3: Name generator + path-overlap utilities

**Files:**
- Create: `src/names.ts`, `src/overlap.ts`, `test/names.test.ts`, `test/overlap.test.ts`

**Interfaces:**
- Produces: `generateName(rand?: () => number): string` (`adjective-animal`); `pathsIntersect(a: string[], b: string[]): boolean` (glob-aware, advisory).

- [ ] **Step 1: Write failing tests**

`test/names.test.ts`:
```ts
import { expect, it } from 'vitest'
import { generateName } from '../src/names.js'
it('generates adjective-animal names', () => {
  expect(generateName(() => 0)).toMatch(/^[a-z]+-[a-z]+$/)
  expect(generateName(() => 0)).not.toBe(generateName(() => 0.99))
})
```

`test/overlap.test.ts`:
```ts
import { expect, it } from 'vitest'
import { pathsIntersect } from '../src/overlap.js'
it('detects prefix containment', () => {
  expect(pathsIntersect(['src/auth'], ['src/auth/login.ts'])).toBe(true)
})
it('detects glob intersection both directions', () => {
  expect(pathsIntersect(['src/auth/**'], ['src/auth/login.ts'])).toBe(true)
  expect(pathsIntersect(['src/auth/login.ts'], ['src/auth/**'])).toBe(true)
})
it('treats glob base dirs as prefixes', () => {
  expect(pathsIntersect(['src/auth/**'], ['src/auth'])).toBe(true)
})
it('rejects disjoint paths', () => {
  expect(pathsIntersect(['src/auth/**'], ['docs/readme.md'])).toBe(false)
  expect(pathsIntersect([], ['src/a.ts'])).toBe(false)
})
```

- [ ] **Step 2: Run** `npx vitest run test/names.test.ts test/overlap.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/names.ts`:
```ts
const ADJ = ['crimson','amber','cobalt','jade','ivory','onyx','coral','silver','violet','golden','scarlet','teal','copper','indigo','pearl','slate']
const ANIMAL = ['otter','falcon','lynx','heron','badger','fox','raven','ibex','tern','marten','osprey','stoat','puffin','wolf','crane','newt']

export function generateName(rand: () => number = Math.random): string {
  const pick = (arr: string[]) => arr[Math.floor(rand() * arr.length)]
  return `${pick(ADJ)}-${pick(ANIMAL)}`
}
```

`src/overlap.ts`:
```ts
import picomatch from 'picomatch'

function base(p: string): string {
  const i = p.search(/[*?[{]/)
  return (i === -1 ? p : p.slice(0, i)).replace(/\/+$/, '')
}

function pairIntersects(a: string, b: string): boolean {
  if (picomatch.isMatch(b, a, { dot: true }) || picomatch.isMatch(a, b, { dot: true })) return true
  const ba = base(a), bb = base(b)
  if (ba === '' || bb === '') return true // catch-all like '**'
  return ba === bb || ba.startsWith(bb + '/') || bb.startsWith(ba + '/')
}

export function pathsIntersect(a: string[], b: string[]): boolean {
  return a.some((pa) => b.some((pb) => pairIntersects(pa, pb)))
}
```

- [ ] **Step 4: Run** same test command — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: name generator and path overlap detection"`

---

### Task 4: API server — boards, agents, snapshot

**Files:**
- Create: `src/server.ts`, `test/server-agents.test.ts`

**Interfaces:**
- Consumes: `openDb`, `generateName`, `VERSION`.
- Produces: `buildServer(db: Database.Database): FastifyInstance` with an attached event bus `server.bus: EventEmitter` (emits `('event', { board_id: number, type: string, data: unknown })` on every write — Tasks 5–7 must emit on it; Task 8 streams it). Routes this task:
  - `GET /health` → `{ ok: true, version }`
  - `POST /api/v1/boards/resolve` `{ project_path }` → board row (create-on-first-use, `name` = basename)
  - `GET /api/v1/boards` → `Board[]`
  - `POST /api/v1/agents/register` `{ board_id, session_id?, name? }` → agent row (auto-name; re-registering an existing name refreshes status/session)
  - `GET /api/v1/boards/:id/snapshot` → `{ board, agents, cards, open_questions }` (cards/questions empty until Tasks 5–6)

- [ ] **Step 1: Write failing test** — `test/server-agents.test.ts`:
```ts
import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

async function boot() {
  const server = buildServer(openDb(':memory:'))
  await server.ready()
  return server
}

it('resolves boards idempotently and registers agents', async () => {
  const s = await boot()
  const b1 = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/tmp/proj' } })).json()
  const b2 = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/tmp/proj' } })).json()
  expect(b1.id).toBe(b2.id)
  expect(b1.name).toBe('proj')

  const a = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b1.id, session_id: 's1' } })).json()
  expect(a.name).toMatch(/^[a-z]+-[a-z]+$/)
  expect(a.status).toBe('active')

  const snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b1.id}/snapshot` })).json()
  expect(snap.agents).toHaveLength(1)
  expect(snap.cards).toEqual([])
  const health = (await s.inject({ method: 'GET', url: '/health' })).json()
  expect(health.ok).toBe(true)
})
```

- [ ] **Step 2: Run** `npx vitest run test/server-agents.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** — `src/server.ts`:
```ts
import Fastify, { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { generateName } from './names.js'
import { VERSION } from './version.js'

export type Bus = EventEmitter
declare module 'fastify' {
  interface FastifyInstance { db: Database.Database; bus: Bus }
}

export function buildServer(db: Database.Database): FastifyInstance {
  const server = Fastify()
  server.decorate('db', db)
  server.decorate('bus', new EventEmitter())
  const emit = (board_id: number, type: string, data: unknown) =>
    server.bus.emit('event', { board_id, type, data })

  server.get('/health', () => ({ ok: true, version: VERSION }))

  server.post<{ Body: { project_path: string } }>('/api/v1/boards/resolve', (req) => {
    const p = req.body.project_path
    db.prepare(`INSERT OR IGNORE INTO boards (project_path, name) VALUES (?, ?)`)
      .run(p, path.basename(p))
    return db.prepare(`SELECT * FROM boards WHERE project_path = ?`).get(p)
  })

  server.get('/api/v1/boards', () => db.prepare(`SELECT * FROM boards ORDER BY id`).all())

  server.post<{ Body: { board_id: number; session_id?: string; name?: string } }>(
    '/api/v1/agents/register', (req) => {
      const { board_id, session_id } = req.body
      let name = req.body.name
      if (!name) {
        do { name = generateName() } while (
          db.prepare(`SELECT 1 FROM agents WHERE board_id=? AND name=?`).get(board_id, name))
      }
      db.prepare(`
        INSERT INTO agents (board_id, name, session_id) VALUES (?, ?, ?)
        ON CONFLICT(board_id, name) DO UPDATE SET
          session_id=excluded.session_id, status='active', last_seen=datetime('now')
      `).run(board_id, name, session_id ?? null)
      const agent = db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(board_id, name)
      emit(board_id, 'agent', agent)
      return agent
    })

  server.get<{ Params: { id: string } }>('/api/v1/boards/:id/snapshot', (req) => {
    const id = Number(req.params.id)
    return {
      board: db.prepare(`SELECT * FROM boards WHERE id=?`).get(id),
      agents: db.prepare(`SELECT * FROM agents WHERE board_id=? ORDER BY name`).all(id),
      cards: listCards(db, id),
      open_questions: db.prepare(`
        SELECT m.*, fa.name AS from_name, ta.name AS to_name FROM messages m
        LEFT JOIN agents fa ON fa.id = m.from_agent_id
        LEFT JOIN agents ta ON ta.id = m.to_agent_id
        WHERE m.board_id=? AND m.reply_to IS NULL
          AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id)
        ORDER BY m.id`).all(id),
    }
  })

  return server
}

export function listCards(db: Database.Database, boardId: number) {
  return (db.prepare(`
    SELECT c.*, a.name AS owner FROM cards c
    LEFT JOIN agents a ON a.id = c.owner_agent_id
    WHERE c.board_id=? ORDER BY c.updated_at DESC`).all(boardId) as any[])
    .map((c) => ({ ...c, column: c.column_name, paths: JSON.parse(c.paths) }))
}
```

- [ ] **Step 4: Run** `npx vitest run test/server-agents.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: server with boards, agents, snapshot"`

---

### Task 5: Cards API with overlap warnings

**Files:**
- Modify: `src/server.ts` (add routes before `return server`)
- Create: `test/server-cards.test.ts`

**Interfaces:**
- Consumes: `pathsIntersect`, `listCards`, `emit`, agents/boards from Task 4.
- Produces:
  - `POST /api/v1/cards` `{ board_id, title, description?, paths?, agent? }` → `{ card, overlaps: Card[] }` (`agent` = agent name → owner; card starts in `backlog` unless `column` given)
  - `PATCH /api/v1/cards/:id` `{ title?, description?, paths?, column?, agent? }` → `{ card, overlaps }`
  - `POST /api/v1/cards/:id/move` `{ column, agent? }` → `{ card }` (400 on invalid column)
  - Every write inserts a `card_events` row (`created`/`updated`/`moved`) and emits `card` on the bus. `overlaps` = other cards on the board, not `done`, different owner, with intersecting paths.

- [ ] **Step 1: Write failing test** — `test/server-cards.test.ts`:
```ts
import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('creates cards, warns on overlap, moves columns', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a1 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  const a2 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })).json()

  const r1 = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Auth refactor', paths: ['src/auth/**'], agent: 'amber-fox', column: 'in_progress' } })).json()
  expect(r1.card.column).toBe('in_progress')
  expect(r1.overlaps).toEqual([])

  const r2 = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Login page', paths: ['src/auth/login.ts'], agent: 'jade-lynx' } })).json()
  expect(r2.overlaps.map((c: any) => c.id)).toContain(r1.card.id)

  const mv = (await s.inject({ method: 'POST', url: `/api/v1/cards/${r1.card.id}/move`, payload: { column: 'review', agent: 'amber-fox' } })).json()
  expect(mv.card.column).toBe('review')
  const bad = await s.inject({ method: 'POST', url: `/api/v1/cards/${r1.card.id}/move`, payload: { column: 'nope' } })
  expect(bad.statusCode).toBe(400)
})
```

- [ ] **Step 2: Run** `npx vitest run test/server-cards.test.ts` — Expected: FAIL (404s).

- [ ] **Step 3: Implement** — add inside `buildServer` (uses `pathsIntersect` — add `import { pathsIntersect } from './overlap.js'` at top):
```ts
  const COLUMNS = ['backlog', 'in_progress', 'blocked', 'review', 'done']
  const agentByName = (board_id: number, name?: string) =>
    name ? (db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(board_id, name) as any) : undefined
  const getCard = (id: number) => {
    const c = db.prepare(`SELECT c.*, a.name AS owner FROM cards c LEFT JOIN agents a ON a.id=c.owner_agent_id WHERE c.id=?`).get(id) as any
    return c && { ...c, column: c.column_name, paths: JSON.parse(c.paths) }
  }
  const overlapsFor = (card: any) =>
    listCards(db, card.board_id).filter((o) =>
      o.id !== card.id && o.column !== 'done' && o.owner !== card.owner &&
      pathsIntersect(card.paths, o.paths))
  const logEvent = (card_id: number, agent_id: number | null, type: string, payload: unknown = {}) =>
    db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, ?, ?, ?)`)
      .run(card_id, agent_id, type, JSON.stringify(payload))

  server.post<{ Body: { board_id: number; title: string; description?: string; paths?: string[]; agent?: string; column?: string } }>(
    '/api/v1/cards', (req, reply) => {
      const { board_id, title, description = '', paths = [], agent, column = 'backlog' } = req.body
      if (!COLUMNS.includes(column)) return reply.code(400).send({ error: 'invalid column' })
      const owner = agentByName(board_id, agent)
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO cards (board_id, title, description, column_name, owner_agent_id, paths)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(board_id, title, description, column, owner?.id ?? null, JSON.stringify(paths))
      const card = getCard(Number(lastInsertRowid))
      logEvent(card.id, owner?.id ?? null, 'created', { title })
      emit(board_id, 'card', card)
      return { card, overlaps: overlapsFor(card) }
    })

  server.patch<{ Params: { id: string }; Body: { title?: string; description?: string; paths?: string[]; column?: string; agent?: string } }>(
    '/api/v1/cards/:id', (req, reply) => {
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      const { title, description, paths, column, agent } = req.body
      if (column && !COLUMNS.includes(column)) return reply.code(400).send({ error: 'invalid column' })
      db.prepare(`
        UPDATE cards SET title=coalesce(?, title), description=coalesce(?, description),
          paths=coalesce(?, paths), column_name=coalesce(?, column_name), updated_at=datetime('now')
        WHERE id=?`)
        .run(title ?? null, description ?? null, paths ? JSON.stringify(paths) : null, column ?? null, card.id)
      const updated = getCard(card.id)
      const actor = agentByName(card.board_id, agent)
      logEvent(card.id, actor?.id ?? null, 'updated', req.body)
      emit(card.board_id, 'card', updated)
      return { card: updated, overlaps: overlapsFor(updated) }
    })

  server.post<{ Params: { id: string }; Body: { column: string; agent?: string } }>(
    '/api/v1/cards/:id/move', (req, reply) => {
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      if (!COLUMNS.includes(req.body.column)) return reply.code(400).send({ error: 'invalid column' })
      db.prepare(`UPDATE cards SET column_name=?, updated_at=datetime('now') WHERE id=?`)
        .run(req.body.column, card.id)
      const updated = getCard(card.id)
      const actor = agentByName(card.board_id, req.body.agent)
      logEvent(card.id, actor?.id ?? null, 'moved', { to: req.body.column })
      emit(card.board_id, 'card', updated)
      return { card: updated }
    })

  server.get<{ Params: { id: string } }>('/api/v1/cards/:id/events', (req) =>
    db.prepare(`SELECT e.*, a.name AS agent FROM card_events e LEFT JOIN agents a ON a.id=e.agent_id WHERE card_id=? ORDER BY e.id`)
      .all(Number(req.params.id)))
```

- [ ] **Step 4: Run** `npx vitest run test/server-cards.test.ts` — Expected: PASS. Then `npm test` — all pass.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: cards API with overlap warnings and activity log"`

---

### Task 6: Messages API (ask / reply / pulse)

**Files:**
- Modify: `src/server.ts`
- Create: `test/server-messages.test.ts`

**Interfaces:**
- Consumes: agents/boards helpers from Tasks 4–5.
- Produces:
  - `POST /api/v1/messages` `{ board_id, from?, to?, card_id?, body, reply_to? }` (`from`/`to` are agent names; both nullable = human/broadcast) → message row. Emits `message` on bus.
  - `GET /api/v1/agents/:id/inbox` → all messages addressed to agent (plus replies to their messages), newest last.
  - `POST /api/v1/agents/:id/pulse` → `{ agent, messages }`: heartbeats (status→active, last_seen=now) and atomically returns-and-marks-delivered undelivered messages addressed to the agent **or replies to messages the agent sent** and broadcasts (`to_agent_id IS NULL AND from_agent_id != agent`).

- [ ] **Step 1: Write failing test** — `test/server-messages.test.ts`:
```ts
import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('ask, pulse-deliver, reply round-trip', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a1 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  const a2 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })).json()

  const q = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', to: 'jade-lynx', body: 'changing auth middleware?' } })).json()

  const p1 = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a2.id}/pulse` })).json()
  expect(p1.messages).toHaveLength(1)
  expect(p1.messages[0].body).toBe('changing auth middleware?')
  const p1b = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a2.id}/pulse` })).json()
  expect(p1b.messages).toHaveLength(0) // delivered once

  await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'jade-lynx', to: 'amber-fox', body: 'yes, hold off', reply_to: q.id } })
  const p2 = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a1.id}/pulse` })).json()
  expect(p2.messages[0].reply_to).toBe(q.id)
})
```

- [ ] **Step 2: Run** `npx vitest run test/server-messages.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** — add inside `buildServer`:
```ts
  server.post<{ Body: { board_id: number; from?: string; to?: string; card_id?: number; body: string; reply_to?: number } }>(
    '/api/v1/messages', (req) => {
      const { board_id, from, to, card_id, body, reply_to } = req.body
      const fromA = agentByName(board_id, from), toA = agentByName(board_id, to)
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO messages (board_id, from_agent_id, to_agent_id, card_id, body, reply_to)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(board_id, fromA?.id ?? null, toA?.id ?? null, card_id ?? null, body, reply_to ?? null)
      const msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(lastInsertRowid))
      emit(board_id, 'message', msg)
      return msg
    })

  const inboxSql = `
    SELECT m.*, fa.name AS from_name FROM messages m
    LEFT JOIN agents fa ON fa.id = m.from_agent_id
    WHERE m.board_id = ? AND (m.from_agent_id IS NULL OR m.from_agent_id != ?)
      AND (m.to_agent_id = ?
           OR m.reply_to IN (SELECT id FROM messages WHERE from_agent_id = ?)
           OR m.to_agent_id IS NULL)`

  server.get<{ Params: { id: string } }>('/api/v1/agents/:id/inbox', (req) => {
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(Number(req.params.id)) as any
    return db.prepare(inboxSql + ' ORDER BY m.id').all(a.board_id, a.id, a.id, a.id)
  })

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/pulse', (req) => {
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(Number(req.params.id)) as any
    db.prepare(`UPDATE agents SET status='active', last_seen=datetime('now') WHERE id=?`).run(a.id)
    const messages = db.prepare(inboxSql + ` AND m.delivered_at IS NULL ORDER BY m.id`)
      .all(a.board_id, a.id, a.id, a.id) as any[]
    const mark = db.prepare(`UPDATE messages SET delivered_at=datetime('now') WHERE id=?`)
    db.transaction(() => messages.forEach((m) => mark.run(m.id)))()
    emit(a.board_id, 'agent', db.prepare(`SELECT * FROM agents WHERE id=?`).get(a.id))
    return { agent: a, messages }
  })
```

- [ ] **Step 4: Run** `npx vitest run test/server-messages.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: messages API with pulse delivery"`

---

### Task 7: Reaper (idle/gone transitions)

**Files:**
- Create: `src/reaper.ts`, `test/reaper.test.ts`
- Modify: `src/server.ts` (add `POST /api/v1/agents/:id/leave`)

**Interfaces:**
- Produces: `reap(db): void` — sets `status='idle'` where active and `last_seen` older than 5 min; `status='gone'` where older than 30 min. `POST /api/v1/agents/:id/leave` → sets `gone` immediately (SessionEnd hook uses it). Daemon (Task 8) calls `reap` every 60 s.

- [ ] **Step 1: Write failing test** — `test/reaper.test.ts`:
```ts
import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { reap } from '../src/reaper.js'

it('marks stale agents idle then gone', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p','p')`).run()
  const ins = db.prepare(`INSERT INTO agents (board_id, name, last_seen) VALUES (1, ?, datetime('now', ?))`)
  ins.run('fresh-otter', '-1 minutes')
  ins.run('idle-otter', '-10 minutes')
  ins.run('gone-otter', '-40 minutes')
  reap(db)
  const status = (n: string) => (db.prepare(`SELECT status FROM agents WHERE name=?`).get(n) as any).status
  expect(status('fresh-otter')).toBe('active')
  expect(status('idle-otter')).toBe('idle')
  expect(status('gone-otter')).toBe('gone')
})
```

- [ ] **Step 2: Run** `npx vitest run test/reaper.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/reaper.ts`:
```ts
import type Database from 'better-sqlite3'

export function reap(db: Database.Database): void {
  db.prepare(`UPDATE agents SET status='gone'
    WHERE status != 'gone' AND last_seen < datetime('now', '-30 minutes')`).run()
  db.prepare(`UPDATE agents SET status='idle'
    WHERE status = 'active' AND last_seen < datetime('now', '-5 minutes')`).run()
}
```

Add to `buildServer` in `src/server.ts`:
```ts
  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/leave', (req) => {
    db.prepare(`UPDATE agents SET status='gone' WHERE id=?`).run(Number(req.params.id))
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(Number(req.params.id)) as any
    emit(a.board_id, 'agent', a)
    return a
  })
```

- [ ] **Step 4: Run** `npx vitest run test/reaper.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: agent reaper and leave endpoint"`

---

### Task 8: SSE stream + daemon lifecycle

**Files:**
- Create: `src/daemon.ts`, `test/daemon.test.ts`
- Modify: `src/server.ts` (SSE route + static UI serving)

**Interfaces:**
- Consumes: `buildServer`, `reap`, `VERSION`.
- Produces:
  - `GET /api/v1/boards/:id/events` — SSE (`text/event-stream`), one `data: <json>\n\n` per bus event for that board, `: ping` comment every 25 s.
  - `src/daemon.ts`: `dataDir(): string` (AGENTBOARD_HOME or `~/.agentboard`, mkdir -p), `port(): number` (AGENTBOARD_PORT or 4750), `serve(): Promise<void>` (opens db at `dataDir()/agentboard.db`, listens on `127.0.0.1:port()`, writes `dataDir()/daemon.pid`, `setInterval(reap, 60_000)`), `ensureDaemon(): Promise<boolean>` (GET /health, 300 ms timeout; if down, `spawn(process.execPath, [cliPath, 'serve'], { detached: true, stdio: 'ignore' }).unref()` and poll health up to 3 s), `stopDaemon(): boolean` (SIGTERM pid from pidfile).

- [ ] **Step 1: Write failing test** — `test/daemon.test.ts` (tests `dataDir`/`port` env handling + SSE route headers; `ensureDaemon` spawn path is covered by Task 12 E2E):
```ts
import { expect, it } from 'vitest'
import { dataDir, port } from '../src/daemon.js'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('resolves data dir and port from env', () => {
  process.env.AGENTBOARD_HOME = '/tmp/abtest'
  process.env.AGENTBOARD_PORT = '5999'
  expect(dataDir()).toBe('/tmp/abtest')
  expect(port()).toBe(5999)
  delete process.env.AGENTBOARD_HOME; delete process.env.AGENTBOARD_PORT
})

it('serves SSE with correct content type', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })
  const res = await s.inject({ method: 'GET', url: '/api/v1/boards/1/events',
    payloadAsStream: true })
  expect(res.headers['content-type']).toContain('text/event-stream')
})
```

- [ ] **Step 2: Run** `npx vitest run test/daemon.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Add SSE + static to `src/server.ts` inside `buildServer` (imports: `import fs from 'node:fs'`, `import { fileURLToPath } from 'node:url'`):
```ts
  server.get<{ Params: { id: string } }>('/api/v1/boards/:id/events', (req, reply) => {
    const boardId = Number(req.params.id)
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache', connection: 'keep-alive',
    })
    const onEvent = (e: { board_id: number; type: string; data: unknown }) => {
      if (e.board_id === boardId) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
    }
    server.bus.on('event', onEvent)
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    req.raw.on('close', () => { server.bus.off('event', onEvent); clearInterval(ping) })
  })

  // static web UI (built by Task 13; 404s harmlessly before that)
  const webDist = fileURLToPath(new URL('../web/dist', import.meta.url))
  if (fs.existsSync(webDist)) {
    server.register(import('@fastify/static'), { root: webDist })
  }
```
Run: `npm i @fastify/static`

`src/daemon.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'
import { buildServer } from './server.js'
import { reap } from './reaper.js'

export function dataDir(): string {
  const d = process.env.AGENTBOARD_HOME ?? path.join(os.homedir(), '.agentboard')
  fs.mkdirSync(d, { recursive: true })
  return d
}
export function port(): number { return Number(process.env.AGENTBOARD_PORT ?? 4750) }
export const baseUrl = () => `http://127.0.0.1:${port()}`

export async function serve(): Promise<void> {
  const db = openDb(path.join(dataDir(), 'agentboard.db'))
  const server = buildServer(db)
  await server.listen({ host: '127.0.0.1', port: port() })
  fs.writeFileSync(path.join(dataDir(), 'daemon.pid'), String(process.pid))
  setInterval(() => reap(db), 60_000)
}

async function healthy(timeoutMs = 300): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return (await res.json()).ok === true
  } catch { return false }
}

export async function ensureDaemon(): Promise<boolean> {
  if (await healthy()) return true
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
  spawn(process.execPath, [cli, 'serve'], { detached: true, stdio: 'ignore', env: process.env }).unref()
  for (let i = 0; i < 30; i++) {
    if (await healthy(200)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

export function stopDaemon(): boolean {
  const pidFile = path.join(dataDir(), 'daemon.pid')
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); fs.unlinkSync(pidFile); return true }
  catch { return false }
}
```

- [ ] **Step 4: Run** `npx vitest run test/daemon.test.ts` then `npm test` — Expected: all PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: SSE stream and daemon lifecycle"`

---

### Task 9: CLI

**Files:**
- Create: `src/cli.ts`, `src/client.ts`, `test/client.test.ts`

**Interfaces:**
- Consumes: `ensureDaemon`, `stopDaemon`, `serve`, `baseUrl`.
- Produces: `src/client.ts` exports `api(method: string, p: string, body?: unknown): Promise<any>` (fetch against `baseUrl()`, `/api/v1` prefix, throws on !ok) and `projectPath(): string` (`git rev-parse --show-toplevel` else cwd realpath). CLI commands (all except serve/stop call `ensureDaemon()` first):
  - `agentboard serve` / `agentboard stop`
  - `agentboard join [--name X] [--session S]` → resolve board + register; prints `AGENT_ID=<id> AGENT_NAME=<name> BOARD_ID=<id>` (parseable) then snapshot summary
  - `agentboard card create <title> [--desc D] [--paths a,b] [--column C] [--agent NAME]` → prints card id + `⚠ overlap` lines
  - `agentboard card update <id> [--desc D] [--paths a,b] [--column C] [--title T] [--agent NAME]`
  - `agentboard card move <id> <column> [--agent NAME]`
  - `agentboard ask <to-name> <body> [--card ID] [--from NAME]`
  - `agentboard reply <msg-id> <body> [--from NAME]` (looks up original to set `to` = original sender)
  - `agentboard pulse --agent-id <id>` → prints delivered messages as `[from-name] body (msg #id)` lines, empty output if none
  - `agentboard snapshot [--board ID]` → human-readable board state
  - `agentboard hook <event>`, `agentboard install|uninstall` (Tasks 10–11)
  - Agent identity defaults: `--agent`/`--from` default to `$AGENTBOARD_AGENT`; `--agent-id` defaults to `$AGENTBOARD_AGENT_ID`.

- [ ] **Step 1: Write failing test** — `test/client.test.ts` (unit-test `projectPath` fallback; command wiring is verified in Task 12 E2E):
```ts
import { expect, it } from 'vitest'
import { projectPath } from '../src/client.js'
it('falls back to cwd outside git', () => {
  const p = projectPath('/private/tmp')
  expect(p).toBe('/private/tmp')
})
```

- [ ] **Step 2: Run** `npx vitest run test/client.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/client.ts`:
```ts
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { baseUrl } from './daemon.js'

export function projectPath(cwd: string = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
  } catch { return fs.realpathSync(cwd) }
}

export async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(`${baseUrl()}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${await res.text()}`)
  return res.json()
}
```

`src/cli.ts` (complete file):
```ts
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
```

Note: `./hooks.js` and `./install.js` don't exist yet — create stub files so the CLI compiles (Tasks 10–11 replace them):
```ts
// src/hooks.ts
export async function runHook(_event: string): Promise<void> {}
```
```ts
// src/install.ts
export function installHooks(_scope: 'global' | 'project'): void {}
export function uninstallHooks(_scope: 'global' | 'project'): void {}
```

- [ ] **Step 4: Run** `npx vitest run test/client.test.ts && npx tsc --noEmit` — Expected: PASS, no type errors.

- [ ] **Step 5: Manual smoke** — Run:
```bash
AGENTBOARD_HOME=$(mktemp -d) AGENTBOARD_PORT=4799 npx tsx src/cli.ts serve &
sleep 1
AGENTBOARD_PORT=4799 npx tsx src/cli.ts join --name test-otter
AGENTBOARD_PORT=4799 npx tsx src/cli.ts card create "Try it" --paths src/a.ts --agent test-otter
AGENTBOARD_PORT=4799 npx tsx src/cli.ts stop 2>/dev/null; kill %1 2>/dev/null
```
Expected: `AGENT_ID=... AGENT_NAME=test-otter BOARD_ID=1` and `card #1 created [backlog]`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: agentboard CLI"`

---

### Task 10: Hook runner (`agentboard hook <event>`)

**Files:**
- Replace: `src/hooks.ts` (stub from Task 9)
- Create: `test/hooks.test.ts`

**Interfaces:**
- Consumes: `api`, `projectPath`, `ensureDaemon`, `dataDir`.
- Produces: `runHook(event: 'session-start' | 'post-tool-use' | 'stop' | 'session-end'): Promise<void>`. Reads Claude Code hook JSON from stdin (`{ session_id, cwd, ... }`). NEVER throws, never exits non-zero, 2000 ms internal deadline. Persists agent identity per session in `dataDir()/sessions/<session_id>.json` as `{ agent_id, agent_name, board_id }`.
  - `session-start`: ensureDaemon → resolve board (from hook `cwd`) → register (name from `AGENTBOARD_NAME` or auto) → save session file → print plain-text context to stdout: rules + snapshot summary (stdout of SessionStart hooks is added to context).
  - `post-tool-use`: throttle via mtime of `dataDir()/sessions/<session_id>.throttle` (skip if < 30 s); pulse; if messages, print JSON `{ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '...' } }` with each message formatted `📨 <from>: <body> — reply with: agentboard reply <id> "..."`.
  - `stop`: pulse only (keeps last_seen fresh at turn ends; no output).
  - `session-end`: `POST /agents/:id/leave`, delete session file.

- [ ] **Step 1: Write failing test** — `test/hooks.test.ts` (drive `runHook` against a real server on a random port with `AGENTBOARD_HOME` temp dir; feed stdin via monkey-patched `readStdin` — export it for testability):
```ts
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

let server: any, port: number, home: string
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'))
  process.env.AGENTBOARD_HOME = home
  server = buildServer(openDb(':memory:'))
  await server.listen({ host: '127.0.0.1', port: 0 })
  port = server.server.address().port
  process.env.AGENTBOARD_PORT = String(port)
})
afterAll(async () => { await server.close(); delete process.env.AGENTBOARD_HOME; delete process.env.AGENTBOARD_PORT })

it('session-start registers and prints rules; post-tool-use delivers pings', async () => {
  const hooks = await import('../src/hooks.js')
  vi.spyOn(hooks._internals, 'readStdin').mockResolvedValue(JSON.stringify({ session_id: 'sess1', cwd: '/tmp' }))
  const out: string[] = []
  vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(String(s)) })

  await hooks.runHook('session-start')
  expect(out.join('\n')).toContain('agentboard rules')
  const sess = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'sess1.json'), 'utf8'))
  expect(sess.agent_id).toBeGreaterThan(0)

  // human asks the agent a question
  await fetch(`http://127.0.0.1:${port}/api/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board_id: sess.board_id, to: sess.agent_name, body: 'status?' }),
  })
  out.length = 0
  await hooks.runHook('post-tool-use')
  const payload = JSON.parse(out.join('\n'))
  expect(payload.hookSpecificOutput.additionalContext).toContain('status?')
})

it('never throws when daemon is down', async () => {
  const hooks = await import('../src/hooks.js')
  process.env.AGENTBOARD_PORT = '1' // nothing listening
  vi.spyOn(hooks._internals, 'readStdin').mockResolvedValue('{"session_id":"sessX","cwd":"/tmp"}')
  await expect(hooks.runHook('post-tool-use')).resolves.toBeUndefined()
  process.env.AGENTBOARD_PORT = String(port)
})
```

- [ ] **Step 2: Run** `npx vitest run test/hooks.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** — `src/hooks.ts` (complete replacement):
```ts
import fs from 'node:fs'
import path from 'node:path'
import { api } from './client.js'
import { dataDir, ensureDaemon } from './daemon.js'

export const _internals = {
  readStdin(): Promise<string> {
    return new Promise((resolve) => {
      let data = ''
      const t = setTimeout(() => resolve(data), 500)
      process.stdin.on('data', (c) => (data += c))
      process.stdin.on('end', () => { clearTimeout(t); resolve(data) })
    })
  },
}

type Session = { agent_id: number; agent_name: string; board_id: number }
const sessFile = (id: string) => path.join(dataDir(), 'sessions', `${id}.json`)
const loadSession = (id: string): Session | undefined => {
  try { return JSON.parse(fs.readFileSync(sessFile(id), 'utf8')) } catch { return undefined }
}

const RULES = `agentboard rules (coordination board for this project):
- Before starting work: agentboard card create "<title>" --desc "<scope>" --paths <comma,separated,paths> --column in_progress
- Keep your card updated (agentboard card update/move) as scope or status changes.
- Check the board below; do NOT touch paths claimed by another active card without asking first.
- To ask a neighbor: agentboard ask <agent-name> "<question>". Replies arrive automatically.
- Your identity is in $AGENTBOARD_AGENT / $AGENTBOARD_AGENT_ID (also echoed here).`

async function sessionStart(input: any): Promise<void> {
  if (!(await ensureDaemon())) return
  const board = await api('POST', '/boards/resolve', { project_path: input.cwd ?? process.cwd() })
  const agent = await api('POST', '/agents/register', {
    board_id: board.id, session_id: input.session_id, name: process.env.AGENTBOARD_NAME,
  })
  fs.mkdirSync(path.join(dataDir(), 'sessions'), { recursive: true })
  fs.writeFileSync(sessFile(input.session_id),
    JSON.stringify({ agent_id: agent.id, agent_name: agent.name, board_id: board.id }))
  const snap = await api('GET', `/boards/${board.id}/snapshot`)
  const lines = [RULES, '', `You are agent "${agent.name}" (id ${agent.id}) on board "${board.name}".`]
  for (const a of snap.agents.filter((x: any) => x.id !== agent.id && x.status !== 'gone'))
    lines.push(`- agent ${a.name}: ${a.status}`)
  for (const c of snap.cards.filter((c: any) => c.column !== 'done'))
    lines.push(`- card #${c.id} [${c.column}] "${c.title}" (${c.owner ?? 'unowned'}) paths: ${c.paths.join(', ') || '-'}`)
  for (const q of snap.open_questions) lines.push(`- open question #${q.id} from ${q.from_name ?? 'human'} to ${q.to_name ?? 'all'}: ${q.body}`)
  console.log(lines.join('\n'))
}

async function postToolUse(input: any): Promise<void> {
  const sess = loadSession(input.session_id)
  if (!sess) return
  const throttle = sessFile(input.session_id) + '.throttle'
  try {
    if (Date.now() - fs.statSync(throttle).mtimeMs < 30_000) return
  } catch { /* first run */ }
  fs.mkdirSync(path.dirname(throttle), { recursive: true })
  fs.writeFileSync(throttle, '')
  const r = await api('POST', `/agents/${sess.agent_id}/pulse`)
  if (r.messages.length === 0) return
  const ctx = r.messages.map((m: any) =>
    `📨 agentboard message from ${m.from_name ?? 'human'}: ${m.body}` +
    (m.reply_to ? ` (reply to your msg #${m.reply_to})` : ` — reply with: agentboard reply ${m.id} "..."`)).join('\n')
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx } }))
}

async function stop(input: any): Promise<void> {
  const sess = loadSession(input.session_id)
  if (sess) await api('POST', `/agents/${sess.agent_id}/pulse`)
}

async function sessionEnd(input: any): Promise<void> {
  const sess = loadSession(input.session_id)
  if (!sess) return
  await api('POST', `/agents/${sess.agent_id}/leave`)
  fs.rmSync(sessFile(input.session_id), { force: true })
}

export async function runHook(event: string): Promise<void> {
  const deadline = new Promise<void>((r) => setTimeout(r, 2000))
  const work = (async () => {
    const input = JSON.parse((await _internals.readStdin()) || '{}')
    if (event === 'session-start') await sessionStart(input)
    else if (event === 'post-tool-use') await postToolUse(input)
    else if (event === 'stop') await stop(input)
    else if (event === 'session-end') await sessionEnd(input)
  })()
  try { await Promise.race([work, deadline]) } catch { /* never break a session */ }
}
```

- [ ] **Step 4: Run** `npx vitest run test/hooks.test.ts` — Expected: PASS. `npm test` — all pass.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: claude code hook runner with never-break guarantee"`

---

### Task 11: install / uninstall (settings.json merge)

**Files:**
- Replace: `src/install.ts` (stub from Task 9)
- Create: `test/install.test.ts`

**Interfaces:**
- Consumes: nothing internal.
- Produces: `installHooks(scope, settingsPath?)` / `uninstallHooks(scope, settingsPath?)` — merge/remove agentboard entries in Claude settings JSON idempotently. `settingsPath` default: `~/.claude/settings.json` (global) or `./.claude/settings.json` (project). Every installed hook command contains the marker string `agentboard hook` (uninstall filters by it). Hook config written:
```json
{
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "agentboard hook session-start" }] }],
  "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "agentboard hook post-tool-use" }] }],
  "Stop": [{ "hooks": [{ "type": "command", "command": "agentboard hook stop" }] }],
  "SessionEnd": [{ "hooks": [{ "type": "command", "command": "agentboard hook session-end" }] }]
}
```

- [ ] **Step 1: Write failing test** — `test/install.test.ts`:
```ts
import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installHooks, uninstallHooks } from '../src/install.js'

it('installs idempotently, preserves existing hooks, uninstalls cleanly', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-')), 'settings.json')
  fs.writeFileSync(f, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'afplay done.aiff' }] }] },
  }))
  installHooks('global', f)
  installHooks('global', f) // idempotent
  const s = JSON.parse(fs.readFileSync(f, 'utf8'))
  expect(s.hooks.SessionStart).toHaveLength(1)
  expect(s.hooks.Stop).toHaveLength(2) // existing + ours
  expect(JSON.stringify(s)).toContain('agentboard hook post-tool-use')

  uninstallHooks('global', f)
  const s2 = JSON.parse(fs.readFileSync(f, 'utf8'))
  expect(JSON.stringify(s2)).not.toContain('agentboard hook')
  expect(s2.hooks.Stop).toHaveLength(1) // existing preserved
})
```

- [ ] **Step 2: Run** `npx vitest run test/install.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** — `src/install.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MARKER = 'agentboard hook'
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
  console.log(`agentboard hooks installed in ${settingsPath}`)
}

export function uninstallHooks(scope: 'global' | 'project', settingsPath = defaultPath(scope)): void {
  if (!fs.existsSync(settingsPath)) return
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  for (const event of Object.keys(s.hooks ?? {})) {
    s.hooks[event] = s.hooks[event].filter((e: any) => !hasMarker(e))
    if (s.hooks[event].length === 0) delete s.hooks[event]
  }
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
  console.log(`agentboard hooks removed from ${settingsPath}`)
}
```

- [ ] **Step 4: Run** `npx vitest run test/install.test.ts` — Expected: PASS.

- [ ] **Step 5: Verify config file wasn't clobbered by another process** (per user global rule): re-read the temp settings file in the test — covered by assertions. When later testing against the real `~/.claude/settings.json`, diff before/after.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: hook install/uninstall with idempotent settings merge"`

---

### Task 12: End-to-end script (two agents, real daemon)

**Files:**
- Create: `scripts/e2e.sh`

**Interfaces:**
- Consumes: the built CLI via tsx; whole API.

- [ ] **Step 1: Write script** — `scripts/e2e.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
export AGENTBOARD_HOME=$(mktemp -d) AGENTBOARD_PORT=4788
CLI="npx tsx src/cli.ts"
$CLI serve & DPID=$!; sleep 1
trap "kill $DPID 2>/dev/null" EXIT

$CLI join --name amber-fox | grep -q AGENT_NAME=amber-fox
$CLI join --name jade-lynx | grep -q "agent amber-fox"
$CLI card create "Auth refactor" --paths 'src/auth/**' --column in_progress --agent amber-fox | grep -q "card #1"
$CLI card create "Login page" --paths src/auth/login.ts --agent jade-lynx | grep -q "overlap with card #1"
$CLI ask jade-lynx "hold off on login?" --from amber-fox | grep -q "msg #1"
JADE_ID=$($CLI snapshot | python3 -c "import json,sys; print([a['id'] for a in json.load(sys.stdin)['agents'] if a['name']=='jade-lynx'][0])")
$CLI pulse --agent-id $JADE_ID | grep -q "hold off on login?"
$CLI reply 1 "yes, waiting" --from jade-lynx
$CLI card move 1 review --agent amber-fox | grep -q "→ review"
echo "E2E PASS"
```

- [ ] **Step 2: Run** `chmod +x scripts/e2e.sh && ./scripts/e2e.sh` — Expected: `E2E PASS`.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "test: end-to-end two-agent script"`

---

### Task 13: Web UI

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/Board.tsx`, `web/src/CardDrawer.tsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: REST API + SSE from Tasks 4–8 (same origin). No new server routes.
- Produces: `web/dist/` static bundle served by the daemon at `/`. Features: board switcher, 5-column kanban, drag-to-move (HTML5 DnD calling `POST /cards/:id/move`), agent sidebar with status dots, card drawer (description, paths, activity via `GET /cards/:id/events`, Q&A via `POST /messages`), "Ask an agent" form, SSE-driven refresh.

- [ ] **Step 1: Scaffold**

`web/package.json`:
```json
{
  "name": "agentboard-web", "private": true, "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": { "react": "^18.3.0", "react-dom": "^18.3.0" },
  "devDependencies": { "@types/react": "^18.3.0", "@types/react-dom": "^18.3.0", "@vitejs/plugin-react": "^4.3.0", "typescript": "^5.5.0", "vite": "^5.4.0" }
}
```

`web/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:4750' } },
})
```

`web/index.html`:
```html
<!doctype html>
<html><head><meta charset="utf-8"/><title>agentboard</title>
<link rel="stylesheet" href="/src/styles.css"/></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```

- [ ] **Step 2: Implement app**

`web/src/api.ts`:
```ts
export const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`/api/v1${p}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export type Card = { id: number; title: string; description: string; column: string; owner: string | null; paths: string[]; updated_at: string }
export type Agent = { id: number; name: string; status: string; last_seen: string }
export type Snapshot = { board: { id: number; name: string }; agents: Agent[]; cards: Card[]; open_questions: any[] }
```

`web/src/main.tsx`:
```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
createRoot(document.getElementById('root')!).render(<App />)
```

`web/src/App.tsx`:
```tsx
import React, { useCallback, useEffect, useState } from 'react'
import { api, Snapshot } from './api'
import { Board } from './Board'

export function App() {
  const [boards, setBoards] = useState<any[]>([])
  const [boardId, setBoardId] = useState<number | null>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)

  const refresh = useCallback(async (id: number) => setSnap(await api('GET', `/boards/${id}/snapshot`)), [])

  useEffect(() => {
    api('GET', '/boards').then((bs) => { setBoards(bs); if (bs[0]) setBoardId(bs[0].id) })
  }, [])

  useEffect(() => {
    if (boardId == null) return
    refresh(boardId)
    const es = new EventSource(`/api/v1/boards/${boardId}/events`)
    es.onmessage = () => refresh(boardId)
    return () => es.close()
  }, [boardId, refresh])

  return (
    <div className="app">
      <header>
        <h1>agentboard</h1>
        <select value={boardId ?? ''} onChange={(e) => setBoardId(Number(e.target.value))}>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </header>
      {snap && <Board snap={snap} onChange={() => refresh(snap.board.id)} />}
    </div>
  )
}
```

`web/src/Board.tsx`:
```tsx
import React, { useState } from 'react'
import { api, Card, Snapshot } from './api'
import { CardDrawer } from './CardDrawer'

const COLUMNS = ['backlog', 'in_progress', 'blocked', 'review', 'done']
const LABEL: Record<string, string> = { backlog: 'Backlog', in_progress: 'In Progress', blocked: 'Blocked', review: 'Review', done: 'Done' }

export function Board({ snap, onChange }: { snap: Snapshot; onChange: () => void }) {
  const [open, setOpen] = useState<Card | null>(null)
  const [askTo, setAskTo] = useState(''); const [askBody, setAskBody] = useState('')

  const drop = async (col: string, e: React.DragEvent) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/card-id')
    if (id) { await api('POST', `/cards/${id}/move`, { column: col }); onChange() }
  }
  const ask = async () => {
    if (!askTo || !askBody) return
    await api('POST', '/messages', { board_id: snap.board.id, to: askTo, body: askBody })
    setAskBody(''); onChange()
  }

  return (
    <div className="layout">
      <aside>
        <h2>Agents</h2>
        {snap.agents.map((a) => (
          <div key={a.id} className={`agent ${a.status}`}>
            <span className="dot" /> {a.name} <small>{a.status}</small>
          </div>
        ))}
        <h2>Ask an agent</h2>
        <select value={askTo} onChange={(e) => setAskTo(e.target.value)}>
          <option value="">choose…</option>
          {snap.agents.filter((a) => a.status !== 'gone').map((a) => <option key={a.id}>{a.name}</option>)}
        </select>
        <textarea value={askBody} onChange={(e) => setAskBody(e.target.value)} placeholder="question…" />
        <button onClick={ask}>Send</button>
        {snap.open_questions.length > 0 && <>
          <h2>Open questions</h2>
          {snap.open_questions.map((q) => (
            <div key={q.id} className="question">
              <b>{q.from_name ?? 'you'} → {q.to_name ?? 'all'}:</b> {q.body}
            </div>))}
        </>}
      </aside>
      <main>
        {COLUMNS.map((col) => (
          <section key={col} onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(col, e)}>
            <h3>{LABEL[col]} <small>{snap.cards.filter((c) => c.column === col).length}</small></h3>
            {snap.cards.filter((c) => c.column === col).map((c) => (
              <article key={c.id} draggable onClick={() => setOpen(c)}
                onDragStart={(e) => e.dataTransfer.setData('text/card-id', String(c.id))}>
                <b>{c.title}</b>
                <small>{c.owner ?? 'unowned'}</small>
                {c.paths.length > 0 && <code>{c.paths.join(' ')}</code>}
              </article>
            ))}
          </section>
        ))}
      </main>
      {open && <CardDrawer card={open} boardId={snap.board.id} agents={snap.agents}
        onClose={() => setOpen(null)} onChange={onChange} />}
    </div>
  )
}
```

`web/src/CardDrawer.tsx`:
```tsx
import React, { useEffect, useState } from 'react'
import { api, Agent, Card } from './api'

export function CardDrawer({ card, boardId, agents, onClose, onChange }:
  { card: Card; boardId: number; agents: Agent[]; onClose: () => void; onChange: () => void }) {
  const [events, setEvents] = useState<any[]>([])
  const [comment, setComment] = useState('')
  useEffect(() => { api('GET', `/cards/${card.id}/events`).then(setEvents) }, [card.id])

  const send = async () => {
    if (!comment) return
    await api('POST', '/messages', { board_id: boardId, to: card.owner ?? undefined, card_id: card.id, body: comment })
    setComment(''); onChange()
  }

  return (
    <div className="drawer">
      <button className="close" onClick={onClose}>×</button>
      <h2>#{card.id} {card.title}</h2>
      <p><b>{card.owner ?? 'unowned'}</b> · {card.column} · updated {card.updated_at}</p>
      {card.description && <p>{card.description}</p>}
      {card.paths.length > 0 && <p><code>{card.paths.join(', ')}</code></p>}
      <h3>Activity</h3>
      <ul>{events.map((e) => <li key={e.id}><small>{e.created_at}</small> {e.agent ?? 'human'} {e.type}</li>)}</ul>
      <h3>Message {card.owner ?? 'owner'}</h3>
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
      <button onClick={send}>Send</button>
    </div>
  )
}
```

`web/src/styles.css`:
```css
* { box-sizing: border-box; margin: 0; }
body { font: 14px/1.45 -apple-system, system-ui, sans-serif; background: #f5f4f0; color: #1a1a1a; }
.app header { display: flex; gap: 12px; align-items: center; padding: 12px 16px; background: #fff; border-bottom: 1px solid #e2e0da; }
.app h1 { font-size: 16px; }
.layout { display: grid; grid-template-columns: 220px 1fr; gap: 12px; padding: 12px; }
aside { background: #fff; border: 1px solid #e2e0da; border-radius: 8px; padding: 12px; height: fit-content; display: grid; gap: 8px; }
aside h2 { font-size: 12px; text-transform: uppercase; color: #6b675f; }
.agent .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #b8b4aa; margin-right: 6px; }
.agent.active .dot { background: #3a9e5f; }
.agent.idle .dot { background: #d9a13b; }
main { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; align-items: start; }
main section { background: #ecebe6; border-radius: 8px; padding: 8px; min-height: 200px; }
main h3 { font-size: 12px; text-transform: uppercase; color: #6b675f; padding: 4px; }
article { background: #fff; border: 1px solid #e2e0da; border-radius: 6px; padding: 8px; margin-top: 8px; cursor: pointer; display: grid; gap: 4px; }
article code, .drawer code { font-size: 11px; color: #6b675f; word-break: break-all; }
.drawer { position: fixed; top: 0; right: 0; width: 380px; height: 100vh; background: #fff; border-left: 1px solid #e2e0da; padding: 16px; overflow-y: auto; display: grid; gap: 8px; align-content: start; }
.drawer .close { justify-self: end; }
textarea { width: 100%; min-height: 60px; }
```

- [ ] **Step 3: Build & verify** — Run:
```bash
cd web && npm i && npm run build && cd ..
AGENTBOARD_HOME=$(mktemp -d) npx tsx src/cli.ts serve &
sleep 1 && npx tsx src/cli.ts join --name demo-otter
npx tsx src/cli.ts card create "Demo card" --paths src/demo.ts --agent demo-otter --column in_progress
open http://localhost:4750
```
Expected: board renders with demo card in In Progress, demo-otter active in sidebar; drag the card to Review and confirm it persists on reload. Kill the daemon after (`npx tsx src/cli.ts stop`).

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: web kanban UI with SSE live updates"`

---

### Task 14: Packaging, CI, README

**Files:**
- Create: `scripts/fix-bin.mjs`, `.github/workflows/ci.yml`, `README.md`, `LICENSE`
- Modify: `package.json` (prepack script)

**Interfaces:**
- Produces: `npm pack` produces a tarball where `npx agentboard` works with the web UI included.

- [ ] **Step 1: Bin fixer + prepack**

`scripts/fix-bin.mjs`:
```js
import fs from 'node:fs'
fs.chmodSync('dist/cli.js', 0o755)
```

Add to `package.json` scripts:
```json
"prepack": "npm run build && cd web && npm ci && npm run build"
```

- [ ] **Step 2: CI** — `.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm test
      - run: ./scripts/e2e.sh
      - run: npm run build
  publish:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: test
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, registry-url: 'https://registry.npmjs.org' }
      - run: npm ci
      - run: npm publish --provenance --access public
        env: { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' }
```

- [ ] **Step 3: README** — `README.md` with exactly these sections (write full prose, no placeholders):
  - Title + one-line pitch + demo GIF placeholder link (`docs/demo.gif`, recorded in Task 15)
  - **Quickstart** (the whole install story):
    ```bash
    npm i -g agentboard   # or: npx agentboard serve
    agentboard install     # wires Claude Code hooks (global)
    agentboard serve &     # or let hooks auto-start it
    open http://localhost:4750
    ```
    "Open two Claude Code terminals in the same repo — both auto-register, create cards, and warn each other about overlapping paths."
  - **How it works** (daemon/CLI/hooks/UI diagram from the spec)
  - **CLI reference** (every command from Task 9 with one-line description)
  - **Configuration** (`AGENTBOARD_PORT`, `AGENTBOARD_HOME`, `AGENTBOARD_NAME`)
  - **Uninstall** (`agentboard uninstall && rm -rf ~/.agentboard`)
  - **FAQ**: does it phone home? (no — fully local, no telemetry); does it slow Claude down? (hooks are throttled, 2 s hard cap, always exit 0); non-git folders? (board per directory)

Also create `LICENSE` (MIT, copyright 2026 agentboard contributors).

- [ ] **Step 4: Verify pack** — Run:
```bash
npm pack --dry-run
```
Expected: tarball lists `dist/cli.js` and `web/dist/index.html`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "chore: packaging, CI, README"`

---

### Task 15: Launch (manual gate — do with the user)

**Files:**
- Create: `docs/launch-checklist.md`

- [ ] **Step 1: Write** `docs/launch-checklist.md` with this content and check items off as they complete:
```markdown
# Launch checklist
- [ ] Real-world dogfood: run agentboard with 2+ real Claude Code sessions on an actual project for a day; fix friction.
- [ ] Record demo GIF/video: 3 terminals + web UI; save docs/demo.gif; link from README.
- [ ] Create public GitHub repo (agentboard), push, enable Actions; confirm CI green.
- [ ] npm: reserve name (`npm publish` v0.1.0 via tag push after NPM_TOKEN secret is set).
- [ ] Claude Code plugin marketplace: create plugin repo with .claude-plugin/marketplace.json pointing install at `agentboard install`; test `/plugin install`.
- [ ] Launch posts: Show HN, r/ClaudeAI, X thread with video, Anthropic Discord #community-projects.
- [ ] Post-launch: triage issues daily for the first week; label good-first-issue; add CONTRIBUTING.md if PRs arrive.
```

- [ ] **Step 2: Commit** — `git add -A && git commit -m "docs: launch checklist"`

- [ ] **Step 3: STOP — everything beyond this line (repo creation, npm publish, posts) requires user account access and explicit user go-ahead.**
