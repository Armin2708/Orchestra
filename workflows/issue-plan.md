---
description: Read the GitHub issue, assess the codebase with parallel subagents, plan the phase — no code yet
argument-hint: <issue-number>
allowed-tools: Read, Bash
---

Pull up GitHub issue #$ARGUMENTS with `gh issue view $ARGUMENTS`.

Dispatch subagents in parallel to read the codebase, focused only on the files this issue touches.
Look for how the current code works, what it is doing wrong, what it is missing, and what touching it
might break. Give each subagent the project context it cannot inherit:

- If `graphify-out/graph.json` exists, query the graph before grepping or reading blind; cite
  `source_location` and re-verify the file.
- If `.gitnexus/` exists, run impact analysis on the symbols in scope and report the blast radius.
- Read the knowledge sources the project's CLAUDE.md names; flag anything that contradicts the issue.

Come back with:

- What the issue is actually asking for
- What the current code does
- What needs to change, and in which files
- Any risks, blast radius, or things that could break

Register the phase on the board so the work is visible before it starts:
`orchestra card create '<issue title>' --desc '<objective; deliverables; done when>' --paths <paths> --column backlog`

Do NOT write any code yet. Come back with the full plan and wait.
Once the operator says go, run `/execute`.
