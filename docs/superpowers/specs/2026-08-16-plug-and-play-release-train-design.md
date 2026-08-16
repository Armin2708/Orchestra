# Orchestra plug-and-play release train — design

Date: 2026-08-16 · Status: approved by operator

## Goal

A stranger on a clean Mac/Linux machine runs one command and gets: a running
Orchestra board, hooked Claude/Codex agents that follow the full working
discipline, persistent agent memory, and a populated Wiki — under a license
that is free for personal and internal company use and monetizable for
enterprises.

## Licensing decision

- **License: FSL-1.1-ALv2** (Functional Source License with Apache-2.0 future
  grant, the Sentry model). Free for any use except building a competing
  product; each release automatically converts to Apache-2.0 two years after
  its publication.
- Applies to **future versions only**. Every version pushed through commit
  `fd4cd58` was published under MIT and remains MIT forever; the README states
  this explicitly.
- Changes: `LICENSE` (FSL-1.1-ALv2 text), `package.json` `license` field
  (`"FSL-1.1-ALv2"`), README licensing section.

## Phase 1 — Relicense

Smallest shippable change: swap the license artifacts above, nothing else.
Done when `npm pack` output carries the FSL license and the README explains
the personal/company terms and the MIT history in plain language.

## Phase 2 — Plug-and-play core

- **Publish `orchestra-board` to npm.** Check the name is still free at
  publish time; if taken, decide the rename then (single decision point, not
  speculative work now).
- **`npx orchestra-board init`** — one command on a clean machine:
  1. Environment check via the existing readiness-doctor (Node 22, provider
     CLIs present/authenticated), with actionable fix-it output.
  2. Start the daemon.
  3. Install provider hooks (`orchestra install --provider both` semantics).
  4. Open the board in the browser.
  5. Print the single next step: hire your first agent.
- **First-run wizard replaces manual config.** No `.env` hand-editing; any
  required value is prompted for once and persisted where the daemon already
  keeps state.
- **CI: pack-and-install smoke on a clean container.** The beta-quality
  matrix already tracks package/install smoke; wire it against the packed
  artifact so the published tarball is what gets verified.

## Phase 3 — Workflow bundle ("everything my local system uses")

Ship the operator's local stack as built-ins. Hard rule: **nothing may
reference the operator's homedir** — every path resolves from the installed
package or the target project.

- **Agent rules** — already injected from `rules.ts`. Work item: audit that a
  fresh install gets the full card/mail/worktree/deploy discipline with zero
  setup, and close any gap.
- **Memory/handoff system** — port the `.remember/` loop (now-buffer, daily →
  recent → archive rotation, handoff notes, consolidation) from local hooks
  into a shipped hook that `orchestra install` wires up, with docs.
- **Knowledge graph (graphify → Wiki)** — the #182 ingestion route exists.
  Bundle the graphify skill and auto-ingest so the Wiki tab populates on a
  fresh install without any `~/.claude/skills` copy.
- **Dev-process skills** — ship a skills pack (plan → worktree → build →
  review → ship) inside the package; `orchestra install` copies it into the
  project's `.claude/skills`.

## Phase 4 — Launch

Unblocks the existing board cards: marketplace listing (#10, scaffolding in
`.claude-plugin/`), demo GIF (#8), Show HN post (#11).

## Approach chosen

Release train on the existing repo — each phase ships alone, no monorepo
split, no plugin-first pivot. Rejected: plugin-first (abandons Codex/CLI
installs), monorepo split now (restructuring before user value).

## Success criteria

- Phase 1: packed artifact carries FSL; README terms are unambiguous.
- Phase 2: clean-container CI job goes `npm i -g <tarball>` →
  `orchestra-board init` → board responds and hooks are installed, no manual
  steps.
- Phase 3: a fresh project on a second machine reproduces the operator's
  local workflows (rules, memory, wiki, skills) without touching the
  operator's homedir.
- Phase 4: public listing + launch assets live.
