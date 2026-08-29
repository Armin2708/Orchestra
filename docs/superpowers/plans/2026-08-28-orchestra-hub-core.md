# Orchestra Hub — Server Core Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the hosted hub's server core — a multi-tenant, Postgres-backed Fastify app where several machines' daemons share one org board through an append-only per-org event log, with conflicting writes rejected rather than merged.

**Architecture:** A new `src/hub/**` tree, independent of the local SQLite stack. All shared state lives in Postgres. Every state change is written inside one transaction that also appends a row to `org_events`, which carries a per-org monotonic `seq`. Daemons read that log forward over SSE (`?since=<seq>`) and write through ordinary REST ops carrying an idempotency key and the entity `version` they last saw; a stale version yields `409` plus current state. No Clerk, no Stripe, no UI in this plan — auth here is hub-minted device tokens only.

**Tech Stack:** TypeScript (ESM, NodeNext — all intra-repo imports carry `.js`), Fastify 5, `pg` (Postgres; Supabase in production), PGlite for hermetic tests, vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-orchestra-hub-design.md`

## Global Constraints

- **ESM only.** `package.json` has `"type": "module"`; `tsconfig.json` is `module: NodeNext`. Every intra-repo import MUST end in `.js` (e.g. `import { hubMigrate } from './migrations.js'`), even though sources are `.ts`.
- **Node `>=22.20.0 <23`, npm `>=10.9.3 <11`** (engines are a pinned range).
- **Test command is `npx vitest run <file>`**; the only script is `"test": "vitest run"`. Tests live in `test/**/*.test.ts`. `vitest.config.ts` pins `maxWorkers: 4` — do not change it.
- **No `better-sqlite3` import anywhere under `src/hub/`.** The hub is async Postgres; the local stack is synchronous SQLite. Sharing storage code between them is a plan violation.
- **Do not modify `buildServer()` in `src/server.ts`.** Its signature is SQLite-coupled (`buildServer(db: Database.Database, …)`). The hub builds its own Fastify app.
- **Do not create or switch git branches in this checkout.** Multiple agents share it. If isolation is needed, use `git worktree add`.
- **Every new file under `src/hub/` must be reachable from `src/hub/index.ts`** so the tsup bundle (single entry `src/cli.ts`) picks it up transitively.
- **Money/identity are out of scope here.** No Clerk SDK, no Stripe SDK, no `users`/`memberships`/`subscriptions` business logic beyond the mirror tables' columns existing (Plan 3 fills them).
- All timestamps are Postgres `timestamptz`, generated with `now()` server-side. Never accept a client-supplied `created_at`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/hub/sql.ts` | `HubSql` interface (the one seam both `pg.Pool` and PGlite satisfy) + `withTransaction` helper |
| `src/hub/errors.ts` | `HubError` family (`ValidationError`, `NotFoundError`, `ConflictError`, `ForbiddenError`) with `statusCode` + `code` |
| `src/hub/validate.ts` | Hand-rolled body validators (repo has no runtime zod usage) |
| `src/hub/types.ts` | Wire types shared with daemon/web: `HubCard`, `HubMail`, `HubAgent`, `HubEvent`, op payloads |
| `src/hub/migrations/001-hub-core.sql` | orgs, users, memberships, subscriptions, devices, projects, boards |
| `src/hub/migrations/002-hub-work.sql` | cards, card_events, mail, agents (presence) |
| `src/hub/migrations/003-hub-events.sql` | org_events + per-org seq allocation |
| `src/hub/migrations.ts` | Numbered migration runner (`hub_schema_migrations`), mirrors the local runner's contract |
| `src/hub/events.ts` | `appendOrgEvent` (seq allocation, idempotency replay), `readOrgEventsSince` |
| `src/hub/devices.ts` | Device token mint / verify / revoke (hashed at rest) |
| `src/hub/cards.ts` | Card ops: create, update, move, **claim** — all optimistic-concurrency |
| `src/hub/mail.ts` | Org-scoped mail send + inbox drain |
| `src/hub/presence.ts` | Agent register, heartbeat, TTL sweep to `offline` |
| `src/hub/routes/sync.ts` | SSE `GET /sync?since=` + op `POST /ops` |
| `src/hub/routes/cards.ts` | Card REST (web UI path) |
| `src/hub/routes/mail.ts` | Mail REST |
| `src/hub/routes/presence.ts` | Presence REST |
| `src/hub/server.ts` | `buildHubServer(sql, opts)` — auth `onRequest`, org scoping, plugin registration, error handler |
| `src/hub/index.ts` | Barrel export + `startHub()` used by the CLI |
| `src/hub-cli.ts` | `registerHubCommands(program, deps)` — `orchestra hub` |
| `test/support/hub-fixture.ts` | PGlite-backed `hubFixture()` returning `{ sql, server, orgId, deviceToken }` |
| `test/hub-*.test.ts` | One test file per module above |

---

## Task 1: Hub SQL seam, errors, and migration runner

**Files:**
- Create: `src/hub/sql.ts`, `src/hub/errors.ts`, `src/hub/migrations.ts`, `src/hub/migrations/001-hub-core.sql`
- Create: `test/hub-migrations.test.ts`
- Modify: `package.json` (add `pg`; dev `@types/pg`, `@electric-sql/pglite`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `interface HubSql { query<R = any>(text: string, params?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number }> }`
  - `withTransaction<T>(sql: HubSql, fn: (tx: HubSql) => Promise<T>): Promise<T>`
  - `class HubError extends Error { statusCode: number; code: string }`, subclasses `ValidationError` (400/`validation_failed`), `ForbiddenError` (403/`forbidden`), `NotFoundError` (404/`not_found`), `ConflictError` (409/`conflict`)
  - `hubMigrate(sql: HubSql): Promise<string[]>` — returns ids applied this run
  - `HUB_MIGRATIONS: readonly { id: string; sqlFile: string }[]`

- [ ] **Step 1: Add dependencies**

```bash
npm install pg@^8.13.1
npm install --save-dev @types/pg@^8.11.10 @electric-sql/pglite@^0.2.17
```

- [ ] **Step 2: Write the failing test**

Create `test/hub-migrations.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { hubMigrate } from '../src/hub/migrations.js'
import type { HubSql } from '../src/hub/sql.js'

function pglite(): HubSql {
  const db = new PGlite()
  return { query: async (text, params) => {
    const r = await db.query(text, params ? [...params] : undefined)
    return { rows: (r.rows ?? []) as any[], rowCount: r.rows?.length ?? 0 }
  } }
}

describe('hub migrations', () => {
  it('creates core tables and is idempotent', async () => {
    const sql = pglite()

    const first = await hubMigrate(sql)
    expect(first).toContain('001-hub-core')

    const tables = await sql.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    )
    const names = tables.rows.map((r) => r.table_name)
    expect(names).toEqual(expect.arrayContaining([
      'hub_schema_migrations', 'orgs', 'users', 'memberships', 'subscriptions', 'devices', 'projects', 'boards',
    ]))

    const second = await hubMigrate(sql)
    expect(second).toEqual([])
  })

  it('rejects a second org with the same slug', async () => {
    const sql = pglite()
    await hubMigrate(sql)
    await sql.query("INSERT INTO orgs (id, name, slug) VALUES ('org_a', 'A', 'acme')")
    await expect(
      sql.query("INSERT INTO orgs (id, name, slug) VALUES ('org_b', 'B', 'acme')"),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run test/hub-migrations.test.ts`
Expected: FAIL — cannot resolve `../src/hub/migrations.js`.

- [ ] **Step 4: Write `src/hub/sql.ts`**

```ts
/**
 * The single storage seam for the hub. Production passes a `pg.Pool`; tests pass a
 * PGlite adapter. Nothing under src/hub/ may import a concrete driver.
 */
export interface HubSql {
  query<R = any>(text: string, params?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number }>
}

/** A connection that can be exclusively held for the duration of a transaction. */
export interface HubSqlPool extends HubSql {
  connect?(): Promise<HubSqlConnection>
}

export interface HubSqlConnection extends HubSql {
  release(): void
}

/**
 * Runs `fn` inside one transaction. When the pool can hand out a dedicated
 * connection we use it (real Postgres); PGlite is single-connection and serialises
 * on its own, so the fallback issues the same statements against the shared handle.
 */
export async function withTransaction<T>(sql: HubSqlPool, fn: (tx: HubSql) => Promise<T>): Promise<T> {
  const conn = sql.connect ? await sql.connect() : null
  const handle: HubSql = conn ?? sql
  await handle.query('BEGIN')
  try {
    const result = await fn(handle)
    await handle.query('COMMIT')
    return result
  } catch (error) {
    await handle.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    conn?.release()
  }
}
```

- [ ] **Step 5: Write `src/hub/errors.ts`**

```ts
export class HubError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message)
    this.name = new.target.name
  }
}

export class ValidationError extends HubError {
  constructor(message: string) { super(message, 400, 'validation_failed') }
}
export class ForbiddenError extends HubError {
  constructor(message: string) { super(message, 403, 'forbidden') }
}
export class NotFoundError extends HubError {
  constructor(message: string) { super(message, 404, 'not_found') }
}
export class ConflictError extends HubError {
  /** `current` is echoed to the client so a losing writer can resync without a second round trip. */
  constructor(message: string, readonly current?: unknown) { super(message, 409, 'conflict') }
}
```

- [ ] **Step 6: Write `src/hub/migrations/001-hub-core.sql`**

```sql
-- Identity mirrors. Clerk owns the truth (Plan 3); these rows exist so the rest of
-- the schema has real foreign keys and org-scoped reads never call Clerk.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  clerk_user_id TEXT UNIQUE,
  email         TEXT NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orgs (
  id           TEXT PRIMARY KEY,
  clerk_org_id TEXT UNIQUE,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  seat_cap     INTEGER NOT NULL DEFAULT 5,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  org_id                 TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  status                 TEXT NOT NULL DEFAULT 'inactive',
  current_period_end     TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per connected daemon. Hub-minted, hub-verified; daemons never see Clerk.
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  membership_id TEXT REFERENCES memberships(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS devices_org_idx ON devices (org_id);

-- Maps every member's local checkout of the same repo onto one shared board.
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  repo_fingerprint TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS boards (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS boards_org_idx ON boards (org_id);
```

- [ ] **Step 7: Write `src/hub/migrations.ts`**

```ts
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { HubSql } from './sql.js'

/**
 * Numbered, append-only, and never edited after shipping — the same contract the
 * local runner (`applyAgentOsMigrations`) holds for SQLite.
 */
export const HUB_MIGRATIONS: readonly { id: string; sqlFile: string }[] = [
  { id: '001-hub-core', sqlFile: '001-hub-core.sql' },
]

async function migrationSql(sqlFile: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`./migrations/${sqlFile}`, import.meta.url)), 'utf8')
}

/** Applies every unapplied migration in order. Returns the ids applied this run. */
export async function hubMigrate(sql: HubSql): Promise<string[]> {
  await sql.query(`CREATE TABLE IF NOT EXISTS hub_schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)

  const applied = await sql.query<{ id: string }>('SELECT id FROM hub_schema_migrations')
  const done = new Set(applied.rows.map((row) => row.id))
  const ran: string[] = []

  for (const migration of HUB_MIGRATIONS) {
    if (done.has(migration.id)) continue
    await sql.query(await migrationSql(migration.sqlFile))
    await sql.query('INSERT INTO hub_schema_migrations (id) VALUES ($1)', [migration.id])
    ran.push(migration.id)
  }
  return ran
}
```

- [ ] **Step 8: Ensure the `.sql` files ship**

The migration runner reads `.sql` at runtime, but tsup bundles only `.ts`. Add a copy step so `dist/hub/migrations/*.sql` exists. In `package.json`, change the build script:

```json
"build": "tsup && node scripts/copy-hub-migrations.mjs && node scripts/fix-bin.mjs"
```

Create `scripts/copy-hub-migrations.mjs`:

```js
import { cp, mkdir } from 'node:fs/promises'

await mkdir('dist/hub/migrations', { recursive: true })
await cp('src/hub/migrations', 'dist/hub/migrations', { recursive: true })
console.log('copied hub migrations to dist/hub/migrations')
```

Also add `"scripts/copy-hub-migrations.mjs"` to the `files` allowlist in `package.json` (it is an explicit list; unlisted files do not ship).

- [ ] **Step 9: Run the test and confirm it passes**

Run: `npx vitest run test/hub-migrations.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json scripts/copy-hub-migrations.mjs src/hub test/hub-migrations.test.ts
git commit -m "feat(hub): postgres sql seam, error family, and migration runner"
```

---

## Task 2: Work schema and the per-org event log

**Files:**
- Create: `src/hub/migrations/002-hub-work.sql`, `src/hub/migrations/003-hub-events.sql`, `src/hub/types.ts`, `src/hub/events.ts`
- Modify: `src/hub/migrations.ts` (append two entries to `HUB_MIGRATIONS`)
- Create: `test/hub-events.test.ts`

**Interfaces:**
- Consumes: `HubSql`, `withTransaction`, `ConflictError`, `hubMigrate`.
- Produces:
  - `type HubEventKind = 'card.created' | 'card.updated' | 'card.moved' | 'card.claimed' | 'mail.sent' | 'agent.registered' | 'agent.presence'`
  - `interface HubEvent { id: string; org_id: string; seq: number; kind: HubEventKind; board_id: string | null; actor_device_id: string | null; payload: unknown; created_at: string }`
  - `appendOrgEvent(tx: HubSql, input: AppendOrgEvent): Promise<HubEvent>` where `interface AppendOrgEvent { orgId: string; kind: HubEventKind; boardId?: string | null; actorDeviceId?: string | null; idempotencyKey?: string | null; payload: unknown }`
  - `readOrgEventsSince(sql: HubSql, orgId: string, since: number, limit?: number): Promise<HubEvent[]>`
  - `latestOrgSeq(sql: HubSql, orgId: string): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `test/hub-events.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { appendOrgEvent, readOrgEventsSince, latestOrgSeq } from '../src/hub/events.js'
import { hubTestSql, seedOrg } from './support/hub-sql.js'

describe('org event log', () => {
  it('assigns a gapless monotonic seq per org', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedOrg(sql, 'org_b')

    const a1 = await appendOrgEvent(sql, { orgId: 'org_a', kind: 'card.created', payload: { n: 1 } })
    const a2 = await appendOrgEvent(sql, { orgId: 'org_a', kind: 'card.created', payload: { n: 2 } })
    const b1 = await appendOrgEvent(sql, { orgId: 'org_b', kind: 'card.created', payload: { n: 3 } })

    expect(a1.seq).toBe(1)
    expect(a2.seq).toBe(2)
    expect(b1.seq).toBe(1) // per-org counter, not global
    expect(await latestOrgSeq(sql, 'org_a')).toBe(2)
  })

  it('replays an identical idempotency key instead of appending twice', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')

    const first = await appendOrgEvent(sql, {
      orgId: 'org_a', kind: 'mail.sent', idempotencyKey: 'key-1', payload: { body: 'hi' },
    })
    const replay = await appendOrgEvent(sql, {
      orgId: 'org_a', kind: 'mail.sent', idempotencyKey: 'key-1', payload: { body: 'hi' },
    })

    expect(replay.id).toBe(first.id)
    expect(replay.seq).toBe(first.seq)
    expect(await latestOrgSeq(sql, 'org_a')).toBe(1)
  })

  it('rejects a reused idempotency key carrying different content', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await appendOrgEvent(sql, { orgId: 'org_a', kind: 'mail.sent', idempotencyKey: 'key-1', payload: { body: 'hi' } })

    await expect(appendOrgEvent(sql, {
      orgId: 'org_a', kind: 'mail.sent', idempotencyKey: 'key-1', payload: { body: 'DIFFERENT' },
    })).rejects.toThrow(/idempotency key/i)
  })

  it('reads forward from a seq and never leaks another org', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedOrg(sql, 'org_b')
    for (const n of [1, 2, 3]) {
      await appendOrgEvent(sql, { orgId: 'org_a', kind: 'card.created', payload: { n } })
    }
    await appendOrgEvent(sql, { orgId: 'org_b', kind: 'card.created', payload: { n: 99 } })

    const tail = await readOrgEventsSince(sql, 'org_a', 1)
    expect(tail.map((e) => e.seq)).toEqual([2, 3])
    expect(tail.every((e) => e.org_id === 'org_a')).toBe(true)
  })
})
```

- [ ] **Step 2: Write the shared test SQL helper**

Create `test/support/hub-sql.ts`:

```ts
import { PGlite } from '@electric-sql/pglite'
import { hubMigrate } from '../../src/hub/migrations.js'
import type { HubSql } from '../../src/hub/sql.js'

/** A migrated, in-process Postgres. No Docker, no live DB, one per test. */
export async function hubTestSql(): Promise<HubSql> {
  const db = new PGlite()
  const sql: HubSql = {
    query: async (text, params) => {
      const result = await db.query(text, params ? [...params] : undefined)
      const rows = (result.rows ?? []) as any[]
      return { rows, rowCount: rows.length }
    },
  }
  await hubMigrate(sql)
  return sql
}

