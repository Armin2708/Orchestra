# Phase 3 Workflow Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the operator's local workflow stack as package built-ins: provider-agnostic agent memory + handoff, a generalized dev-process command pack, and an integrations detector — with zero references to any operator homedir or third-party redistribution.

**Architecture:** Memory is a clean-room, file-based store under `dataDir()` (ORCHESTRA_HOME), written by new CLI commands (`orchestra remember`, `orchestra handoff`) and injected into every provider session via the existing `sessionStart` hook path — Claude AND Codex get memory. The dev-process commands the operator authored in `~/.claude/commands` ship generalized inside the package (`workflows/`) and are copied by `orchestra install --workflows`. Graphify/Obsidian/GitNexus are DETECTED integrations (`orchestra integrations`), never vendored — the remember plugin is "no commercial redistribution" and the graphify engine is a third-party pip package, so neither may be copied into this FSL-licensed package.

**Tech Stack:** TypeScript ESM, commander 15, vitest, existing seams: `dataDir()` (src/daemon.ts:226), `renderSessionStart` (src/hooks.ts:188), `sessionStart` (src/hooks.ts:211), `installHooks` (src/install.ts:500).

## Global Constraints

- Node `>=22.20.0 <23`, npm `>=10.9.3 <11`; ESM; local imports use `.js` extensions.
- NEVER branch-switch in the shared checkout; work happens in the worktree the lead created.
- New CLI commands MUST have their `program.command('...')` literal in `src/cli.ts` (the inventory enumerator only scans `cli_sources`) and be added to `docs/agent-os-surface-inventory.json` `cli_commands` (infrastructure classification, alphabetical) + the md human map. NEVER touch the frozen TL;DR counts (precedent d4ba4a2).
- NO absolute paths, homedir references, personal names (`arminrad`, `~/Vault`, `AuraScan`), or third-party plugin text may land in shipped files. Everything resolves from `dataDir()`, the package root, or the target project.
- If `test/beta-quality-matrix.test.ts` flags a new file as an unclassified state-machine candidate: classify it in `docs/quality/beta-quality-requirements.json` (alphabetical), set `state_machine_discovery_sha256` from `stateMachineDiscoveryDigest()`, repin `PINNED_REQUIREMENTS_SHA256` in `scripts/check-beta-quality-matrix.mjs` (sha256 of the requirements file).
- Release-claim wording in docs is gated by `test/packaging-docs-truthfulness.test.ts` — run it after any README/docs edit.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

- `src/memory.ts` — memory/handoff store (pure functions over a root dir; no I/O at import time)
- `test/memory.test.ts` — store unit tests (tmp dirs)
- `src/cli.ts` — `remember`, `handoff`, `integrations` command literals
- `src/hooks.ts` — memory injection into `sessionStart`
- `test/hooks-memory.test.ts` — injection rendering test
- `src/integrations.ts` + `test/integrations.test.ts` — detector
- `workflows/*.md` — shipped command pack (6 files)
- `src/install.ts` — `installWorkflows` + `--workflows` flag wiring
- `test/install-workflows.test.ts`
- `docs/agent-os-surface-inventory.json|md`, `package.json` (`files` + `workflows`), `README.md`

---

### Task 1: Memory + handoff store (`src/memory.ts`)

**Files:**
- Create: `src/memory.ts`
- Test: `test/memory.test.ts`

**Interfaces:**
- Consumes: nothing (root dir is a parameter; callers pass `path.join(dataDir(), 'memory')`).
- Produces (exact signatures Tasks 2–3 rely on):
  - `appendMemory(root: string, boardId: number, agent: string, text: string, now?: Date): void` — appends `## HH:MM | <agent>\n<text>\n` to `<root>/board-<boardId>/today-YYYY-MM-DD.md`; before appending, rotates any `today-*.md` older than today into `recent.md` (prepended, newest first) and drops `recent.md` sections older than 7 days into `archive.md` (append).
  - `readMemoryInjection(root: string, boardId: number, maxChars?: number): string` — returns `''` when no files exist; otherwise a `=== MEMORY ===` block containing today's file plus `recent.md`, truncated from the TOP (oldest dropped first) to `maxChars` (default 4000), with a first line `history: <root>/board-<boardId>/ (today, recent 7d, archive)`.
  - `writeHandoff(root: string, boardId: number, agent: string, text: string): void` — overwrites `<root>/board-<boardId>/handoff.md` with frontmatter-free `# Handoff (<agent>, <ISO date>)\n\n<text>\n`.
  - `consumeHandoff(root: string, boardId: number): string | null` — if `handoff.md` exists, renames it to `last-handoff.md` (replacing any previous) and returns its content; else returns `null`.
