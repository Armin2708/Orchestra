# Orchestra Agent OS

Orchestra's Agent OS layer turns a project board into a durable coding workspace without taking
the terminal away. Each task can own an isolated checkout, real PTY processes, an agent session,
context, policy, evidence, checkpoints, and an append-only event history.

The original board, hooks, messaging, review gates, verification, and auto-ship workflows remain
available. Agent OS is an additional project view and API surface.

## Open the cockpit

Start Orchestra normally and open the local UI:

```sh
orchestra serve
open http://127.0.0.1:4750
```

Choose a project, then open **Workspace** in the top navigation. The cockpit has:

- a workspace/task rail;
- a raw xterm terminal backed by a real local PTY;
- the attached agent conversation;
- changed files and delivery evidence;
- process and discovered-port status;
- inspectable context and policy panes;
- a global **Needs You** queue for questions, permissions, conflicts, failures, and reviews.

On narrow screens the cockpit becomes a single-pane tabbed interface. On desktop, use
`Cmd/Ctrl+1` through `Cmd/Ctrl+7` to select panes, `Cmd/Ctrl+\`` to focus the terminal, and
`Cmd/Ctrl+K` to focus the command launcher.

## Workspaces, not hidden shells

A workspace is either the project's shared checkout or a managed git worktree. Managed worktrees
are always created outside the shared checkout and never switch its branch. Orchestra refuses to
remove dirty worktrees; archiving preserves the checkout, branch, artifacts, and history.

Create one from the cockpit or the CLI:

```sh
orchestra workspace create "auth hardening" --card 42 --kind worktree --base HEAD
orchestra workspace list
```

Resource IDs are opaque. Copy them from the cockpit or request complete JSON with `--json`.

## Real terminal semantics

Commands run through `node-pty`, not through agent chat. Input bytes, ANSI output, resize events,
signals, PID, exit code, and ordered output chunks are retained. You can always inspect or control
the same process through the HTTP API and CLI:

```sh
orchestra process start <workspace-id> npm run dev
orchestra process list <workspace-id>
orchestra process attach <process-id>   # Ctrl+] detaches without stopping it
orchestra process output <process-id>
printf '\003' | orchestra process input <process-id> --stdin
orchestra process resize <process-id> 140 40
orchestra process signal <process-id> SIGTERM
orchestra process restart <process-id>
```

After a daemon restart, processes that cannot be reattached are marked `lost` instead of being
reported as still running. Restartable process recipes retain the exact command, cwd, environment,
terminal geometry, and shell mode, so a stopped or lost process can be restarted without rebuilding
its invocation by hand.

## Task contracts and evidence

Cards remain the compatible task surface. A task contract adds a concrete objective, acceptance
criteria, dependencies, verification commands, base ref, priority, budgets, policy, and workspace.
Reading a legacy card's contract creates a deterministic default.

```sh
orchestra contract show 42 --json
orchestra contract set 42 \
  --objective "Make session renewal race-free" \
  --deliverables '[{"id":"renewal","text":"Serialize concurrent refresh","required":true}]' \
  --accept '["all auth tests pass","concurrent refresh is covered"]' \
  --verify '["npm test -- auth"]' \
  --non-goals '["Redesign authentication"]' \
  --risks '["Restart behavior needs explicit evidence"]' \
  --base HEAD
```

Evidence combines the actual diff or patch, changed files, process/test exits, verifier results,
review decisions, shipped commits, and relevant events. Agent statements are shown separately as
claims and are never promoted to evidence.

```sh
orchestra evidence list 42 --json
orchestra evidence add 42 test_report auth-tests --file ./test-results.txt --mime text/plain
```

## Delivery Trackbook

Every managed job freezes the task contract it was launched against as an immutable **Asked**
snapshot. The agent then submits a structured delivery report that compares each requested
deliverable and acceptance criterion with what was actually produced. Outcomes are explicit:
`met`, `partial`, `missed`, or `unverifiable`; omitted promises are never silently treated as done.

The Trackbook keeps three things separate:

- **Asked**: the objective, promised deliverables, acceptance criteria, verification commands,
  non-goals, risks, and contract version captured before dispatch;