export async function seedOrg(sql: HubSql, orgId: string): Promise<void> {
  await sql.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [orgId, orgId, orgId])
}

export async function seedBoard(sql: HubSql, orgId: string, boardId: string): Promise<void> {
  await sql.query('INSERT INTO projects (id, org_id, name) VALUES ($1, $2, $3)', [`proj_${boardId}`, orgId, boardId])
  await sql.query('INSERT INTO boards (id, org_id, project_id, name) VALUES ($1, $2, $3, $4)', [
    boardId, orgId, `proj_${boardId}`, boardId,
  ])
}
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run test/hub-events.test.ts`
Expected: FAIL — cannot resolve `../src/hub/events.js`.

- [ ] **Step 4: Write `src/hub/migrations/002-hub-work.sql`**

```sql
CREATE TABLE IF NOT EXISTS cards (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  board_id     TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  column_name  TEXT NOT NULL DEFAULT 'backlog',
  owner_agent  TEXT,
  paths        JSONB NOT NULL DEFAULT '[]'::jsonb,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (board_id, number)
);
CREATE INDEX IF NOT EXISTS cards_org_idx ON cards (org_id);

CREATE TABLE IF NOT EXISTS mail (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  card_id     TEXT REFERENCES cards(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'ask',
  subject     TEXT,
  body        TEXT NOT NULL,
  from_agent  TEXT NOT NULL,
  to_agent    TEXT,
  to_human    BOOLEAN NOT NULL DEFAULT false,
  reply_to    TEXT REFERENCES mail(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS mail_org_board_idx ON mail (org_id, board_id);
CREATE INDEX IF NOT EXISTS mail_inbox_idx ON mail (org_id, to_agent) WHERE delivered_at IS NULL;

-- Presence is latest-state-only. It is deliberately NOT in the event log:
-- heartbeats must not inflate the replayable history.
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  board_id        TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  device_id       TEXT REFERENCES devices(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('working', 'idle', 'waiting', 'offline')),
  current_card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
  activity        TEXT,
  last_heartbeat_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, board_id, name)
);
CREATE INDEX IF NOT EXISTS agents_org_idx ON agents (org_id);
```

- [ ] **Step 5: Write `src/hub/migrations/003-hub-events.sql`**

```sql
CREATE TABLE IF NOT EXISTS org_events (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  seq             BIGINT NOT NULL,
  kind            TEXT NOT NULL,
  board_id        TEXT REFERENCES boards(id) ON DELETE CASCADE,
  actor_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, seq)
);

-- Resume reads are always "this org, forward from seq".
CREATE INDEX IF NOT EXISTS org_events_stream_idx ON org_events (org_id, seq);

