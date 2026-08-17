---
description: Plan against the project's knowledge sources, then build in a git worktree with parallel subagents and orchestra card tracking
---

Build the requested changes end-to-end. Follow this loop, and carry the project's
knowledge sources into every subagent you spawn — subagents do not reliably inherit
the project's CLAUDE.md, so restate the standing instructions in each prompt.

## 1. Understand before sketching

- Read the project's CLAUDE.md first and honour whatever knowledge sources it names.
- If `graphify-out/graph.json` exists, query the graph FIRST (`/graphify query "<the question / feature>"`)
  before any grep/read sweep. Trace links with `/graphify path "A" "B"` and understand nodes with
  `/graphify explain "Name"`. Cite the `source_location` it returns and re-verify the file —
  graphs go stale on exact line numbers.
- If the project documents an Obsidian vault (see its CLAUDE.md), search it before non-trivial work.
  If a note contradicts the planned change, flag it before writing code — do not silently override it.
- If `.gitnexus/` exists, run impact analysis on every symbol you will modify and report the blast
  radius. Treat HIGH/CRITICAL risk as stop-and-report, not as a speed bump.
- Divide labour between the tools: call-graph, impact and rename questions go to the index;
  architecture, docs and rationale questions go to the knowledge graph. Do not run both for the same question.

## 2. Plan and register the work

- Sketch every required change before touching code. When presenting options, pick the recommended
  one and proceed — do not stall for approval on routine calls.
- Register the work on the board before your first edit:
  `orchestra card create '<title>' --desc '<objective; deliverables; done when>' --paths <paths> --column in_progress`
- If the response shows an overlap or similar in-progress work, ask that card's owner before proceeding
  (`orchestra ask <agent> '<question>'`) and scope your work so it does not duplicate theirs.

## 3. Build in a worktree

- Create a git worktree for the change. Never create or switch branches in a shared checkout —
  other agents may be working in it.
- Dispatch subagents in parallel wherever tasks are independent; give each one the project context
  it cannot inherit, plus these standing instructions:
  - "If `graphify-out/graph.json` exists, query the graph before grepping or reading blind; cite
    `source_location` and re-verify the file."
  - "Read the knowledge sources named in the project's CLAUDE.md before non-trivial work; never write
    secrets or personal data into them."
  - "If `.gitnexus/` exists, run impact analysis before editing any symbol and do not ignore
    HIGH/CRITICAL risk."

## 4. Verify and capture

- Run the affected tests first, then the full suite. Report actual output — never claim a pass you
  did not observe.
- Refresh the knowledge graph after meaningful code or doc changes (`/graphify . --update`, incremental).
  If you skip the refresh, say explicitly that the graph is stale.
- Record architectural decisions, new conventions and surprising gotchas in whatever the project uses
  for durable notes (its vault or docs directory), following that project's template and naming rules.

## 5. Hand back

- Move the card to review with Delivered / Evidence / Remaining. Never self-move a card to done —
  done means human-accepted.
- Mail a completion report the operator can act on alone:
  `orchestra mail '<subject>' '<what shipped; how to verify; open questions>' --type action`
- Report what shipped, which knowledge artifacts you updated, and anything flagged or deferred.