- All functions `mkdirSync` recursively as needed and never throw on missing files.

- [ ] **Step 1: Write the failing tests**

```ts
// test/memory.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendMemory, consumeHandoff, readMemoryInjection, writeHandoff } from '../src/memory.js'

const roots: string[] = []
const freshRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mem-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('memory store', () => {
  it('appends a stamped entry to today and reads it back in the injection', () => {
    const root = freshRoot()
    appendMemory(root, 3, 'violet-puffin', 'shipped the widget', new Date('2026-08-18T09:15:00Z'))
    const injection = readMemoryInjection(root, 3)
    expect(injection).toContain('=== MEMORY ===')
    expect(injection).toContain('| violet-puffin')
    expect(injection).toContain('shipped the widget')
    expect(injection).toContain(`board-3`)
  })

  it('returns empty string when nothing was ever remembered', () => {
    expect(readMemoryInjection(freshRoot(), 9)).toBe('')
  })

  it('rotates yesterday into recent.md on the next append', () => {
    const root = freshRoot()
    appendMemory(root, 1, 'a', 'old work', new Date('2026-08-17T10:00:00Z'))
    appendMemory(root, 1, 'a', 'new work', new Date('2026-08-18T10:00:00Z'))
    const dir = path.join(root, 'board-1')
    expect(fs.existsSync(path.join(dir, 'today-2026-08-17.md'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'recent.md'), 'utf8')).toContain('old work')
    expect(fs.readFileSync(path.join(dir, 'today-2026-08-18.md'), 'utf8')).toContain('new work')
  })

  it('expires recent sections older than 7 days into archive.md', () => {
    const root = freshRoot()
    appendMemory(root, 1, 'a', 'ancient work', new Date('2026-08-01T10:00:00Z'))
    appendMemory(root, 1, 'a', 'today work', new Date('2026-08-18T10:00:00Z'))
    const dir = path.join(root, 'board-1')
    expect(fs.readFileSync(path.join(dir, 'archive.md'), 'utf8')).toContain('ancient work')
    expect(fs.readFileSync(path.join(dir, 'recent.md'), 'utf8')).not.toContain('ancient work')
  })

  it('truncates the injection from the top when over budget', () => {
    const root = freshRoot()
    for (let i = 0; i < 50; i++) appendMemory(root, 1, 'a', `entry ${i} ${'x'.repeat(200)}`, new Date('2026-08-18T10:00:00Z'))
    const injection = readMemoryInjection(root, 1, 2000)
    expect(injection.length).toBeLessThanOrEqual(2200) // header allowance
    expect(injection).toContain('entry 49')
    expect(injection).not.toContain('entry 0 ')
  })

  it('handoff round-trips once and archives itself', () => {
    const root = freshRoot()
    expect(consumeHandoff(root, 2)).toBeNull()
    writeHandoff(root, 2, 'violet-puffin', 'Next: publish to npm')
    const first = consumeHandoff(root, 2)
    expect(first).toContain('Next: publish to npm')
    expect(first).toContain('violet-puffin')
    expect(consumeHandoff(root, 2)).toBeNull()
    expect(fs.readFileSync(path.join(root, 'board-2', 'last-handoff.md'), 'utf8')).toContain('publish to npm')
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/memory.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/memory.ts`**