-- Replay protection for the daemon's offline queue: the same key may be POSTed
-- again after a reconnect and must not append a second event.
CREATE UNIQUE INDEX IF NOT EXISTS org_events_idempotency_idx
  ON org_events (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
```

- [ ] **Step 6: Register both migrations**

In `src/hub/migrations.ts`, replace the `HUB_MIGRATIONS` array:

```ts
export const HUB_MIGRATIONS: readonly { id: string; sqlFile: string }[] = [
  { id: '001-hub-core', sqlFile: '001-hub-core.sql' },
  { id: '002-hub-work', sqlFile: '002-hub-work.sql' },
  { id: '003-hub-events', sqlFile: '003-hub-events.sql' },
]
```

- [ ] **Step 7: Write `src/hub/types.ts`**

```ts
export type HubEventKind =
  | 'card.created' | 'card.updated' | 'card.moved' | 'card.claimed'
  | 'mail.sent'
  | 'agent.registered' | 'agent.presence'

export interface HubEvent {
  id: string
  org_id: string
  seq: number
  kind: HubEventKind
  board_id: string | null
  actor_device_id: string | null
  payload: unknown
  created_at: string
}

export interface HubCard {
  id: string
  org_id: string
  board_id: string
  number: number
  title: string
  description: string
  column: string
  owner_agent: string | null
  paths: string[]
  version: number
  created_at: string
  updated_at: string
}

export type HubAgentState = 'working' | 'idle' | 'waiting' | 'offline'

export interface HubAgent {
  id: string
  org_id: string
  board_id: string
  device_id: string | null
  name: string
  state: HubAgentState
  current_card_id: string | null
  activity: string | null
  last_heartbeat_at: string | null
}

export interface HubMail {
  id: string
  org_id: string
  board_id: string
  card_id: string | null
  kind: string
  subject: string | null
  body: string
  from_agent: string
  to_agent: string | null
  to_human: boolean
  reply_to: string | null
  created_at: string
  delivered_at: string | null
}
```

- [ ] **Step 8: Write `src/hub/events.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { ConflictError } from './errors.js'
import type { HubSql } from './sql.js'
import type { HubEvent, HubEventKind } from './types.js'

export interface AppendOrgEvent {
  orgId: string
  kind: HubEventKind
  boardId?: string | null
  actorDeviceId?: string | null
  idempotencyKey?: string | null
  payload: unknown
}

/**
 * Appends one event and allocates the org's next `seq` in the same statement.
 * The SELECT runs inside the INSERT so two writers cannot read the same max.
 * Callers that also mutate an entity MUST wrap both in one `withTransaction`.
 */
export async function appendOrgEvent(sql: HubSql, input: AppendOrgEvent): Promise<HubEvent> {
  const key = input.idempotencyKey ?? null
  if (key) {
    const existing = await sql.query<HubEvent>(
      'SELECT * FROM org_events WHERE org_id = $1 AND idempotency_key = $2',
      [input.orgId, key],
    )
    const prior = existing.rows[0]
    if (prior) {
      const samePayload = JSON.stringify(prior.payload) === JSON.stringify(input.payload ?? {})
      if (prior.kind === input.kind && samePayload) return normalize(prior)
      throw new ConflictError('idempotency key was already used for a different event')
    }
  }

  const inserted = await sql.query<HubEvent>(
    `INSERT INTO org_events (id, org_id, seq, kind, board_id, actor_device_id, idempotency_key, payload)
     VALUES ($1, $2,
             (SELECT COALESCE(MAX(seq), 0) + 1 FROM org_events WHERE org_id = $2),
             $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      `evt_${randomUUID()}`, input.orgId, input.kind,
      input.boardId ?? null, input.actorDeviceId ?? null, key,
      JSON.stringify(input.payload ?? {}),
    ],
  )
  return normalize(inserted.rows[0])
}

/** Events strictly after `since`, oldest first — the daemon's resume read. */
export async function readOrgEventsSince(
  sql: HubSql, orgId: string, since: number, limit = 500,
): Promise<HubEvent[]> {
  const result = await sql.query<HubEvent>(
    'SELECT * FROM org_events WHERE org_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3',
    [orgId, since, limit],
  )
  return result.rows.map(normalize)
}

export async function latestOrgSeq(sql: HubSql, orgId: string): Promise<number> {
  const result = await sql.query<{ seq: string | number | null }>(
    'SELECT MAX(seq) AS seq FROM org_events WHERE org_id = $1', [orgId],
  )
  return Number(result.rows[0]?.seq ?? 0)
}

/** Postgres returns BIGINT as a string through node-postgres; the wire type is a number. */
function normalize(row: HubEvent): HubEvent {
  return { ...row, seq: Number(row.seq) }
}
```

- [ ] **Step 9: Run the test and confirm it passes**

Run: `npx vitest run test/hub-events.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 10: Run the migration test again to confirm nothing regressed**

Run: `npx vitest run test/hub-migrations.test.ts test/hub-events.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 11: Commit**

```bash
git add src/hub test/hub-events.test.ts test/support/hub-sql.ts
git commit -m "feat(hub): work schema and per-org monotonic event log"
```

---

## Task 3: Card ops with optimistic concurrency

This is the task that makes overlapping work impossible. Everything else is plumbing.

**Files:**
- Create: `src/hub/cards.ts`, `src/hub/validate.ts`
- Create: `test/hub-cards.test.ts`

**Interfaces:**
- Consumes: `HubSql`, `withTransaction`, `appendOrgEvent`, `ConflictError`/`NotFoundError`/`ValidationError`, `HubCard`.
- Produces:
  - `createCard(sql, input: CreateCardInput): Promise<HubCard>` — `{ orgId; boardId; title; description?; paths?: string[]; ownerAgent?: string | null; actorDeviceId?: string | null; idempotencyKey?: string | null }`
  - `updateCard(sql, input: UpdateCardInput): Promise<HubCard>` — `{ orgId; cardId; expectedVersion; title?; description?; paths?; actorDeviceId?; idempotencyKey? }`
  - `moveCard(sql, input: MoveCardInput): Promise<HubCard>` — `{ orgId; cardId; expectedVersion; column: string; actorDeviceId?; idempotencyKey? }`
  - `claimCard(sql, input: ClaimCardInput): Promise<HubCard>` — `{ orgId; cardId; agent: string; actorDeviceId?; idempotencyKey? }`
  - `getCard(sql, orgId: string, cardId: string): Promise<HubCard | null>`

- [ ] **Step 1: Write the failing test**

Create `test/hub-cards.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createCard, updateCard, moveCard, claimCard, getCard } from '../src/hub/cards.js'
import { readOrgEventsSince } from '../src/hub/events.js'
import { hubTestSql, seedOrg, seedBoard } from './support/hub-sql.js'

async function board() {
  const sql = await hubTestSql()
  await seedOrg(sql, 'org_a')
  await seedBoard(sql, 'org_a', 'board_1')
  return sql
}

describe('hub card ops', () => {
  it('creates a card at version 1 with a per-board number and logs an event', async () => {
    const sql = await board()
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'First' })

    expect(card.number).toBe(1)
    expect(card.version).toBe(1)
    expect(card.column).toBe('backlog')

    const second = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'Second' })
    expect(second.number).toBe(2)

    const events = await readOrgEventsSince(sql, 'org_a', 0)
    expect(events.map((e) => e.kind)).toEqual(['card.created', 'card.created'])
  })

  it('bumps version on update and logs card.updated', async () => {
    const sql = await board()
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'First' })

    const updated = await updateCard(sql, {
      orgId: 'org_a', cardId: card.id, expectedVersion: card.version, title: 'Renamed',
    })
    expect(updated.title).toBe('Renamed')
    expect(updated.version).toBe(2)
  })

  it('rejects a stale write with 409 and hands back current state', async () => {
    const sql = await board()
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'First' })
    await moveCard(sql, { orgId: 'org_a', cardId: card.id, expectedVersion: 1, column: 'in_progress' })

    // Second writer still believes it is version 1 — this is the cross-machine race.
    const stale = updateCard(sql, {
      orgId: 'org_a', cardId: card.id, expectedVersion: 1, title: 'Too late',
    })
    await expect(stale).rejects.toMatchObject({ statusCode: 409 })
    await stale.catch((error: any) => {
      expect(error.current.version).toBe(2)
      expect(error.current.column).toBe('in_progress')
    })

    const fresh = await getCard(sql, 'org_a', card.id)
    expect(fresh?.title).toBe('First') // the losing write did not land
  })

  it('lets exactly one agent claim an unowned card', async () => {
    const sql = await board()
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'Contested' })

    const winner = await claimCard(sql, { orgId: 'org_a', cardId: card.id, agent: 'agent-one' })
    expect(winner.owner_agent).toBe('agent-one')

    await expect(
      claimCard(sql, { orgId: 'org_a', cardId: card.id, agent: 'agent-two' }),
    ).rejects.toMatchObject({ statusCode: 409 })

    const fresh = await getCard(sql, 'org_a', card.id)
    expect(fresh?.owner_agent).toBe('agent-one')
  })

  it('treats a re-claim by the current owner as a no-op success', async () => {
    const sql = await board()
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'Mine' })
    await claimCard(sql, { orgId: 'org_a', cardId: card.id, agent: 'agent-one' })

    const again = await claimCard(sql, { orgId: 'org_a', cardId: card.id, agent: 'agent-one' })
    expect(again.owner_agent).toBe('agent-one')
  })

  it('refuses to read or write another org\'s card', async () => {
    const sql = await board()
    await seedOrg(sql, 'org_b')
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'Private' })

    expect(await getCard(sql, 'org_b', card.id)).toBeNull()
    await expect(
      updateCard(sql, { orgId: 'org_b', cardId: card.id, expectedVersion: 1, title: 'Stolen' }),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/hub-cards.test.ts`
Expected: FAIL — cannot resolve `../src/hub/cards.js`.

- [ ] **Step 3: Write `src/hub/validate.ts`**

```ts
import { ValidationError } from './errors.js'

export function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new ValidationError(`${field} must not be empty`)
  if (trimmed.length > max) throw new ValidationError(`${field} must be at most ${max} characters`)
  return trimmed
}

export function optionalBoundedString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  return boundedString(value, field, max)
}

export function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`)
  if (value.length > maxItems) throw new ValidationError(`${field} must have at most ${maxItems} entries`)
  return value.map((entry, index) => boundedString(entry, `${field}[${index}]`, maxLength))
}

export function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  return value
}
```

- [ ] **Step 4: Write `src/hub/cards.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { appendOrgEvent } from './events.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { withTransaction, type HubSql, type HubSqlPool } from './sql.js'
import { boundedString, optionalBoundedString, positiveInteger, stringList } from './validate.js'
import type { HubCard } from './types.js'

const CARD_COLUMNS = new Set(['backlog', 'todo', 'in_progress', 'review', 'done'])

