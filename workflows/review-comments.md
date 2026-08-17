---
description: Triage PR comments and failing checks — decide what's valid, implement it, push, reply
allowed-tools: Read, Edit, Write, Bash
---

Fetch all PR comments: `gh pr view --comments`
Also check the failing checks: `gh pr checks`

For each comment, say whether it is valid and necessary or not. If it is, implement it. If it is not,
explain why it can be skipped — do not silently drop review feedback.

Fix every failing test and lint error. Reproduce the failure locally before fixing it, so the fix
addresses the actual cause rather than the symptom.

Once everything is addressed, commit and push: `git push origin <branch>`

Reply to the resolved comments on the PR with `gh pr comment`, saying what changed for each.

When done, report whether the PR is ready to merge or what is left, and keep the board in step:
move the card to review with Delivered / Evidence / Remaining, and never self-move it to done.
Then name the next issue number to start.