Implementation notes (write real code, matching repo style — 2-space indent, single quotes, semicolon-free style is NOT used here; copy the style of `src/install.ts`):
- `const boardDir = (root: string, boardId: number) => path.join(root, `board-${boardId}`)`
- Date helpers: `dayStamp(d)` → `YYYY-MM-DD` (UTC), `timeStamp(d)` → `HH:MM` (UTC).
- Rotation on append: list `today-*.md` files whose stamp !== today; prepend each (with `\n# YYYY-MM-DD\n` header) to `recent.md`, delete the file. Then split `recent.md` on `^# (\d{4}-\d{2}-\d{2})$` sections; sections older than 7 days from `now` append to `archive.md` and drop from `recent.md`.
- Injection: read today file + recent; if both empty/missing return `''`; compose header + content; if over `maxChars`, drop whole lines from the top until within budget.
- Handoff exactly per the interface block.

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/memory.test.ts` → 6 passed. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit** — `git add src/memory.ts test/memory.test.ts` / `feat(memory): provider-agnostic file-based agent memory + handoff store`

---

### Task 2: CLI commands `remember` + `handoff` + hook injection

**Files:**
- Modify: `src/cli.ts` (two command literals, after the `note` command block)
- Modify: `src/hooks.ts` (`sessionStart`, src/hooks.ts:211)
- Test: `test/hooks-memory.test.ts` (create)
- Modify: `docs/agent-os-surface-inventory.json` + `.md`

**Interfaces:**
- Consumes: Task 1 exports; `dataDir()` from `./daemon.js`; in cli.ts the existing helpers `board()` (board resolve) and agent-name resolution used by `note`/`mail` (read those blocks first and mirror them exactly).
- Produces: `orchestra remember <text> [--agent <a>]` and `orchestra handoff <text> [--agent <a>]`; session-start context gains the memory block + one-shot handoff.

- [ ] **Step 1: Read the `note` command block in src/cli.ts (~line 706) and the `sessionStart` function (src/hooks.ts:211)** to mirror board/agent resolution and injection style.

- [ ] **Step 2: Write the failing injection test**

```ts
// test/hooks-memory.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendMemory, writeHandoff } from '../src/memory.js'
import { renderMemorySection } from '../src/hooks.js'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }) })

describe('session-start memory injection', () => {
  it('renders memory + consumes the handoff exactly once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hookmem-'))
    roots.push(root)
    appendMemory(root, 5, 'violet-puffin', 'yesterday: shipped init')
    writeHandoff(root, 5, 'violet-puffin', 'Next: publish to npm')
    const first = renderMemorySection(5, root)
    expect(first).toContain('=== HANDOFF ===')
    expect(first).toContain('Next: publish to npm')
    expect(first).toContain('=== MEMORY ===')
    expect(first).toContain('shipped init')
    const second = renderMemorySection(5, root)
    expect(second).not.toContain('=== HANDOFF ===')
    expect(second).toContain('shipped init')
  })

  it('renders nothing for a board with no memory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hookmem-'))
    roots.push(root)
    expect(renderMemorySection(7, root)).toBe('')
  })
})
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run test/hooks-memory.test.ts` → FAIL (`renderMemorySection` not exported).

- [ ] **Step 4: Implement**

In `src/hooks.ts` add (near `renderSessionStart`):

```ts
export function renderMemorySection(boardId: number, root = path.join(dataDir(), 'memory')): string {
  const handoff = consumeHandoff(root, boardId)
  const memory = readMemoryInjection(root, boardId)
  const parts = []
  if (handoff) parts.push(`=== HANDOFF ===\n${handoff.trim()}`)
  if (memory) parts.push(memory)
  return parts.join('\n\n')
}
```

(import `consumeHandoff`, `readMemoryInjection` from `./memory.js`, `dataDir` from `./daemon.js`, `path` already imported — verify.) In `sessionStart`, after `renderSessionStart(...)` compose `const memory = renderMemorySection(session.board_id)` and emit `memory ? \`${text}\n\n${memory}\` : text` through the existing spool/console path (both provider branches use the same composed string).

In `src/cli.ts` add after the `note` block, mirroring its option style:

```ts
program.command('remember <text>').description('save a session memory note (injected into future sessions on this board)')
  .option('--agent <a>')
  .action(async (text, o) => {
    const b = await board()
    appendMemory(path.join(dataDir(), 'memory'), b.id, o.agent ?? process.env.ORCHESTRA_AGENT ?? 'operator', text)
    console.log('remembered')
  })
program.command('handoff <text>').description('leave a handoff note for the next session on this board (shown once)')
  .option('--agent <a>')
  .action(async (text, o) => {
    const b = await board()
    writeHandoff(path.join(dataDir(), 'memory'), b.id, o.agent ?? process.env.ORCHESTRA_AGENT ?? 'operator', text)
    console.log('handoff saved')
  })
```