export interface CreateCardInput {
  orgId: string; boardId: string; title: string; description?: string
  paths?: string[]; ownerAgent?: string | null
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

export interface UpdateCardInput {
  orgId: string; cardId: string; expectedVersion: number
  title?: string; description?: string; paths?: string[]
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

export interface MoveCardInput {
  orgId: string; cardId: string; expectedVersion: number; column: string
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

export interface ClaimCardInput {
  orgId: string; cardId: string; agent: string
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

export async function getCard(sql: HubSql, orgId: string, cardId: string): Promise<HubCard | null> {
  const result = await sql.query<any>('SELECT * FROM cards WHERE org_id = $1 AND id = $2', [orgId, cardId])
  return result.rows[0] ? rowToCard(result.rows[0]) : null
}

export async function createCard(sql: HubSqlPool, input: CreateCardInput): Promise<HubCard> {
  const title = boundedString(input.title, 'title', 200)
  const description = optionalBoundedString(input.description, 'description', 20_000) ?? ''
  const paths = stringList(input.paths, 'paths', 50, 400)

  return withTransaction(sql, async (tx) => {
    const board = await tx.query('SELECT id FROM boards WHERE org_id = $1 AND id = $2', [input.orgId, input.boardId])
    if (!board.rows[0]) throw new NotFoundError('board not found in this org')

    const inserted = await tx.query<any>(
      `INSERT INTO cards (id, org_id, board_id, number, title, description, owner_agent, paths)
       VALUES ($1, $2, $3,
               (SELECT COALESCE(MAX(number), 0) + 1 FROM cards WHERE board_id = $3),
               $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [`card_${randomUUID()}`, input.orgId, input.boardId, title, description,
       input.ownerAgent ?? null, JSON.stringify(paths)],
    )
    const card = rowToCard(inserted.rows[0])

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'card.created', boardId: input.boardId,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey, payload: card,
    })
    return card
  })
}

export async function updateCard(sql: HubSqlPool, input: UpdateCardInput): Promise<HubCard> {
  const expectedVersion = positiveInteger(input.expectedVersion, 'expected_version')
  const title = optionalBoundedString(input.title, 'title', 200)
  const description = input.description === undefined ? undefined
    : optionalBoundedString(input.description, 'description', 20_000) ?? ''
  const paths = input.paths === undefined ? undefined : stringList(input.paths, 'paths', 50, 400)

  return withTransaction(sql, async (tx) => {
    const updated = await tx.query<any>(
      `UPDATE cards SET
         title = COALESCE($3, title),
         description = COALESCE($4, description),
         paths = COALESCE($5::jsonb, paths),
         version = version + 1,
         updated_at = now()
       WHERE org_id = $1 AND id = $2 AND version = $6
       RETURNING *`,
      [input.orgId, input.cardId, title ?? null, description ?? null,
       paths === undefined ? null : JSON.stringify(paths), expectedVersion],
    )
    if (!updated.rows[0]) await failStaleOrMissing(tx, input.orgId, input.cardId)
    const card = rowToCard(updated.rows[0])

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'card.updated', boardId: card.board_id,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey, payload: card,
    })
    return card
  })
}

export async function moveCard(sql: HubSqlPool, input: MoveCardInput): Promise<HubCard> {
  const expectedVersion = positiveInteger(input.expectedVersion, 'expected_version')
  const column = boundedString(input.column, 'column', 40)
  if (!CARD_COLUMNS.has(column)) {
    throw new ValidationError(`column must be one of ${[...CARD_COLUMNS].join(', ')}`)
  }

  return withTransaction(sql, async (tx) => {
    const updated = await tx.query<any>(
      `UPDATE cards SET column_name = $3, version = version + 1, updated_at = now()
       WHERE org_id = $1 AND id = $2 AND version = $4
       RETURNING *`,
      [input.orgId, input.cardId, column, expectedVersion],
    )
    if (!updated.rows[0]) await failStaleOrMissing(tx, input.orgId, input.cardId)
    const card = rowToCard(updated.rows[0])

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'card.moved', boardId: card.board_id,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey, payload: card,
    })
    return card
  })
}

/**
 * First writer wins. The `owner_agent IS NULL OR owner_agent = $3` predicate is the
 * whole mutual-exclusion mechanism: two daemons racing for the same card issue the
 * same UPDATE, Postgres serialises them, and the second one matches zero rows.
 */
export async function claimCard(sql: HubSqlPool, input: ClaimCardInput): Promise<HubCard> {
  const agent = boundedString(input.agent, 'agent', 120)

  return withTransaction(sql, async (tx) => {
    const claimed = await tx.query<any>(
      `UPDATE cards SET owner_agent = $3, version = version + 1, updated_at = now()
       WHERE org_id = $1 AND id = $2 AND (owner_agent IS NULL OR owner_agent = $3)
       RETURNING *`,
      [input.orgId, input.cardId, agent],
    )
    if (!claimed.rows[0]) {
      const current = await getCard(tx, input.orgId, input.cardId)
      if (!current) throw new NotFoundError('card not found in this org')
      throw new ConflictError(`card is already claimed by ${current.owner_agent}`, current)
    }
    const card = rowToCard(claimed.rows[0])

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'card.claimed', boardId: card.board_id,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey, payload: card,
    })
    return card
  })
}

/** Zero rows updated means either the card is gone or someone else moved first. */
async function failStaleOrMissing(tx: HubSql, orgId: string, cardId: string): Promise<never> {
  const current = await getCard(tx, orgId, cardId)
  if (!current) throw new NotFoundError('card not found in this org')
  throw new ConflictError(`card changed since version ${current.version - 1}`, current)
}

function rowToCard(row: any): HubCard {
  return {
    id: row.id, org_id: row.org_id, board_id: row.board_id, number: Number(row.number),
    title: row.title, description: row.description, column: row.column_name,
    owner_agent: row.owner_agent, paths: Array.isArray(row.paths) ? row.paths : JSON.parse(row.paths ?? '[]'),
    version: Number(row.version), created_at: row.created_at, updated_at: row.updated_at,
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run test/hub-cards.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/hub test/hub-cards.test.ts
git commit -m "feat(hub): card ops with optimistic concurrency and first-wins claims"
```

---

## Task 4: Device tokens

**Files:**
- Create: `src/hub/devices.ts`
- Create: `test/hub-devices.test.ts`

**Interfaces:**
- Consumes: `HubSql`, `ForbiddenError`, `NotFoundError`.
- Produces:
  - `mintDeviceToken(sql, input: { orgId: string; membershipId?: string | null; name: string }): Promise<{ device: HubDevice; token: string }>` — plaintext token returned once
  - `verifyDeviceToken(sql, token: string): Promise<HubDevice>` — throws `ForbiddenError` when unknown/revoked
  - `revokeDevice(sql, orgId: string, deviceId: string): Promise<void>`
  - `interface HubDevice { id: string; org_id: string; membership_id: string | null; name: string; last_seen_at: string | null; revoked_at: string | null }`

- [ ] **Step 1: Write the failing test**

Create `test/hub-devices.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mintDeviceToken, verifyDeviceToken, revokeDevice } from '../src/hub/devices.js'
import { hubTestSql, seedOrg } from './support/hub-sql.js'

describe('hub device tokens', () => {
  it('mints a verifiable token and never stores it in plaintext', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')

    const { device, token } = await mintDeviceToken(sql, { orgId: 'org_a', name: 'laptop' })
    expect(token).toMatch(/^orchestra_device_v1\./)

    const stored = await sql.query<{ token_hash: string }>('SELECT token_hash FROM devices WHERE id = $1', [device.id])
    expect(stored.rows[0].token_hash).not.toContain(token)

    const verified = await verifyDeviceToken(sql, token)
    expect(verified.id).toBe(device.id)
    expect(verified.org_id).toBe('org_a')
  })

  it('rejects an unknown token', async () => {
    const sql = await hubTestSql()
    await expect(verifyDeviceToken(sql, 'orchestra_device_v1.nonsense')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects a revoked token', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const { device, token } = await mintDeviceToken(sql, { orgId: 'org_a', name: 'laptop' })

    await revokeDevice(sql, 'org_a', device.id)
    await expect(verifyDeviceToken(sql, token)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('will not revoke a device belonging to another org', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedOrg(sql, 'org_b')
    const { device, token } = await mintDeviceToken(sql, { orgId: 'org_a', name: 'laptop' })

    await expect(revokeDevice(sql, 'org_b', device.id)).rejects.toMatchObject({ statusCode: 404 })
    await expect(verifyDeviceToken(sql, token)).resolves.toMatchObject({ id: device.id })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/hub-devices.test.ts`
Expected: FAIL — cannot resolve `../src/hub/devices.js`.

- [ ] **Step 3: Write `src/hub/devices.ts`**

```ts
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { ForbiddenError, NotFoundError } from './errors.js'
import type { HubSql } from './sql.js'
import { boundedString } from './validate.js'

const TOKEN_PREFIX = 'orchestra_device_v1.'

export interface HubDevice {
  id: string
  org_id: string
  membership_id: string | null
  name: string
  last_seen_at: string | null
  revoked_at: string | null
}

export interface MintDeviceInput {
  orgId: string
  membershipId?: string | null
  name: string
}

/**
 * Returns the plaintext token exactly once — only its SHA-256 is stored, so a
 * database read cannot impersonate a daemon.
 */
export async function mintDeviceToken(
  sql: HubSql, input: MintDeviceInput,
): Promise<{ device: HubDevice; token: string }> {
  const name = boundedString(input.name, 'name', 120)
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`

  const inserted = await sql.query<HubDevice>(
    `INSERT INTO devices (id, org_id, membership_id, name, token_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, org_id, membership_id, name, last_seen_at, revoked_at`,
    [`dev_${randomUUID()}`, input.orgId, input.membershipId ?? null, name, hashToken(token)],
  )
  return { device: inserted.rows[0], token }
}

export async function verifyDeviceToken(sql: HubSql, token: string): Promise<HubDevice> {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
    throw new ForbiddenError('device token is not valid')
  }
  const result = await sql.query<HubDevice & { token_hash: string }>(
    `SELECT id, org_id, membership_id, name, last_seen_at, revoked_at, token_hash
     FROM devices WHERE token_hash = $1`,
    [hashToken(token)],
  )
  const device = result.rows[0]
  if (!device || !constantTimeEquals(device.token_hash, hashToken(token))) {
    throw new ForbiddenError('device token is not valid')
  }
  if (device.revoked_at) throw new ForbiddenError('device token has been revoked')

  await sql.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [device.id])
  const { token_hash, ...rest } = device
  return rest
}

export async function revokeDevice(sql: HubSql, orgId: string, deviceId: string): Promise<void> {
  const result = await sql.query(
    'UPDATE devices SET revoked_at = now() WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id',
    [orgId, deviceId],
  )
  if (result.rows.length === 0) throw new NotFoundError('device not found in this org')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/hub-devices.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hub/devices.ts test/hub-devices.test.ts
git commit -m "feat(hub): hashed device tokens with mint, verify, and revoke"
```

---

## Task 5: Mail and presence

**Files:**
- Create: `src/hub/mail.ts`, `src/hub/presence.ts`
- Create: `test/hub-mail.test.ts`, `test/hub-presence.test.ts`

**Interfaces:**
- Consumes: `HubSql`, `withTransaction`, `appendOrgEvent`, error family, `HubMail`/`HubAgent`.
- Produces:
  - `sendMail(sql, input: SendMailInput): Promise<HubMail>` — `{ orgId; boardId; fromAgent; toAgent?: string | null; toHuman?: boolean; subject?: string; body: string; cardId?: string | null; kind?: string; replyTo?: string | null; actorDeviceId?; idempotencyKey? }`
  - `drainInbox(sql, orgId: string, agentName: string): Promise<HubMail[]>` — marks delivered, returns what it delivered
  - `registerAgent(sql, input: { orgId; boardId; deviceId?: string | null; name: string }): Promise<HubAgent>`
  - `heartbeat(sql, input: { orgId; agentId; state: HubAgentState; currentCardId?: string | null; activity?: string | null }): Promise<HubAgent>`
  - `sweepStalePresence(sql, orgId: string, ttlSeconds?: number): Promise<number>` — returns count flipped to `offline`
  - `listAgents(sql, orgId: string, boardId?: string): Promise<HubAgent[]>`

- [ ] **Step 1: Write the failing mail test**

Create `test/hub-mail.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sendMail, drainInbox } from '../src/hub/mail.js'
import { readOrgEventsSince } from '../src/hub/events.js'
import { hubTestSql, seedOrg, seedBoard } from './support/hub-sql.js'

async function board() {
  const sql = await hubTestSql()
  await seedOrg(sql, 'org_a')
  await seedBoard(sql, 'org_a', 'board_1')
  return sql
}

describe('hub mail', () => {
  it('sends agent-to-agent mail across machines and logs mail.sent', async () => {
    const sql = await board()
    const mail = await sendMail(sql, {
      orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent', body: 'who owns #4?',
    })

    expect(mail.to_agent).toBe('bob-agent')
    expect(mail.delivered_at).toBeNull()

    const events = await readOrgEventsSince(sql, 'org_a', 0)
    expect(events.map((e) => e.kind)).toEqual(['mail.sent'])
  })

  it('delivers each message once', async () => {
    const sql = await board()
    await sendMail(sql, { orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent', body: 'one' })
    await sendMail(sql, { orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent', body: 'two' })

    const first = await drainInbox(sql, 'org_a', 'bob-agent')
    expect(first.map((m) => m.body)).toEqual(['one', 'two'])

    const second = await drainInbox(sql, 'org_a', 'bob-agent')
    expect(second).toEqual([])
  })

  it('does not deliver another agent\'s or another org\'s mail', async () => {
    const sql = await board()
    await seedOrg(sql, 'org_b')
    await sendMail(sql, { orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent', body: 'private' })

    expect(await drainInbox(sql, 'org_a', 'carol-agent')).toEqual([])
    expect(await drainInbox(sql, 'org_b', 'bob-agent')).toEqual([])
  })

  it('rejects an empty body', async () => {
    const sql = await board()
    await expect(sendMail(sql, {
      orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent', body: '   ',
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})
```

- [ ] **Step 2: Write the failing presence test**

Create `test/hub-presence.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { registerAgent, heartbeat, sweepStalePresence, listAgents } from '../src/hub/presence.js'
import { readOrgEventsSince } from '../src/hub/events.js'
import { hubTestSql, seedOrg, seedBoard } from './support/hub-sql.js'

async function board() {
  const sql = await hubTestSql()
  await seedOrg(sql, 'org_a')
  await seedBoard(sql, 'org_a', 'board_1')
  return sql
}

describe('hub presence', () => {
  it('registers an agent once and is idempotent by name', async () => {
    const sql = await board()
    const first = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })
    const again = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })

    expect(again.id).toBe(first.id)
    expect((await listAgents(sql, 'org_a')).length).toBe(1)
  })

  it('records state and a one-line activity, not a transcript', async () => {
    const sql = await board()
    const agent = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })

    const beat = await heartbeat(sql, {
      orgId: 'org_a', agentId: agent.id, state: 'working', activity: 'editing src/server.ts',
    })
    expect(beat.state).toBe('working')
    expect(beat.activity).toBe('editing src/server.ts')
    expect(beat.last_heartbeat_at).not.toBeNull()
  })

  it('keeps heartbeats out of the replayable event log', async () => {
    const sql = await board()
    const agent = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })
    await heartbeat(sql, { orgId: 'org_a', agentId: agent.id, state: 'working' })
    await heartbeat(sql, { orgId: 'org_a', agentId: agent.id, state: 'idle' })

    const events = await readOrgEventsSince(sql, 'org_a', 0)
    expect(events.map((e) => e.kind)).toEqual(['agent.registered'])
  })

  it('flips agents offline once heartbeats lapse past the TTL', async () => {
    const sql = await board()
    const agent = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })
    await heartbeat(sql, { orgId: 'org_a', agentId: agent.id, state: 'working' })

    // Backdate the heartbeat rather than sleeping — tests must stay fast and deterministic.
    await sql.query("UPDATE agents SET last_heartbeat_at = now() - interval '5 minutes' WHERE id = $1", [agent.id])

    const swept = await sweepStalePresence(sql, 'org_a', 45)
    expect(swept).toBe(1)
    expect((await listAgents(sql, 'org_a'))[0].state).toBe('offline')
  })
})
```

- [ ] **Step 3: Run both and confirm they fail**

Run: `npx vitest run test/hub-mail.test.ts test/hub-presence.test.ts`
Expected: FAIL — cannot resolve `../src/hub/mail.js` and `../src/hub/presence.js`.

- [ ] **Step 4: Write `src/hub/mail.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { appendOrgEvent } from './events.js'
import { NotFoundError } from './errors.js'
import { withTransaction, type HubSql, type HubSqlPool } from './sql.js'
import { boundedString, optionalBoundedString } from './validate.js'
import type { HubMail } from './types.js'

export interface SendMailInput {
  orgId: string; boardId: string; fromAgent: string
  toAgent?: string | null; toHuman?: boolean
  subject?: string; body: string
  cardId?: string | null; kind?: string; replyTo?: string | null
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

export async function sendMail(sql: HubSqlPool, input: SendMailInput): Promise<HubMail> {
  const body = boundedString(input.body, 'body', 100_000)
  const fromAgent = boundedString(input.fromAgent, 'from_agent', 120)
  const toAgent = optionalBoundedString(input.toAgent, 'to_agent', 120) ?? null
  const subject = optionalBoundedString(input.subject, 'subject', 200) ?? null
  const kind = optionalBoundedString(input.kind, 'kind', 40) ?? 'ask'

  return withTransaction(sql, async (tx) => {
    const board = await tx.query('SELECT id FROM boards WHERE org_id = $1 AND id = $2', [input.orgId, input.boardId])
    if (!board.rows[0]) throw new NotFoundError('board not found in this org')

    const inserted = await tx.query<HubMail>(
      `INSERT INTO mail (id, org_id, board_id, card_id, kind, subject, body, from_agent, to_agent, to_human, reply_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [`mail_${randomUUID()}`, input.orgId, input.boardId, input.cardId ?? null, kind, subject, body,
       fromAgent, toAgent, input.toHuman ?? false, input.replyTo ?? null],
    )
    const mail = inserted.rows[0]

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'mail.sent', boardId: input.boardId,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey, payload: mail,
    })
    return mail
  })
}

/**
 * Marks and returns this agent's undelivered mail in one statement, so two
 * concurrent drains by the same agent on two machines cannot both take a message.
 */
export async function drainInbox(sql: HubSql, orgId: string, agentName: string): Promise<HubMail[]> {
  const result = await sql.query<HubMail>(
    `UPDATE mail SET delivered_at = now()
     WHERE org_id = $1 AND to_agent = $2 AND delivered_at IS NULL
     RETURNING *`,
    [orgId, agentName],
  )
  return [...result.rows].sort((a, b) => a.created_at.localeCompare(b.created_at))
}
```

- [ ] **Step 5: Write `src/hub/presence.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { appendOrgEvent } from './events.js'
import { NotFoundError } from './errors.js'
import { withTransaction, type HubSql, type HubSqlPool } from './sql.js'
import { boundedString, optionalBoundedString } from './validate.js'
import type { HubAgent, HubAgentState } from './types.js'

const DEFAULT_TTL_SECONDS = 45

export interface RegisterAgentInput {
  orgId: string; boardId: string; name: string; deviceId?: string | null
}

export interface HeartbeatInput {
  orgId: string; agentId: string; state: HubAgentState
  currentCardId?: string | null; activity?: string | null
}

export async function registerAgent(sql: HubSqlPool, input: RegisterAgentInput): Promise<HubAgent> {
  const name = boundedString(input.name, 'name', 120)

  return withTransaction(sql, async (tx) => {
    const board = await tx.query('SELECT id FROM boards WHERE org_id = $1 AND id = $2', [input.orgId, input.boardId])
    if (!board.rows[0]) throw new NotFoundError('board not found in this org')

    const existing = await tx.query<HubAgent>(
      'SELECT * FROM agents WHERE org_id = $1 AND board_id = $2 AND name = $3',
      [input.orgId, input.boardId, name],
    )
    if (existing.rows[0]) return normalize(existing.rows[0])

    const inserted = await tx.query<HubAgent>(
      `INSERT INTO agents (id, org_id, board_id, device_id, name)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [`agent_${randomUUID()}`, input.orgId, input.boardId, input.deviceId ?? null, name],
    )
    const agent = normalize(inserted.rows[0])

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'agent.registered', boardId: input.boardId,
      actorDeviceId: input.deviceId ?? null, payload: agent,
    })
    return agent
  })
}

/**
 * Presence is latest-state-only and deliberately does NOT append to `org_events`:
 * a heartbeat every 15s per agent would swamp the replayable log for no benefit.
 * Live viewers get presence from the SSE presence frame instead.
 */
export async function heartbeat(sql: HubSql, input: HeartbeatInput): Promise<HubAgent> {
  const activity = optionalBoundedString(input.activity, 'activity', 200) ?? null
  const result = await sql.query<HubAgent>(
    `UPDATE agents SET state = $3, current_card_id = $4, activity = $5, last_heartbeat_at = now()
     WHERE org_id = $1 AND id = $2 RETURNING *`,
    [input.orgId, input.agentId, input.state, input.currentCardId ?? null, activity],
  )
  if (!result.rows[0]) throw new NotFoundError('agent not found in this org')
  return normalize(result.rows[0])
}

/** Flips agents whose heartbeat has lapsed to `offline`. Returns how many changed. */
export async function sweepStalePresence(
  sql: HubSql, orgId: string, ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<number> {
  const result = await sql.query(
    `UPDATE agents SET state = 'offline'
     WHERE org_id = $1 AND state <> 'offline'
       AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - ($2 || ' seconds')::interval)
     RETURNING id`,
    [orgId, ttlSeconds],
  )
  return result.rows.length
}

export async function listAgents(sql: HubSql, orgId: string, boardId?: string): Promise<HubAgent[]> {
  const result = boardId
    ? await sql.query<HubAgent>('SELECT * FROM agents WHERE org_id = $1 AND board_id = $2 ORDER BY name', [orgId, boardId])
    : await sql.query<HubAgent>('SELECT * FROM agents WHERE org_id = $1 ORDER BY name', [orgId])
  return result.rows.map(normalize)
}

function normalize(row: any): HubAgent {
  return {
    id: row.id, org_id: row.org_id, board_id: row.board_id, device_id: row.device_id,
    name: row.name, state: row.state, current_card_id: row.current_card_id,
    activity: row.activity, last_heartbeat_at: row.last_heartbeat_at,
  }
}
```

- [ ] **Step 6: Run both tests and confirm they pass**

Run: `npx vitest run test/hub-mail.test.ts test/hub-presence.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add src/hub test/hub-mail.test.ts test/hub-presence.test.ts
git commit -m "feat(hub): org-scoped mail delivery and agent presence with TTL sweep"
```

---

## Task 6: The hub Fastify app — auth, org scoping, ops endpoint

**Files:**
- Create: `src/hub/server.ts`, `src/hub/routes/ops.ts`, `src/hub/index.ts`
- Create: `test/support/hub-fixture.ts`, `test/hub-server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces:
  - `buildHubServer(sql: HubSqlPool, opts?: HubServerOptions): FastifyInstance`
  - `interface HubServerOptions { presenceTtlSeconds?: number }`
  - Fastify request decorations: `request.hubDevice: HubDevice | null`, `request.hubOrgId: string | null`
  - Routes, all under `/api/v1/hub`: `POST /orgs/:orgId/ops`, `GET /orgs/:orgId/cards`, `GET /orgs/:orgId/agents`, `GET /orgs/:orgId/mail/inbox`
  - Op envelope: `{ op: string; idempotency_key?: string; payload: object }` where `op` ∈ `card.create | card.update | card.move | card.claim | mail.send | agent.register | agent.heartbeat`

- [ ] **Step 1: Write the test fixture**

Create `test/support/hub-fixture.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { buildHubServer } from '../../src/hub/server.js'
import { mintDeviceToken } from '../../src/hub/devices.js'
import { hubTestSql, seedOrg, seedBoard } from './hub-sql.js'
import type { HubSqlPool } from '../../src/hub/sql.js'

export interface HubFixture {
  sql: HubSqlPool
  server: FastifyInstance
  orgId: string
  boardId: string
  token: string
  auth: (token?: string) => Record<string, string>
}

const servers: FastifyInstance[] = []

/** Every test gets its own migrated database, org, board, and device token. */
export async function hubFixture(): Promise<HubFixture> {
  const sql = (await hubTestSql()) as HubSqlPool
  await seedOrg(sql, 'org_a')
  await seedBoard(sql, 'org_a', 'board_1')
  const { token } = await mintDeviceToken(sql, { orgId: 'org_a', name: 'test-laptop' })

  const server = buildHubServer(sql)
  servers.push(server)
  await server.ready()

  return {
    sql, server, orgId: 'org_a', boardId: 'board_1', token,
    auth: (override?: string) => ({ authorization: `Bearer ${override ?? token}` }),
  }
}

export async function closeHubServers(): Promise<void> {
  for (const server of servers.splice(0)) await server.close()
}
```

- [ ] **Step 2: Write the failing server test**

Create `test/hub-server.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { hubFixture, closeHubServers } from './support/hub-fixture.js'
import { mintDeviceToken } from '../src/hub/devices.js'
import { seedOrg } from './support/hub-sql.js'

afterEach(async () => { await closeHubServers() })

describe('hub server', () => {
  it('rejects an unauthenticated op', async () => {
    const hub = await hubFixture()
    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`,
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'x' } },
    })
    expect(response.statusCode).toBe(403)
  })

  it('creates a card through the ops endpoint', async () => {
    const hub = await hubFixture()
    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'Ship the hub' } },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.result.title).toBe('Ship the hub')
    expect(body.result.version).toBe(1)
    expect(body.seq).toBe(1)
  })

  it('refuses a device token minted for a different org', async () => {
    const hub = await hubFixture()
    await seedOrg(hub.sql, 'org_b')
    const other = await mintDeviceToken(hub.sql, { orgId: 'org_b', name: 'intruder' })

    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(other.token),
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'Cross-org' } },
    })
    expect(response.statusCode).toBe(403)
  })

  it('returns 409 with current state when two devices race a claim', async () => {
    const hub = await hubFixture()
    const created = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'Contested' } },
    })
    const cardId = created.json().result.id

    const first = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.claim', payload: { card_id: cardId, agent: 'agent-one' } },
    })
    expect(first.statusCode).toBe(200)

    const second = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.claim', payload: { card_id: cardId, agent: 'agent-two' } },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json().code).toBe('conflict')
    expect(second.json().current.owner_agent).toBe('agent-one')
  })

  it('applies a replayed idempotency key exactly once', async () => {
    const hub = await hubFixture()
    const op = {
      op: 'card.create', idempotency_key: 'queued-op-1',
      payload: { board_id: hub.boardId, title: 'Replayed' },
    }
    const first = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(), payload: op,
    })
    const second = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(), payload: op,
    })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)

    const cards = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`, headers: hub.auth(),
    })
    expect(cards.json().cards.filter((c: any) => c.title === 'Replayed').length).toBe(1)
  })

  it('rejects an unknown op name', async () => {
    const hub = await hubFixture()
    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.delete_everything', payload: {} },
    })
    expect(response.statusCode).toBe(400)
  })
})
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run test/hub-server.test.ts`
Expected: FAIL — cannot resolve `../src/hub/server.js`.

