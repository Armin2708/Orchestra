# Orchestra — Critical Value & Positioning Analysis

**Date:** 2026-07-17 · **Status:** working draft for launch strategy

## 1. Where the market actually is

Four distinct layers have formed around "multiple coding agents on one project":

| Layer | Who's there | What they do |
|---|---|---|
| **Native platform** | Claude Code **Agent Teams** (experimental, shipped Feb 5 2026 with Opus 4.6): shared task list, peer-to-peer mailbox, lead/teammate model. Tasks system (`~/.claude/tasks`) with dependencies. | Absorbing coordination into the product itself. Anthropic's own Code Review (Mar 2026) is built on it. |
| **Orchestrators (spawn & manage)** | **Vibe Kanban** (dominant mindshare — "kanban for coding agents", 10+ agents: Claude Code, Codex, Gemini, Copilot…), Conductor, Crystal, claude-squad | Human creates a card → tool spawns the agent in its own workspace/branch. The board *is* the workflow. |
| **Observability dashboards** | Portkey (OTEL), cost/token dashboards, "real-time dashboard for Claude Code agent teams" (Show HN) | Passive monitoring; no coordination. |
| **Coordination for ad-hoc sessions** | claude-presence (small MCP server), CLAUDE.md conventions… and Orchestra | Sessions the human already runs become aware of each other. Mostly unsolved. |

Industry-consensus answer to "N agents, same repo" is **git worktrees — isolation, not coordination**. Every best-practice guide says "never point two sessions at the same working directory."

## 2. Honest assessment of Orchestra's current value

**Real strengths**
1. **Zero workflow change.** Hooks auto-register whatever the user already runs. Vibe Kanban makes you adopt its workflow; native Teams makes you *start* work as a team. Orchestra retrofits coordination onto habits people already have (N terminals open). This is the genuinely differentiated asset.
2. **Human oversight of ad-hoc sessions.** Nobody gives you a live board of *sessions you started yourself*, with Q&A into their context. The Show HN dashboard traction validates the demand.
3. Local-first, no accounts, MIT, fails-soft hooks — adoption-friendly.

**Hard truths**
1. **Platform risk is severe.** Native Agent Teams already has the mailbox + shared task list. Each Claude Code release absorbs more of Orchestra's core. Native wins by default (no daemon, no install).
2. **The wedge use-case is an anti-pattern.** Path-overlap warnings solve a problem (two agents, one checkout) that best practice says to avoid entirely via worktrees. Sophisticated users — the ones who run multiple agents — already isolate; the warning is moot for them.
3. **Advisory warnings arrive late.** 30 s pulse throttle means the overlap can be detected after the collision.
4. **Positioning collision.** "Kanban board for agents" is owned by Vibe Kanban; launching on that phrase buys confusion, not attention.
5. As-is, v0.1.0 is a well-built narrow utility that gets squeezed between native Teams and Vibe Kanban within months if positioned head-on.

## 3. Angles worth tackling (ranked)

**A. Worktree-native: merge-conflict early warning (strongest).** Stop fighting the worktree consensus — embrace it. Track branch/worktree per card; diff-overlap *across worktrees* becomes **merge-conflict forecasting** ("your card and jade-lynx's branch both touch `src/auth/**` — expect a conflict at merge"). Worktrees isolate work but conflicts still explode at merge — that pain is real, felt by exactly the power users who run agent fleets, and nobody addresses it.

**B. Cross-tool coordination bus.** Native Teams is Claude-only and team-initiated. Orchestra's CLI is agent-agnostic: coordinate Claude Code + Codex + Gemini CLI + OpenCode sessions run independently. Vibe Kanban spawns mixed agents; nobody *coordinates* independently-run mixed agents.

**C. Ride the platform, don't fight it.** Read `~/.claude/tasks` / Teams state and be the missing live UI + persistence + cross-project view for native Agent Teams. Fast mindshare, but fragile: experimental APIs, and Anthropic will eventually ship its own UI.

**D. Status quo (pure ad-hoc board).** Fine for launch, not a durable position.

## 4. Recommendation

Position as: **"The coordination and oversight layer for agents you already run — any tool, any worktree, zero workflow change."** Concretely: launch v0.1 as-is for credibility (cheap, MIT), but put A on the roadmap immediately (worktree/branch awareness + cross-worktree conflict forecasting) and message B (agent-agnostic) in the README. Avoid "kanban for agents" phrasing entirely. Treat C as an experiment behind a flag.

The moat is not the board — boards are commoditized. The moat is **ambient auto-coordination via hooks** (no workflow change) plus **conflict forecasting across isolation boundaries** (a problem isolation *creates*).

## Sources

- https://github.com/BloopAI/vibe-kanban · https://vibekanban.com/
- https://code.claude.com/docs/en/agent-teams
- https://blog.imseankim.com/claude-code-team-mode-multi-agent-orchestration-march-2026/
- https://news.ycombinator.com/item?id=47602986 (Show HN: agent-teams dashboard)
- https://www.mindstudio.ai/blog/parallel-agentic-development-claude-code-worktrees
- https://dev.to/sahil_kat/coordinate-multiple-claude-code-sessions-on-a-shared-repo-1dh4 (claude-presence)
- https://www.eesel.ai/blog/claude-code-multiple-agent-systems-complete-2026-guide
