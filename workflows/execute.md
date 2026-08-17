---
description: Implement the planned phase in a worktree, then run an agentic code review loop until clean
allowed-tools: Read, Edit, Write, Bash
---

Implement everything from the plan produced by `/issue-plan`.

Before the first edit, register the work on the board:
`orchestra card create '<title>' --desc '<objective; deliverables; done when>' --paths <paths> --column in_progress`
If the response reports an overlap or similar in-progress work, ask that card's owner before
proceeding. Do not touch paths claimed by another active card without asking first.

Work in a git worktree. Never create or switch branches in a shared checkout — other agents may be
working in it.

Follow the existing code style. Make changes file by file. Run tests after each logical chunk and fix
anything that breaks before moving on. If `.gitnexus/` exists, run impact analysis before modifying a
symbol and stop-and-report on HIGH/CRITICAL risk.

Commit as you go, with clear messages referencing the issue number.

Once implementation is done, run an agentic code review loop:

- Read every file you touched.
- Check for out-of-context bugs, regressions, anything that does not fit the surrounding code, and
  anything left broken.
- If you find issues, fix them, commit, then review again.
- Keep looping until the review comes back clean.

When the loop is clean:

- Run the affected tests, then the full suite, and report the actual output.
- Move the card to review with Delivered / Evidence / Remaining. Never self-move a card to done.
- Say what was done, and ask whether another review pass is wanted or whether to open a PR with
  `/open-pr`.