- [ ] **Step 4: Write `src/hub/routes/ops.ts`**

```ts
import type { FastifyPluginAsync, FastifyPluginOptions, FastifyRequest } from 'fastify'
import { claimCard, createCard, moveCard, updateCard } from '../cards.js'
import { latestOrgSeq } from '../events.js'
import { drainInbox, sendMail } from '../mail.js'
import { heartbeat, listAgents, registerAgent } from '../presence.js'
import { HubError, ValidationError } from '../errors.js'
import type { HubSqlPool } from '../sql.js'

export interface HubOpsRouteOptions extends FastifyPluginOptions {
  sql: HubSqlPool
}

/** Every op a daemon can issue. Anything not listed here is a 400, not a 404. */
const OPS = new Set([
  'card.create', 'card.update', 'card.move', 'card.claim',
  'mail.send', 'agent.register', 'agent.heartbeat',
])

export const hubOpsPlugin: FastifyPluginAsync<HubOpsRouteOptions> = async (app, options) => {
  const { sql } = options

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HubError) {
      const body: Record<string, unknown> = { error: error.message, code: error.code }
      if ('current' in error && (error as any).current !== undefined) body.current = (error as any).current
      return reply.code(error.statusCode).send(body)
    }
    app.log.error(error)
    return reply.code(500).send({ error: 'internal error', code: 'internal_error' })
  })

  app.post('/orgs/:orgId/ops', async (request: FastifyRequest, reply) => {
    const orgId = requireOrg(request)
    const body = (request.body ?? {}) as Record<string, any>
    const op = typeof body.op === 'string' ? body.op : ''
    if (!OPS.has(op)) throw new ValidationError(`unknown op: ${op || '(missing)'}`)

    const payload = (body.payload ?? {}) as Record<string, any>
    const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : null
    const actorDeviceId = request.hubDevice?.id ?? null
    const common = { orgId, actorDeviceId, idempotencyKey }

    const result = await runOp(op, payload, common, sql)
    return reply.send({ result, seq: await latestOrgSeq(sql, orgId) })
  })

  app.get('/orgs/:orgId/cards', async (request, reply) => {
    const orgId = requireOrg(request)
    const cards = await sql.query('SELECT * FROM cards WHERE org_id = $1 ORDER BY number', [orgId])
    return reply.send({ cards: cards.rows.map((row: any) => ({ ...row, column: row.column_name })) })
  })

  app.get('/orgs/:orgId/agents', async (request, reply) => {
    return reply.send({ agents: await listAgents(sql, requireOrg(request)) })
  })

  app.get('/orgs/:orgId/mail/inbox', async (request, reply) => {
    const orgId = requireOrg(request)
    const agent = (request.query as any)?.agent
    if (typeof agent !== 'string' || !agent) throw new ValidationError('agent query parameter is required')
    return reply.send({ messages: await drainInbox(sql, orgId, agent) })
  })
}

async function runOp(
  op: string, payload: Record<string, any>,
  common: { orgId: string; actorDeviceId: string | null; idempotencyKey: string | null },
  sql: HubSqlPool,
): Promise<unknown> {
  switch (op) {
    case 'card.create':
      return createCard(sql, {
        ...common, boardId: payload.board_id, title: payload.title,
        description: payload.description, paths: payload.paths, ownerAgent: payload.owner_agent ?? null,
      })
    case 'card.update':
      return updateCard(sql, {
        ...common, cardId: payload.card_id, expectedVersion: payload.expected_version,
        title: payload.title, description: payload.description, paths: payload.paths,
      })
    case 'card.move':
      return moveCard(sql, {
        ...common, cardId: payload.card_id, expectedVersion: payload.expected_version, column: payload.column,
      })
    case 'card.claim':
      return claimCard(sql, { ...common, cardId: payload.card_id, agent: payload.agent })
    case 'mail.send':
      return sendMail(sql, {
        ...common, boardId: payload.board_id, fromAgent: payload.from_agent,
        toAgent: payload.to_agent ?? null, toHuman: payload.to_human ?? false,
        subject: payload.subject, body: payload.body, cardId: payload.card_id ?? null,
        kind: payload.kind, replyTo: payload.reply_to ?? null,
      })
    case 'agent.register':
      return registerAgent(sql, {
        orgId: common.orgId, boardId: payload.board_id, name: payload.name, deviceId: common.actorDeviceId,
      })
    case 'agent.heartbeat':
      return heartbeat(sql, {
        orgId: common.orgId, agentId: payload.agent_id, state: payload.state,
        currentCardId: payload.current_card_id ?? null, activity: payload.activity ?? null,
      })
    default:
      throw new ValidationError(`unknown op: ${op}`)
  }
}

function requireOrg(request: FastifyRequest): string {
  const orgId = request.hubOrgId
  if (!orgId) throw new ValidationError('org scope was not resolved')
  return orgId
}
```