Adjust to the ACTUAL `board()`/resolve helper name and option conventions found in Step 1 — do not invent new resolution logic.

- [ ] **Step 5: Inventory** — add `handoff` and `remember` to `cli_commands.infrastructure` (alphabetical) in the JSON; add both to the md human map Infrastructure row. Run `npx vitest run test/agent-os-baseline-docs.test.ts` → PASS.

- [ ] **Step 6: Run everything touched** — `npx vitest run test/memory.test.ts test/hooks-memory.test.ts test/agent-os-baseline-docs.test.ts test/beta-quality-matrix.test.ts` → all pass (classify per Global Constraints if beta-quality flags src/memory.ts). `npx tsc --noEmit` → clean.

- [ ] **Step 7: Manual smoke** — `npx tsx src/cli.ts remember 'memory smoke entry' && npx tsx src/cli.ts hook session-start <<< '{"cwd":"'$PWD'","session_id":"smoke-mem"}'` — expect the session-start output to contain `memory smoke entry`. (If the hook path needs a registered session and refuses, instead assert via `node -e` calling `renderMemorySection` with the real dataDir.)

- [ ] **Step 8: Commit** — `feat(memory): remember/handoff CLI + session-start injection for every provider`

---

### Task 3: Workflows pack + `orchestra install --workflows`

**Files:**
- Create: `workflows/build.md`, `workflows/plan.md`, `workflows/execute.md`, `workflows/review-comments.md`, `workflows/open-pr.md`, `workflows/issue-plan.md`
- Modify: `src/install.ts` (add `installWorkflows`), `src/cli.ts` (`--workflows` option on the existing `install` command — NOT a new command), `package.json` (`files` array + `workflows`)
- Test: `test/install-workflows.test.ts`

**Interfaces:**
- Consumes: `HookScope` from install.ts.
- Produces: `installWorkflows(scope: HookScope, targetRoot?: string): string[]` (returns written paths) — copies every `workflows/*.md` into `<target>/.claude/commands/` (project scope: cwd; global scope: the provider settings dir install.ts already resolves — reuse its path helpers). Files are copied with their basename; existing files are overwritten only when content differs; never deletes anything.

- [ ] **Step 1: Generalize the source commands.** The operator's originals are at `/Users/arminrad/.claude/commands/{build,dev-plan,dev-execute,dev-comments,dev-pr,dev-issue-plan}.md` — READ each, then write the shipped version applying these transformation rules (the originals are the operator's own work — content may be reused, but shipped copies must be clean):
  1. Strip every absolute path and homedir reference (`~/Vault`, `/Users/...`). Vault steps become conditional: "If this project documents an Obsidian vault (see its CLAUDE.md), record decisions there."
  2. Graphify/GitNexus steps become conditional on detection: "If `graphify-out/graph.json` exists…", "If `.gitnexus/` exists…" (the originals already mostly phrase it this way — keep that phrasing).
  3. Replace personal workflow nouns with orchestra ones: board cards for tracking (`orchestra card create` before edits, review column, completion mail), worktrees for isolation, `orchestra deploy` warning is NOT included (project-specific).
  4. Rename to the neutral filenames above (`dev-plan.md` → `plan.md`, `dev-execute.md` → `execute.md`, `dev-comments.md` → `review-comments.md`, `dev-pr.md` → `open-pr.md`, `dev-issue-plan.md` → `issue-plan.md`); keep each file's frontmatter `description:` line, rewritten to match.
  5. No mention of TeamCreate/Dolphy/personal tools; agent teams phrased generically ("dispatch subagents in parallel where tasks are independent").
- Example shape for `workflows/build.md` (the executor writes all six following this pattern):

```markdown
---
description: Plan against the project's knowledge sources, then build in a git worktree with parallel subagents and orchestra card tracking
---

Build the requested changes end-to-end.

## 1. Understand before sketching
- If `graphify-out/graph.json` exists, query it first (`/graphify query "<question>"`) before grep/read sweeps; re-verify cited files.
- If `.gitnexus/` exists, run impact analysis before editing any symbol; treat HIGH/CRITICAL risk as a stop-and-report.
- Read the project's CLAUDE.md and any knowledge sources it names before non-trivial work.

## 2. Plan
- Sketch all required changes; pick the recommended option and proceed.
- Register the work: `orchestra card create '<title>' --desc '<scope>' --paths <paths> --column in_progress`.

## 3. Build in a worktree
- Create a git worktree for the change; never create or switch branches in the shared checkout.
- Dispatch subagents in parallel where tasks are independent; give each the project context it cannot inherit.

## 4. Verify and hand back
- Run the affected tests, then the full suite; report actual results.
- Move the card to review with Delivered / Evidence / Remaining; never self-mark done.
- Update the project's knowledge sources (graph refresh, vault note) if the project uses them.
```

