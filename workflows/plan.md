---
description: Explore the codebase with parallel subagents, then file phased GitHub issues for the work
argument-hint: <what you're trying to achieve>
allowed-tools: Read, Bash
---

Goal: $ARGUMENTS

Explore the codebase before proposing anything. Dispatch subagents in parallel where the areas are
independent; each one reads the files relevant to the goal and reports what exists, what is missing,
what is broken, what is hardcoded, and what conflicts.

Give every subagent the context it cannot inherit:

- If `graphify-out/graph.json` exists, query the graph before grepping or reading blind, cite
  `source_location`, and re-verify the file.
- If `.gitnexus/` exists, use it for call-graph and impact questions instead of manual tracing.
- Read the knowledge sources the project's CLAUDE.md names.

Run an agentic loop: search → find → register findings → search again, until there is nothing left
to find. Do not stop early on the first plausible answer.

Once the loop is done:

- Collect every finding into one full list.
- Categorise them (hardcoded values, missing logic, deprecated code, sync issues, and so on).
- Group the work into phases (Phase 1, 2A, 2B, 2C, …) from smallest to largest scope.
- For each phase, open a GitHub issue stating the problem, every finding that belongs to it, and the
  proposed fix: `gh issue create --title '<phase>' --body '<problem; findings; proposed fix>'`.
- Assign each issue to the operator.

Print all issue numbers and titles when done.
Say which phase to start with, and that `/issue-plan <number>` begins it.