- [ ] **Step 5: Write `src/hub/server.ts`**

```ts
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { hubOpsPlugin } from './routes/ops.js'
import { verifyDeviceToken, type HubDevice } from './devices.js'
import { ForbiddenError, HubError } from './errors.js'
import type { HubSqlPool } from './sql.js'

declare module 'fastify' {
  interface FastifyRequest {
    hubDevice: HubDevice | null
    hubOrgId: string | null
  }
}

export interface HubServerOptions {
  presenceTtlSeconds?: number
}

/**
 * The hub's own Fastify app. It deliberately does NOT reuse `buildServer()` from
 * src/server.ts: that factory takes a synchronous better-sqlite3 handle and is
 * single-tenant by construction. Conventions are shared; code is not.
 */
export function buildHubServer(sql: HubSqlPool, opts: HubServerOptions = {}): FastifyInstance {
  const server = Fastify()
  server.decorateRequest('hubDevice', null)
  server.decorateRequest('hubOrgId', null)

  /**
   * One place resolves identity and org scope. Handlers read `request.hubOrgId`
   * and never take an org id from the body — cross-org access is therefore not a
   * mistake a route author can make.
   */
  server.addHook('onRequest', async (request: FastifyRequest, reply) => {
    reply.header('cache-control', 'no-store')
    if (!request.url.startsWith('/api/v1/hub/')) return

    const header = request.headers.authorization
    const token = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : ''
    if (!token) {
      return reply.code(403).send({ error: 'device token is required', code: 'forbidden' })
    }

    let device: HubDevice
    try {
      device = await verifyDeviceToken(sql, token)
    } catch (error) {
      const status = error instanceof HubError ? error.statusCode : 403
      const message = error instanceof HubError ? error.message : 'device token is not valid'
      return reply.code(status).send({ error: message, code: 'forbidden' })
    }

    const requestedOrg = (request.params as any)?.orgId
    if (typeof requestedOrg === 'string' && requestedOrg !== device.org_id) {
      return reply.code(403).send({ error: 'device is not a member of this org', code: 'forbidden' })
    }

    request.hubDevice = device
    request.hubOrgId = device.org_id
  })

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof HubError) {
      const body: Record<string, unknown> = { error: error.message, code: error.code }
      if ('current' in error && (error as any).current !== undefined) body.current = (error as any).current
      return reply.code(error.statusCode).send(body)
    }
    server.log.error(error)
    return reply.code(500).send({ error: 'internal error', code: 'internal_error' })
  })

  server.register(hubOpsPlugin, { sql, prefix: '/api/v1/hub' })
  server.get('/healthz', async () => ({ ok: true, presence_ttl_seconds: opts.presenceTtlSeconds ?? 45 }))

  return server
}
```

Note the `onRequest` hook reads `request.params` — Fastify populates params before `onRequest` only for routes it has matched, which it has by that point in the lifecycle. Keep the org check here rather than per-route so no future route can forget it.

- [ ] **Step 6: Write `src/hub/index.ts`**

```ts
export { buildHubServer, type HubServerOptions } from './server.js'
export { hubMigrate, HUB_MIGRATIONS } from './migrations.js'
export { withTransaction, type HubSql, type HubSqlPool } from './sql.js'
export * from './types.js'
export { HubError, ValidationError, ForbiddenError, NotFoundError, ConflictError } from './errors.js'
export { mintDeviceToken, verifyDeviceToken, revokeDevice, type HubDevice } from './devices.js'
export { createCard, updateCard, moveCard, claimCard, getCard } from './cards.js'
export { sendMail, drainInbox } from './mail.js'
export { registerAgent, heartbeat, sweepStalePresence, listAgents } from './presence.js'
export { appendOrgEvent, readOrgEventsSince, latestOrgSeq } from './events.js'
```

- [ ] **Step 7: Run the test and confirm it passes**

