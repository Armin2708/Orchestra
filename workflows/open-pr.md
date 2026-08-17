---
description: Push the current branch and open a pull request that references the issue
allowed-tools: Bash
---

Check the current branch with `git branch --show-current`, and confirm it is the branch you actually
worked on — never push from a shared checkout you did not intend to change.

Push it: `git push origin <branch>`

Open a PR with `gh pr create`. The title references the issue. The body includes:

- `Closes #<issue-number>`
- What was done
- What files changed
- How to verify it (the commands you ran and their result)

Print the PR URL when done.

Mail the operator so the handoff is on the board, not just in chat:
`orchestra mail '<subject>' '<PR URL; what shipped; how to verify>' --type action`

Say that `/review-comments` handles the reviews once they come in.
