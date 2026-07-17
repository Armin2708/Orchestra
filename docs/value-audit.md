# Orchestra — Product Value-Add Audit (2026-07-18)

Consolidated from three parallel sweeps: core CLI/server/conductor, web UI, and DX/launch readiness. Prior docs (`web-ui-audit.md`, `value-analysis.md`, `launch-checklist.md`) folded in, not repeated.

## Verdict

The core is solid and well-factored (CLI, hooks, SSE, SQLite, conductor all work; 17 test suites + e2e in CI). The gap between "works" and "shippable" is concentrated in four places: **security**, **hired-agent lifecycle**, **UI trust/error visibility**, and **launch hygiene**. None of the six issues from the previous UI audit were fixed; two regressed.

## P0 — Launch blockers

1. **Unauthenticated daemon exposes RCE.** The Fastify server has no auth, no Host-header check, no origin validation. `POST /boards/:id/hire` + `/agents/:id/task` spawn SDK agents with `permissionMode: 'bypassPermissions'` and attacker-chosen `cwd` — a DNS-rebinding page can execute arbitrary code. Localhost bind is not a defense. Fix: token in `~/.orchestra/` required on mutating routes + reject non-localhost Host. (`src/server.ts`, `src/daemon.ts`, `src/client.ts`, `web/src/api.ts`) — **M**
2. **Reaper silently kills hired agents.** `reaper.ts` has no `kind` filter: a hired agent idle >30 min gets its cards deleted and status set `gone` while the SDK process still runs. Plus `Conductor.shutdown()` is dead code — `orchestra stop` kills agents mid-turn. (`src/reaper.ts`, `src/daemon.ts`) — **S**
3. **npm publish chain is broken end-to-end.** `orchestra-board` is 404 on npm (name available — reserve it); `package.json` lacks `repository`/`homepage`/`keywords`, and CI's `npm publish --provenance` **fails without a matching `repository` field**; plugin hooks run `npx -y orchestra-board@latest` so the recommended install path is dead until publish; no `npm pack` smoke test. — **S**
4. **README hero is a broken image** (`docs/demo.gif` doesn't exist) and the CLI table omits `idea/ideas/hire/task/fire` and all roadmap/milestone features. First impression for HN/npm visitors is a 404 image and stale docs. — **S**

## P1 — Highest-value product improvements

5. **Error/connection visibility layer (UI).** Daemon down still renders "No projects yet"; every write (`Board.tsx`, `CardDrawer.tsx`, `RoadmapView.tsx`) fails silently; a failed `hire` (501) is a silent no-op. One banner + toast helper transforms perceived reliability. — **S**
6. **Cost + transcript persistence for hired agents.** Transcripts are a 500-line in-memory ring lost on restart; token count is output-only, no $ spend. Users running multiple SDK agents have zero spend visibility — this is also a differentiator vs. competing boards. (`src/conductor.ts`, `src/db.ts`) — **M**
7. **Make Roadmap tickets first-class.** Tickets/quest steps aren't clickable (no CardDrawer from Roadmap), milestones can't be renamed/reordered, Board view is milestone-blind (locked steps look assignable), locked-step assign fails silently. Also enforce `isLocked` on `move`/`PATCH` — today quest ordering is advisory-only server-side. — **M**
8. **Strategist feedback loop.** Flagship AI feature is fire-and-forget: no live status, no link to its console, no error surfacing, no highlight of new ideas. — **S/M**
9. **Single multiplexed SSE stream + debounced refetch.** One EventSource per board hits the 6-connection browser cap; every event refetches everything; terminal polls at 1s. — **M**

## P2 — Hardening & polish

10. **API integrity:** unknown-agent 500s on `inbox`/`pulse`; `PRAGMA foreign_keys` never enabled; board delete orphans `ideas`/`milestones`/`deliveries`; message delete leaks deliveries; no body schemas; `from` is spoofable (any client can impersonate any agent). — **S**
11. **Conductor is untested** — the riskiest, most differentiating file has zero tests (server tests stub it). Factor `query()` behind an injectable factory. — **M**
12. **A11y/confirm pass (UI):** instant deletes regressed (milestone + idea added since last audit); Escape never closes drawer/terminal; responsive CSS is dead code targeting a removed `.board` class; mouse-only cards; dead code (NetworkView prompt popover is unreachable). — **S**
13. **CLI parity:** `hire --role strategist`, milestone commands, `transcript`, `interrupt` — endpoints exist, CLI doesn't. — **S**
14. **Repo hygiene for launch:** internal strategy docs (`value-analysis.md`, this file's siblings) are public in a repo HN will read; LICENSE says "agentboard contributors"; no CHANGELOG/tags; `src/version.ts` hardcodes 0.1.0 with no sync test. — **S**

## Growth levers (from DX sweep)

- **`orchestra demo` seed command (S/M):** one command populating a sample board (agents, overlap warning, Q&A) — kills the "need two Claude sessions to see anything" barrier.
- **Cross-tool recipes (M):** Codex CLI / Gemini CLI / OpenCode guides — "coordinate independently-run mixed agents" is the uncontested niche per `value-analysis.md`; avoid launching on "kanban for agents" (owned by Vibe Kanban).
- **Demo GIF + 60s video (S):** highest-leverage single asset; `scripts/e2e.sh` is an implicit script for it.

## Suggested sequence

Security token + reaper fix (P0.1–2) → publish chain + README (P0.3–4) → error-visibility layer (5) → demo GIF + `orchestra demo` → then P1 product work (6–9) post-launch.