Run: `npx vitest run test/hub-server.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Commit**

```bash
git add src/hub test/hub-server.test.ts test/support/hub-fixture.ts
git commit -m "feat(hub): fastify app with device auth, org scoping, and the ops endpoint"
```

---

## Task 7: The SSE sync stream with resume

**Files:**
- Create: `src/hub/routes/sync.ts`, `src/hub/broadcast.ts`
- Modify: `src/hub/server.ts` (register the sync plugin, construct the broadcaster), `src/hub/routes/ops.ts` (publish after a successful op), `src/hub/index.ts` (export)
- Create: `test/hub-sync.test.ts`

**Interfaces:**
- Consumes: `readOrgEventsSince`, `latestOrgSeq`, `HubEvent`, `buildHubServer`.
- Produces:
  - `class HubBroadcaster { subscribe(orgId: string, listener: (event: HubEvent) => void): () => void; publish(event: HubEvent): void }`
  - Route `GET /api/v1/hub/orgs/:orgId/sync?since=<seq>` — SSE, replays backlog then streams live
  - `HubOpsRouteOptions` gains `broadcast: HubBroadcaster`

- [ ] **Step 1: Write the failing test**

Create `test/hub-sync.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { hubFixture, closeHubServers } from './support/hub-fixture.js'
import { createCard } from '../src/hub/cards.js'

afterEach(async () => { await closeHubServers() })

/** Pulls the `data:` lines out of an SSE body. */
function sseEvents(body: string): any[] {
  return body.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)))
}

describe('hub sync stream', () => {
  it('replays the backlog from since= and closes when asked to catch up only', async () => {
    const hub = await hubFixture()
    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'One' })
    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'Two' })
    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'Three' })

    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/sync?since=1&catchup=1`, headers: hub.auth(),
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = sseEvents(response.body)
    expect(events.map((e) => e.seq)).toEqual([2, 3])
    expect(events.every((e) => e.org_id === hub.orgId)).toBe(true)
  })

  it('replays nothing when the daemon is already current', async () => {
    const hub = await hubFixture()
    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'One' })

    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/sync?since=1&catchup=1`, headers: hub.auth(),
    })
    expect(sseEvents(response.body)).toEqual([])
  })

  it('refuses a stream for another org', async () => {
    const hub = await hubFixture()
    const { mintDeviceToken } = await import('../src/hub/devices.js')
    const { seedOrg } = await import('./support/hub-sql.js')
    await seedOrg(hub.sql, 'org_b')
    const other = await mintDeviceToken(hub.sql, { orgId: 'org_b', name: 'intruder' })

    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/sync?since=0&catchup=1`,
      headers: hub.auth(other.token),
    })
    expect(response.statusCode).toBe(403)
  })

  it('rejects a non-numeric since', async () => {
    const hub = await hubFixture()
    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/sync?since=banana&catchup=1`, headers: hub.auth(),
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('hub broadcaster', () => {
  it('delivers a live event to the right org only', async () => {
    const { HubBroadcaster } = await import('../src/hub/broadcast.js')
    const broadcaster = new HubBroadcaster()
    const seenA: any[] = []
    const seenB: any[] = []

    const unsubscribe = broadcaster.subscribe('org_a', (event) => seenA.push(event))
    broadcaster.subscribe('org_b', (event) => seenB.push(event))

    broadcaster.publish({ id: 'e1', org_id: 'org_a', seq: 1, kind: 'card.created',
      board_id: null, actor_device_id: null, payload: {}, created_at: 'now' })

    expect(seenA.length).toBe(1)
    expect(seenB.length).toBe(0)

    unsubscribe()
    broadcaster.publish({ id: 'e2', org_id: 'org_a', seq: 2, kind: 'card.created',
      board_id: null, actor_device_id: null, payload: {}, created_at: 'now' })
    expect(seenA.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/hub-sync.test.ts`
Expected: FAIL — cannot resolve `../src/hub/broadcast.js`.

- [ ] **Step 3: Write `src/hub/broadcast.ts`**

```ts
import { EventEmitter } from 'node:events'
import type { HubEvent } from './types.js'

/**
 * In-process fan-out to the SSE streams attached to this instance. The durable
 * ordering guarantee lives in `org_events`, not here: a client that misses a live
 * frame recovers by reconnecting with `?since=`, so losing a broadcast is never
 * data loss. Multi-instance deployments add Postgres LISTEN/NOTIFY behind this
 * same interface (Plan 3, if a second instance is ever needed).
 */
export class HubBroadcaster {
  private readonly emitter = new EventEmitter()

  constructor() {
    // One listener per connected daemon per org; the default cap of 10 is too low.
    this.emitter.setMaxListeners(0)
  }

  subscribe(orgId: string, listener: (event: HubEvent) => void): () => void {
    const channel = `org:${orgId}`
    this.emitter.on(channel, listener)
    return () => { this.emitter.off(channel, listener) }
  }

  publish(event: HubEvent): void {
    this.emitter.emit(`org:${event.org_id}`, event)
  }
}
```

- [ ] **Step 4: Write `src/hub/routes/sync.ts`**

```ts
import type { FastifyPluginAsync, FastifyPluginOptions } from 'fastify'
import { readOrgEventsSince } from '../events.js'
import { ValidationError } from '../errors.js'
import type { HubBroadcaster } from '../broadcast.js'
import type { HubSqlPool } from '../sql.js'
import type { HubEvent } from '../types.js'

export interface HubSyncRouteOptions extends FastifyPluginOptions {
  sql: HubSqlPool
  broadcast: HubBroadcaster
  heartbeatMs?: number
}

const BACKLOG_PAGE = 500

export const hubSyncPlugin: FastifyPluginAsync<HubSyncRouteOptions> = async (app, options) => {
  const { sql, broadcast } = options
  const heartbeatMs = options.heartbeatMs ?? 25_000

  app.get('/orgs/:orgId/sync', async (request, reply) => {
    const orgId = request.hubOrgId
    if (!orgId) throw new ValidationError('org scope was not resolved')

    const query = (request.query ?? {}) as Record<string, string>
    const since = parseSince(query.since)
    // `catchup=1` drains the backlog and ends the response — this is how tests and
    // one-shot resyncs avoid holding an open stream.
    const catchupOnly = query.catchup === '1'

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })

    const write = (event: HubEvent) => {
      reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
    }

    // Drain the durable backlog first so the client is never handed a live frame
    // that sits ahead of events it has not seen.
    let cursor = since
    for (;;) {
      const page = await readOrgEventsSince(sql, orgId, cursor, BACKLOG_PAGE)
      if (page.length === 0) break
      for (const event of page) write(event)
      cursor = page[page.length - 1].seq
      if (page.length < BACKLOG_PAGE) break
    }

    if (catchupOnly) {
      reply.raw.end()
      return reply
    }

    // Live tail. Frames at or below the drained cursor are dropped so a backlog
    // page and a live publish cannot deliver the same seq twice.
    const unsubscribe = broadcast.subscribe(orgId, (event) => {
      if (event.seq <= cursor) return
      cursor = event.seq
      write(event)
    })
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), heartbeatMs)

    request.raw.on('close', () => {
      clearInterval(ping)
      unsubscribe()
    })

    return reply
  })
}

function parseSince(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new ValidationError('since must be a non-negative integer')
  return value
}
```

- [ ] **Step 5: Publish events from the ops endpoint**

In `src/hub/routes/ops.ts`, add `broadcast` to the options interface and publish the events an op produced. Replace the interface and the ops handler body:

```ts
import { latestOrgSeq, readOrgEventsSince } from '../events.js'
import type { HubBroadcaster } from '../broadcast.js'

export interface HubOpsRouteOptions extends FastifyPluginOptions {
  sql: HubSqlPool
  broadcast: HubBroadcaster
}
```

```ts
  app.post('/orgs/:orgId/ops', async (request: FastifyRequest, reply) => {
    const orgId = requireOrg(request)
    const body = (request.body ?? {}) as Record<string, any>
    const op = typeof body.op === 'string' ? body.op : ''
    if (!OPS.has(op)) throw new ValidationError(`unknown op: ${op || '(missing)'}`)

    const payload = (body.payload ?? {}) as Record<string, any>
    const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : null
    const actorDeviceId = request.hubDevice?.id ?? null

    const before = await latestOrgSeq(sql, orgId)
    const result = await runOp(op, payload, { orgId, actorDeviceId, idempotencyKey }, sql)
    const after = await latestOrgSeq(sql, orgId)

    // Publish whatever the op actually appended (zero events for a replayed key).
    for (const event of await readOrgEventsSince(sql, orgId, before)) options.broadcast.publish(event)

    return reply.send({ result, seq: after })
  })
```

- [ ] **Step 6: Wire the broadcaster into `src/hub/server.ts`**

```ts
import { HubBroadcaster } from './broadcast.js'
import { hubSyncPlugin } from './routes/sync.js'
```

Replace the plugin registration line with:

```ts
  const broadcast = new HubBroadcaster()
  server.register(hubOpsPlugin, { sql, broadcast, prefix: '/api/v1/hub' })
  server.register(hubSyncPlugin, { sql, broadcast, prefix: '/api/v1/hub' })
```

- [ ] **Step 7: Export the broadcaster**

Add to `src/hub/index.ts`:

```ts
export { HubBroadcaster } from './broadcast.js'
```

- [ ] **Step 8: Run the sync test and confirm it passes**

Run: `npx vitest run test/hub-sync.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Run every hub test together**

Run: `npx vitest run test/hub-*.test.ts`
Expected: PASS (35 tests across 8 files).

- [ ] **Step 10: Commit**

```bash
git add src/hub test/hub-sync.test.ts
git commit -m "feat(hub): SSE sync stream with seq resume and live broadcast"
```

---

## Task 8: `orchestra hub` command and Postgres wiring

**Files:**
- Create: `src/hub/pg.ts`, `src/hub-cli.ts`
- Modify: `src/cli.ts` (register the command)
- Create: `test/hub-cli.test.ts`

**Interfaces:**
- Consumes: `buildHubServer`, `hubMigrate`, `HubSqlPool`.
- Produces:
  - `createPgPool(connectionString: string): HubSqlPool & { end(): Promise<void> }`
  - `registerHubCommands(program: Command, deps?: HubCliDeps): void` where `interface HubCliDeps { startHub?: (opts: { port: number; databaseUrl: string }) => Promise<void>; output?: (line: string) => void; env?: NodeJS.ProcessEnv }`

- [ ] **Step 1: Write the failing test**

Create `test/hub-cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Command } from 'commander'
import { registerHubCommands } from '../src/hub-cli.js'

describe('orchestra hub command', () => {
  it('starts the hub on the configured port and database', async () => {
    const started: any[] = []
    const program = new Command()
    program.exitOverride()
    registerHubCommands(program, {
      startHub: async (opts) => { started.push(opts) },
      output: () => {},
      env: { HUB_DATABASE_URL: 'postgres://example/hub' },
    })

    await program.parseAsync(['node', 'orchestra', 'hub', '--port', '5150'])

    expect(started).toEqual([{ port: 5150, databaseUrl: 'postgres://example/hub' }])
  })

  it('fails clearly when no database URL is configured', async () => {
    const lines: string[] = []
    const program = new Command()
    program.exitOverride()
    registerHubCommands(program, {
      startHub: async () => { throw new Error('should not start') },
      output: (line) => lines.push(line),
      env: {},
    })

    await expect(program.parseAsync(['node', 'orchestra', 'hub'])).rejects.toThrow(/DATABASE_URL/i)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/hub-cli.test.ts`
Expected: FAIL — cannot resolve `../src/hub-cli.js`.

- [ ] **Step 3: Write `src/hub/pg.ts`**

```ts
import pg from 'pg'
import type { HubSqlConnection, HubSqlPool } from './sql.js'

/**
 * Production storage. Supabase's session pooler is the right endpoint here — the
 * hub is a long-lived server holding transactions, not a serverless function.
 */
export function createPgPool(connectionString: string): HubSqlPool & { end(): Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 10 })

  return {
    query: async (text, params) => {
      const result = await pool.query(text, params ? [...params] : undefined)
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }
    },
    connect: async (): Promise<HubSqlConnection> => {
      const client = await pool.connect()
      return {
        query: async (text, params) => {
          const result = await client.query(text, params ? [...params] : undefined)
          return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }
        },
        release: () => client.release(),
      }
    },
    end: () => pool.end(),
  }
}
```

- [ ] **Step 4: Write `src/hub-cli.ts`**

```ts
import type { Command } from 'commander'

export interface HubCliDeps {
  startHub?: (opts: { port: number; databaseUrl: string }) => Promise<void>
  output?: (line: string) => void
  env?: NodeJS.ProcessEnv
}

/**
 * `orchestra hub` runs the hosted server. It is deliberately separate from
 * `orchestra serve` (the local daemon): different storage, different tenancy,
 * different lifecycle.
 */
export function registerHubCommands(program: Command, deps: HubCliDeps = {}): void {
  const output = deps.output ?? ((line: string) => console.log(line))
  const env = deps.env ?? process.env

  program
    .command('hub')
    .description('run the hosted multi-org hub server')
    .option('--port <port>', 'port to listen on', '4760')
    .action(async (options: { port: string }) => {
      const databaseUrl = env.HUB_DATABASE_URL ?? env.DATABASE_URL
      if (!databaseUrl) {
        throw new Error('HUB_DATABASE_URL (or DATABASE_URL) must be set to run the hub')
      }
      const port = Number(options.port)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`--port must be a valid port number, got ${options.port}`)
      }

      const start = deps.startHub ?? defaultStartHub
      output(`orchestra hub starting on port ${port}`)
      await start({ port, databaseUrl })
    })
}

async function defaultStartHub(opts: { port: number; databaseUrl: string }): Promise<void> {
  const { createPgPool } = await import('./hub/pg.js')
  const { hubMigrate } = await import('./hub/migrations.js')
  const { buildHubServer } = await import('./hub/server.js')

  const sql = createPgPool(opts.databaseUrl)
  const applied = await hubMigrate(sql)
  if (applied.length > 0) console.log(`applied hub migrations: ${applied.join(', ')}`)

  const server = buildHubServer(sql)
  await server.listen({ host: '0.0.0.0', port: opts.port })
}
```

- [ ] **Step 5: Register the command in `src/cli.ts`**

Add the import beside the other `register*` imports near the top of the file:

```ts
import { registerHubCommands } from './hub-cli.js'
```

Then add the registration alongside the existing ones (next to `registerDoctorCommand(program)`, around line 913):

```ts
registerHubCommands(program)
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `npx vitest run test/hub-cli.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Verify the CLI compiles and the command is listed**

Run: `npx tsx src/cli.ts --help`
Expected: the command list includes `hub  run the hosted multi-org hub server`.

- [ ] **Step 8: Commit**

```bash
git add src/hub src/hub-cli.ts src/cli.ts test/hub-cli.test.ts
git commit -m "feat(hub): orchestra hub command and postgres pool wiring"
```

---

## Task 9: Documentation inventory and cross-org threat entries

The repo's docs tests fail if new routes, tables, or CLI commands are not recorded. This task is not optional bookkeeping — `npx vitest run test/agent-os-baseline-docs.test.ts` is a gate.

**Files:**
- Modify: `docs/agent-os-surface-inventory.json`, `docs/agent-os-surface-inventory.md`
- Modify: `docs/remote-mobile-threat-control-matrix.json`
- Create: `test/hub-cross-org-isolation.test.ts`

**Interfaces:**
- Consumes: `hubFixture`, all hub ops.
- Produces: no code interfaces; produces the executable evidence the threat matrix cites.

- [ ] **Step 1: Write the cross-org isolation test**

This is the evidence a new trust boundary needs. Create `test/hub-cross-org-isolation.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { hubFixture, closeHubServers } from './support/hub-fixture.js'
import { seedOrg, seedBoard } from './support/hub-sql.js'
import { mintDeviceToken } from '../src/hub/devices.js'
import { createCard } from '../src/hub/cards.js'
import { sendMail } from '../src/hub/mail.js'

afterEach(async () => { await closeHubServers() })

describe('hub cross-org isolation', () => {
  it('a device token cannot read, write, or stream another org', async () => {
    const hub = await hubFixture()
    await seedOrg(hub.sql, 'org_b')
    await seedBoard(hub.sql, 'org_b', 'board_b')
    const intruder = await mintDeviceToken(hub.sql, { orgId: 'org_b', name: 'intruder' })

    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'Confidential' })
    await sendMail(hub.sql, {
      orgId: hub.orgId, boardId: hub.boardId, fromAgent: 'alice-agent', toAgent: 'bob-agent', body: 'secret',
    })

    const headers = { authorization: `Bearer ${intruder.token}` }
    const attempts = [
      hub.server.inject({ method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`, headers }),
      hub.server.inject({ method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/agents`, headers }),
      hub.server.inject({ method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/mail/inbox?agent=bob-agent`, headers }),
      hub.server.inject({ method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/sync?since=0&catchup=1`, headers }),
      hub.server.inject({
        method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers,
        payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'Injected' } },
      }),
    ]

    for (const response of await Promise.all(attempts)) {
      expect(response.statusCode).toBe(403)
    }
  })

  it('an org-scoped read never returns another org\'s rows even with a valid token', async () => {
    const hub = await hubFixture()
    await seedOrg(hub.sql, 'org_b')
    await seedBoard(hub.sql, 'org_b', 'board_b')
    await createCard(hub.sql, { orgId: 'org_b', boardId: 'board_b', title: 'Other org card' })
    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'My card' })

    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`, headers: hub.auth(),
    })
    const titles = response.json().cards.map((c: any) => c.title)
    expect(titles).toEqual(['My card'])
  })
})
```

- [ ] **Step 2: Run it and confirm it passes**

Run: `npx vitest run test/hub-cross-org-isolation.test.ts`
Expected: PASS (2 tests). If either fails, the org-scoping hook in `src/hub/server.ts` has a hole — fix that before continuing.

- [ ] **Step 3: Add hub routes to the surface inventory JSON**

In `docs/agent-os-surface-inventory.json`, add these five entries to `route_sources.http_routes.canonical`, keeping the array sorted:

```
"GET /api/v1/hub/orgs/:orgId/agents",
"GET /api/v1/hub/orgs/:orgId/cards",
"GET /api/v1/hub/orgs/:orgId/mail/inbox",
"GET /api/v1/hub/orgs/:orgId/sync",
"POST /api/v1/hub/orgs/:orgId/ops"
```

Add `"src/hub/routes/ops.ts"` and `"src/hub/routes/sync.ts"` to `route_sources` sources, `"hub"` to `cli_sources`/`cli_commands` (canonical), and these nine tables to `database_tables.canonical`, sorted: `agents`, `boards`, `cards`, `devices`, `mail`, `memberships`, `org_events`, `orgs`, `projects`, `subscriptions`, `users`, `hub_schema_migrations`.

Note: `agents`, `boards`, and `cards` already exist as SQLite table names. Record the hub's as `hub:agents`, `hub:boards`, `hub:cards`, etc. if the inventory's uniqueness assertion rejects duplicates — run the docs test to find out which form it wants.

- [ ] **Step 4: Recompute the totals in the markdown mirror**

Do NOT hand-increment. Recompute from the JSON:

```bash
node -e "const d=require('./docs/agent-os-surface-inventory.json');const c=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,v.length]));console.log('routes',c(d.route_sources.http_routes));console.log('tables',c(d.database_tables));console.log('cli',c(d.cli_commands))"
```

Update the TL;DR totals table in `docs/agent-os-surface-inventory.md` and the per-bucket lists to match exactly what that command prints.

- [ ] **Step 5: Add the cross-org trust boundary to the threat matrix**

In `docs/remote-mobile-threat-control-matrix.json`, add a trust boundary, a control with executable evidence, and a threat that joins them. Use the next free id in each array.

```json
{ "id": "TB-012", "name": "Cross-organization isolation in the hosted hub",
  "description": "Every hub request is scoped to the org bound to the presenting device token; no route reads an org id from the request body." }