- [ ] **Step 2: Write the failing test**

```ts
// test/install-workflows.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installWorkflows } from '../src/install.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

describe('workflows pack', () => {
  it('ships six generalized command files with no personal references', () => {
    const pack = fs.readdirSync(new URL('../workflows', import.meta.url) as unknown as string)
    expect(pack.sort()).toEqual(['build.md', 'execute.md', 'issue-plan.md', 'open-pr.md', 'plan.md', 'review-comments.md'])
    for (const f of pack) {
      const body = fs.readFileSync(path.join(new URL('../workflows', import.meta.url).pathname, f), 'utf8')
      expect(body).not.toMatch(/\/Users\/|~\/Vault|arminrad|Dolphy|TeamCreate/i)
      expect(body.startsWith('---\ndescription:')).toBe(true)
    }
  })

  it('copies the pack into a project .claude/commands and is idempotent', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wf-'))
    dirs.push(target)
    const written = installWorkflows('project', target)
    expect(written).toHaveLength(6)
    expect(fs.existsSync(path.join(target, '.claude', 'commands', 'build.md'))).toBe(true)
    expect(installWorkflows('project', target)).toHaveLength(0) // unchanged → nothing rewritten
  })
})
```

- [ ] **Step 3: Run to verify failure**, then implement `installWorkflows` in src/install.ts: resolve the pack dir relative to the module (`new URL('../workflows', import.meta.url)` works from `dist/` because `workflows` ships at package root — verify dist layout: dist/cli.js sits at `<pkg>/dist/`, so `../workflows` is `<pkg>/workflows`; in dev, src/ → `../workflows` also resolves; add a fallback probe of both `../workflows` and `../../workflows` and error clearly if neither exists). Copy-if-different, return written paths. Global scope target: `os.homedir()`-rooted `.claude/commands` IS allowed here (it's the user's own config dir at runtime, resolved dynamically — the homedir ban is on hardcoded operator paths).

- [ ] **Step 4: Wire the flag** — in src/cli.ts extend the existing `install` command: `.option('--workflows', 'also install the workflow command pack into .claude/commands')` and in its action call `installWorkflows(o.project ? 'project' : 'global')` when set, printing each written path. Also add the same call into `init` (always install workflows pack — it is the "full package" default; add `--no-workflows` opt-out to init via `.option('--no-workflows', ...)` passed through `buildInitAction` deps: extend `InitCliDeps` with `installWorkflowPack?: (scope: HookScope) => string[]` defaulting to `installWorkflows`, called right after `installProviderHooks`; update test/init-cli.test.ts call-order assertion to include `workflows:global` between hooks and open).
- [ ] **Step 5: package.json** — add `"workflows"` to the `files` array.
- [ ] **Step 6: Run** — `npx vitest run test/install-workflows.test.ts test/init-cli.test.ts` → pass; `npx tsc --noEmit` clean.
- [ ] **Step 7: Commit** — `feat(workflows): ship the dev-process command pack; installed by init and install --workflows`

---

### Task 4: `orchestra integrations` detector + rules parity audit