- **Delivered**: the agent's summary, item-by-item outcomes, claims, files, commits, artifacts, and
  evidence references;
- **Delta**: missing, partial, failed, overridden, or still-unverified work requiring attention.

A managed card can enter **review** only after a complete report is submitted. It can enter
**done** only after the report is verified and accepted, or after an explicitly attributed human
override with a reason. Rejected reports remain in history and revisions create a new linked
attempt instead of rewriting the old one. Unmanaged manual cards retain the original board flow.

Managed Claude/Codex processes use a scoped agent credential. They can submit and verify work, but
acceptance, audited overrides, Board approval/send-back, and moving a card to **done** require the
operator credential used by the paired UI or normal human CLI session.

This prevents ordinary managed-agent API calls from self-accepting; it cannot sandbox a hostile
`full_access` process that runs as the same OS user and can read files or the SQLite database.
Strong adversarial isolation requires a separate OS/container identity or future human-presence
authentication.

See [Delivery Trackbook](delivery-trackbook.md) for the lifecycle, API, CLI, and evidence rules.

## Attention, policy, and context

`Needs You` is a projection over actionable events rather than a generic notification feed. Items
are ordered by severity and age and retain their resolution in the event trail.

```sh
orchestra attention list
orchestra attention resolve <attention-id> --resolution "approved for this task"
```

Policies evaluate filesystem paths, commands, network hosts, and secret names as `allow`, `ask`,
or `deny`. Rules are scoped to a project and can be attached to a task contract. Manual human PTY
input is always allowed but audited; configured task policies are evaluated before agent tool use.

```sh
orchestra policy create "release-safe" \
  --files 'src/**,!**/.env*' \
  --commands 'npm test*,git diff*,!git push*' \
  --hosts 'api.github.com' \
  --approval ask
orchestra policy evaluate <policy-id> command "git push origin main"
```

Context manifests show exactly what was selected for a workspace, its provenance, estimated token
cost, and whether it is pinned. The manifest is replaceable through the UI, CLI, or API.

## Checkpoints and scheduled jobs

A checkpoint captures git HEAD, the current patch, context, and restartable process recipes. A
fork creates another managed worktree from that commit and reapplies the patch without touching
the shared checkout.

```sh
orchestra checkpoint create <workspace-id> before-refactor
orchestra checkpoint fork <checkpoint-id> --name experiment-b --branch orchestra/experiment-b
```

Jobs are durable, provider-neutral requests. The scheduler respects dependency completion,
priority, global concurrency, retry limits, cancellation, and token/cost budgets. Claims are atomic
across scheduler instances, and one card cannot have two active jobs. On restart, resumable provider
sessions are reattached; non-resumable jobs are requeued or blocked according to their retry budget.
`claude` uses the existing Conductor, `codex` uses one supervised `codex app-server`, and `shell`
uses the PTY runtime. An unavailable provider remains
queued with an actionable attention item rather than silently falling back.

```sh
orchestra job create 42 --provider claude --workspace <workspace-id> --priority 10 --attempts 2
orchestra job create 43 --provider codex --workspace <workspace-id> --priority 10 --attempts 2 --tokens 50000
orchestra job list --status queued
orchestra drivers --json
orchestra plugins --json
```

Codex exposes authoritative token totals, including cached input and reasoning output, so token
budgets are enforced by interrupting the active turn. Codex does not currently expose an
authoritative per-job monetary cost through app-server, so cost-budget jobs are rejected explicitly
instead of estimating. Agent OS policies auto-answer unambiguous allowed/denied Codex command and
file requests; `ask` decisions appear in the shared approval UI.

## API and durability

All Agent OS routes are under `/api/v1/os` and inherit Orchestra's bearer-token authentication.
Every cockpit mutation has a corresponding CLI command. Kernel state is stored in the same local
SQLite database under `ORCHESTRA_HOME`; PTY output is bounded, ordered, and durable. Existing hooks
remain fail-soft, and path overlap remains advisory by default. A database-wide daemon lease ensures
only one process can reconcile PTYs and jobs for a data directory at a time.