```

```json
{ "id": "CUR-019", "status": "implemented",
  "description": "The hub resolves org scope from the device token in a single onRequest hook and rejects any path org id that disagrees with it.",
  "evidence": [ { "file": "src/hub/server.ts",
                  "contains": "return reply.code(403).send({ error: 'device is not a member of this org', code: 'forbidden' })" } ] }
```

```json
{ "id": "REM-T023", "title": "Cross-tenant read or write through a valid device token",
  "topic_ids": ["TOP-001"], "likelihood": "medium", "impact": "severe", "risk": "high",
  "assets": ["AST-010"], "actors": ["ACT-004"], "boundaries": ["TB-012"],
  "current_control_ids": ["CUR-019"],
  "gap": "A hub instance serves many orgs from one process, so a scoping mistake in any new route exposes another tenant's board.",
  "target_control_ids": [], "abuse_case_ids": ["AC-21"] }
```

```json
{ "id": "AC-21", "title": "Device token from org B drives org A's board",
  "preconditions": "Attacker holds a valid, unrevoked device token for their own org.",
  "action": "Issue reads, ops, and a sync stream against another org's id.",
  "current_expected": "Every attempt is refused with 403 before reaching a handler.",
  "target_expected": "Every attempt is refused with 403 before reaching a handler." }
```

- [ ] **Step 6: Run the documentation gates**

Run: `npx vitest run test/agent-os-baseline-docs.test.ts test/remote-mobile-threat-model.test.ts`
Expected: PASS. If a count mismatches, re-run the recompute command in Step 4 and copy its numbers — never adjust by hand.

- [ ] **Step 7: Run the whole hub suite plus the docs gates**

Run: `npx vitest run test/hub-*.test.ts test/agent-os-baseline-docs.test.ts test/remote-mobile-threat-model.test.ts`
Expected: PASS (39 hub tests + both docs gates).

- [ ] **Step 8: Verify the full suite still passes**

Run: `npx vitest run`
Expected: the pre-existing suite is green and the new hub tests are added to it. If a pre-existing test fails, confirm it also fails on `HEAD` before this plan's first commit — do not "fix" an unrelated failure inside this plan.

- [ ] **Step 9: Commit**

```bash
git add docs test/hub-cross-org-isolation.test.ts
git commit -m "docs(hub): surface inventory, cross-org trust boundary, and isolation evidence"
```

---

## Done Criteria for Plan 1

- `npx vitest run test/hub-*.test.ts` is green (39 tests, 10 files).
- `npx vitest run` shows no new failures against the pre-plan baseline.
- `orchestra hub --port 4760` boots against a real Postgres, applies migrations, and serves `/healthz`.
- Two device tokens racing `card.claim` on one card produce exactly one owner and one 409 carrying current state.
- A daemon reconnecting with `?since=<seq>` receives every event it missed, in order, with no duplicates and nothing from another org.

Plan 2 (daemon sync client) consumes: the op envelope `{ op, idempotency_key, payload }`, the 409-with-`current` contract, and `GET /orgs/:orgId/sync?since=`.