**Files:**
- Create: `src/integrations.ts`, `test/integrations.test.ts`
- Modify: `src/cli.ts` (command literal), inventory json+md
- Create: `test/rules-parity.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `detectIntegrations(projectRoot: string): IntegrationStatus[]` where `IntegrationStatus = { id: 'graphify' | 'obsidian' | 'gitnexus', present: boolean, detail: string, enable_hint: string }`.

- [ ] **Step 1: Failing test** — tmp dir with/without `graphify-out/graph.json`, `.gitnexus/`, and an `OBSIDIAN_VAULT`-style marker. Detection rules: graphify = `graphify-out/graph.json` exists under root; gitnexus = `.gitnexus/` dir exists; obsidian = project CLAUDE.md (if present) mentions a vault path (`/vault/i` match) — detail says where, enable_hints are one-liners ("build a graph: see graphify docs", "index the repo: npx gitnexus analyze", "document your vault path in CLAUDE.md"). Assert all three both ways.
- [ ] **Step 2: Implement + CLI** — `program.command('integrations').description('show which knowledge integrations this project has (graphify, obsidian vault, gitnexus)')` printing one line per integration (`● graphify — graph.json present` / `○ gitnexus — not detected; npx gitnexus analyze`). Add to inventory (infrastructure) + md map.
- [ ] **Step 3: Rules parity audit test** (`test/rules-parity.test.ts`): read the injected-rules source (`src/rules.ts` + `renderSessionStart` in src/hooks.ts) and assert the shipped discipline covers, as substrings of the composed rule text: card registration before edits (`card create`), review-not-done (`review, never done` or equivalent — read rules.ts first and pin the ACTUAL phrasing), completion mail (`mail`), worktree guidance if present in rules.ts (if absent, the test documents the gap: add the one-line rule `- Isolate multi-file work in a git worktree; never switch branches in a shared checkout.` to rules.ts compact rules — keep the token diet in mind, this is one line) and memory (`remember`) — add a one-line rule to rules.ts advertising `orchestra remember '<note>'` for session-memory. Update `docs/token-diet.md` ONLY if it inventories rule lines (check first).
- [ ] **Step 4: Run** — new tests + `test/agent-os-baseline-docs.test.ts` + `test/beta-quality-matrix.test.ts` + any rules snapshot tests that pin rules.ts content (`grep -rln "rules" test/ | xargs npx vitest run` is too broad — run `npx vitest run test/token-diet.test.ts` if it exists, plus whatever fails in the full suite in Task 5). `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(integrations): knowledge-integration detector + rules parity (worktree + memory lines)`

---

### Task 5: Docs, full suite, pack smoke

**Files:**
- Modify: `README.md` (add "The full package" subsection under Features/init docs), `docs/getting-started.md` (mention memory/handoff/workflows in the quickstart block)
- No new code.

- [ ] **Step 1: README** — under the quickstart section add:

```markdown
### The full package

`orchestra init` sets up the complete working system, not just the board:

- **Agent discipline** — every hooked session gets the card/review/mail rules automatically.
- **Memory** — `orchestra remember '<note>'` and `orchestra handoff '<note>'` persist across
  sessions and providers; both are injected at session start (Claude and Codex).
- **Workflow commands** — a generalized plan → build-in-worktree → review → ship command pack
  is installed into `.claude/commands`.
- **Knowledge integrations** — `orchestra integrations` shows what the project has (graphify
  knowledge graph, Obsidian vault, GitNexus index) and how to enable what's missing. These are
  detected, never bundled.
```

- [ ] **Step 2: Truthfulness + docs gates** — `npx vitest run test/packaging-docs-truthfulness.test.ts test/agent-os-baseline-docs.test.ts` → pass.
- [ ] **Step 3: Full suite** — `npx vitest run` → ALL pass (2560+).
- [ ] **Step 4: Pack smoke** — `npm pack --pack-destination <scratch>` then from a clean `mktemp -d` prefix: global-install the tarball, run `<prefix>/bin/orchestra install --project --workflows` in a second tmp dir and assert `.claude/commands/build.md` exists there and contains no `/Users/` string; run `<prefix>/bin/orchestra integrations`; clean up.
- [ ] **Step 5: Commit** — `docs: the full package — memory, workflows, integrations`

---

## Self-Review Notes

- Spec Phase-3 coverage: rules audit → Task 4 Step 3; memory/handoff port → Tasks 1–2 (clean-room, NOT the remember plugin — its license forbids commercial redistribution); graphify → detected integration (engine is third-party pip; the spec's "bundle the skill" is downgraded to detection + hint for licensing reasons — flagged to operator); dev-process skills → Task 3 (operator-authored, generalized); homedir rule → enforced by test regex in Task 3 Step 2.
- Wiki auto-ingest (#182 route) intentionally deferred: it needs graphify present at runtime; the integrations detector is the honest v1. Listed as follow-up, not silently dropped.
- Type consistency: `HookScope` reused from install.ts; `InitCliDeps` extension named `installWorkflowPack` to avoid colliding with `installProviderHooks`.
