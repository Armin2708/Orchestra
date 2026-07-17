# Competitor Teardown: Vibe Kanban (hands-on) + Conductor (docs) — 2026-07-18

Scope agreed with onyx-fox (board msgs #61–64): this doc is the *hands-on/product-flow* teardown; the broad cited market sweep lands separately in `docs/value-research.md`. Method: actually ran Vibe Kanban v0.1.44 locally via `npx vibe-kanban`, drove the full create→execute→review→merge loop against a scratch repo with Playwright, inspected on-disk artifacts; Conductor covered from official docs (Mac-only app, not installed).

## Headline: Vibe Kanban is sunsetting

**bloop, the company behind Vibe Kanban, shut down April 10, 2026** (vibekanban.com/blog/shutdown, confirmed in-app changelog v0.1.42). Facts:

- Stated reason: *"the vast majority are free users and we couldn't find a business model that we could get excited about."*
- Remote services (kanban issues, comments, projects, organisations) removed after a 30-day window; data-export feature shipped; project continues as community-maintained OSS, "fully local architecture" planned.
- Release cadence already stalled: last release v0.1.44 (Apr 24, 2026) — nothing in ~3 months. README replaced its hiring banner with a sunsetting notice; project routes sunset to an export-only page (PRs #3387, #3388).
- Still 27k GitHub stars; in-app Discord badge showed only 189 online.

**Implication:** `value-analysis.md` §1's claim that "kanban for agents is owned by Vibe Kanban (dominant mindshare)" is stale. The position is *vacant* — with a cautionary tale attached about monetizing it.

## Vibe Kanban v0.1.44 — hands-on teardown (local, signed-out mode)

### Install & onboarding
- `npx vibe-kanban`: downloads a ~46 MB Rust binary, serves on a random localhost port, SQLite in `~/Library/Application Support/ai.bloop.vibe-kanban/`.
- Onboarding = pick coding agent (9 supported: Claude Code, Codex, OpenCode, Gemini, AMP, Copilot, Cursor, Droid, Qwen), pick editor (VS Code/Cursor/Zed/IntelliJ/Xcode/…), pick notification sound.
- Permanent banner: *"Vibe Kanban runs AI coding agents with `--dangerously-skip-permissions` / `--yolo` by default."* Yolo is the default, not an opt-in.
- **Sign-in wall:** the actual kanban board, projects/organisations, and team collaboration are account-gated (GitHub/Google). Signed-out you get *only* local workspaces — and the gated features are precisely the ones being killed by the shutdown. The surviving product is a workspace manager, not a kanban board.

### Core flow (verified end-to-end)
1. **Create workspace** → in-app repo browser (manual path entry works), multi-repo workspaces supported, per-repo setup/cleanup scripts.
2. Each workspace = **git worktree** at `$TMPDIR/vibe-kanban/worktrees/<id>/<repo>` on an auto-branch `vk/<id>-<task-slug>`. Main checkout untouched.
3. **Task prompt** → choose agent + model ("Opus · High"; Claude CLI pinned by VK release, here 2.1.119 → claude-opus-4-7) → Create → agent starts immediately (yolo).
4. **Execution view** is the strongest part: normalized log stream (every hook event, tool call, "Read README.md", diff chips "README.md +1"), live context-usage %, follow-up composer with Queue/Stop, "Start Review" (agent-run review), dev-server + preview panel, terminal, notes, IDE handoff button.
5. **Commit guardrail:** VK injects a Stop hook — when the agent finished without committing, the hook forced "stage and commit now with a descriptive message" and the agent complied. Work is always committed on the branch.
6. **Merge:** sidebar git panel → Open PR (needs remote) / Link PR / **Merge** (confirm dialog) → lands as a **squash commit on target with the task title as message**. Verified on scratch repo.
7. Sidebar triage: workspaces grouped **Needs Attention / Running / Idle** with diff-stat badges; archive; "pair a remote device" for remote access.

### Interop observation (directly relevant to us)
The VK-spawned Claude Code session **inherited the user's global `~/.claude` config** — CLAUDE.md style rules showed up in its replies, and our orchestra `session-end` hook fired *inside VK's agent* (visible in VK's own log as "SessionEnd hook [orchestra hook session-end] failed: Hook cancelled"). Two consequences:
- **Free cross-tool visibility:** orchestra's hook-based auto-registration would put VK-spawned (and likely Conductor-spawned) Claude agents on our board with zero VK integration work.
- **Hook-conflict risk:** our hooks must fail soft inside other orchestrators (this one cancelled harmlessly, but it's a real surface).

### Weaknesses observed
- No coordination between workspaces: nothing warns when two workspaces' branches touch the same files; merge-conflict discovery happens at merge.
- Account-gated board + cloud dependency was the product's spine — and is what died. Local mode has no board/columns at all.
- Console showed 5 JS errors during normal signed-out use (cloud endpoints failing) — the signed-out path is degrading.
- Onboarding friction: sign-in nag, terms/privacy, welcome tour, "What's New" modal that blocks clicks.

## Conductor (conductor.build) — doc-level teardown

- **Mac-only native app**; agents: Claude Code, Codex, Cursor, OpenCode. Piggybacks on your existing Claude login (Pro/Max plan or API key) — no separate billing for agent runs.
- Model: repo is cloned; every workspace = a **git worktree** with own branch, terminal, diff, app process. Doctrine: *"the workspace is the unit of delegation; the branch and PR are the unit of integration."*
- Flow strength is **review/merge**: Diff Viewer with inline comments that become composer attachments sent back to the agent; agent-run "Review" action; **Checks tab** aggregating git status, CI, deployments, review comments, and todos before merge; create-workspace-from GitHub/Linear issue or PR; PR drafting and check-fixing.
- **Parallel-agents doctrine** (their own docs): multiple workspaces for independent work; multiple agents in *one* workspace for shared-branch work — and they explicitly concede *"agents in the same workspace can edit the same files"* as an unmanaged **tradeoff**. No collision detection, no path claims, no warnings. That is exactly the gap orchestra's card-paths + PreToolUse gate covers.
- **Conductor Cloud** just launched in early access — they're going where bloop failed; monetization pressure will shape the free tier.

## Side-by-side

| Dimension | Vibe Kanban (v0.1.44, sunsetting) | Conductor | orchestra-board |
|---|---|---|---|
| Model | Tool spawns agents in temp worktrees | Tool spawns agents in worktrees | Hooks observe sessions *you* run (+ optional hire) |
| Workflow change | Full replacement (their UI is the workflow) | Full replacement (Mac app) | None — retrofit onto open terminals |
| Kanban board | Account-gated, being removed | No board (sidebar of workspaces) | Local-first, no account |
| Shared-checkout safety | N/A (isolates via worktrees) | Explicitly unmanaged tradeoff | Core feature (path claims, overlap warnings) |
| Agent↔agent comms | None | None | ask/reply message bus |
| Platform | Cross-platform OSS | Mac-only, closed | Cross-platform OSS |
| Review/merge | Squash merge, agent review, PR | Best-in-class (diff comments→agent, Checks tab) | Not in scope |
| Business status | Company dead; community OSS | VC-backed, Cloud in early access | — |

## Positioning takeaways

1. **The "kanban for agents" position is vacant** — but bloop's post-mortem says the audience won't pay for it. Treat the board as commodity surface (as `value-analysis.md` already concluded); don't build a business on it.
2. **Migration moment:** 27k-star community losing its cloud board + org features. "Local-first, no accounts, SQLite" is now a *differentiator against the incumbent's death*, and VK's data-export feature makes a "import from Vibe Kanban" story cheap.
3. **Coordination remains unclaimed.** Both competitors isolate; neither coordinates. Conductor documents the same-files problem and shrugs. Orchestra's collision-avoidance + agent-to-agent Q&A has no overlap with either product — the scope decision in `value-analysis.md` §4 survives this teardown intact.
4. **Interop lever discovered:** because orchestrators reuse the user's Claude Code install, orchestra's hooks already run inside agents spawned by VK/Conductor. "One board that sees every agent, whoever spawned it" is demonstrably feasible today.
5. **Review/merge is the bar Conductor sets** — if orchestra ever expands toward worktree awareness (value-analysis angle A), diff-level conflict forecasting is the differentiated piece, not diff viewing.

---

## Addendum (gap-fill for value-research.md): native-tooling absorption risk — primary sources only

All facts below read directly from official vendor docs on 2026-07-18 (code.claude.com Agent Teams page, self-described "as of v2.1.178"; cursor.com/docs/cloud-agent). This replaces the refuted blog-sourced claims in earlier drafts.

### Claude Code Agent Teams (verified)
- **Experimental and off by default.** Real gate: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (env or settings.json). Documented known limitations: no teammate restore on `/resume`/`/rewind`, task status can lag/block dependents, slow shutdown, no nested teams, fixed lead.
- **Session-scoped and team-initiated by design:** "a session has exactly one team, scoped to that session. You can't create additional named teams or share a team across sessions." The lead spawns teammates; there is no mechanism to enroll independently-started sessions. The docs' own alternative for that is "Manual parallel sessions: Git worktrees … without automated team coordination."
- **No collision protection.** Verbatim best-practice: *"Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files."* Avoidance is manual prompt discipline — same shrug as Conductor.
- Mechanics that matter for us: shared task list with file-locked claiming and dependencies (`~/.claude/tasks/{team-name}/`, persists locally); JSON mailboxes per agent (`~/.claude/teams/{team-name}/inboxes/{agent}.json`, config dir deleted at session end); team hooks `TeammateIdle` / `TaskCreated` / `TaskCompleted` (exit 2 = block + feedback); teammates inherit lead's permission mode at spawn; Claude-only.

**Absorption read:** Teams absorbs *lead-orchestrated, single-session, Claude-only* parallelism. It structurally does not cover orchestra's confirmed scope (independently-launched sessions, shared checkout, cross-tool), and Anthropic's docs actively direct that use case to un-coordinated worktrees. Risk is real but positional, not head-on: the danger scenario is Teams later adding cross-session enrollment, not today's feature set. Meanwhile the team hooks + on-disk task/mailbox state make "orchestra as the live board over native Teams" (value-analysis angle C) technically straightforward.

### Cursor cloud agents (verified)
- Run in **isolated cloud VMs**, clone from GitHub/GitLab/Azure DevOps/Bitbucket, work on a **separate branch**, hand off as merge-ready PRs. Not on your local checkout at all.
- "You can run as many agents as you want in parallel" — but the docs contain **no coordination, conflict-handling, or agent-to-agent features whatsoever**. Parallel ≠ coordinated.

**Absorption read:** orthogonal to orchestra — Cursor moved the problem to the cloud instead of solving local coordination; no threat to (and no coverage of) the shared-checkout niche.

### Vibe Kanban migration path (gap 2, from the hands-on install)
VK's local state is a plain SQLite DB at `~/Library/Application Support/ai.bloop.vibe-kanban/db.v2.sqlite`. `tasks` maps ~1:1 to orchestra cards: `title`, `description`, `status IN ('todo','inprogress','inreview','done','cancelled')` → backlog/in_progress/review/done, with `projects` → boards and `workspaces.branch` available for path/branch hints. An `orchestra import --from-vibe-kanban` reading that file is a small, high-leverage wedge aimed at a 27k-star community whose cloud board just died. (VK also shipped an official data-export feature per the shutdown notice — the sqlite read works even without it.)

*Cross-reference: `docs/value-audit.md` (internal product audit), `docs/value-analysis.md` (positioning, pre-shutdown — §1 table now stale), `docs/value-research.md` (onyx-fox's cited market sweep).*
