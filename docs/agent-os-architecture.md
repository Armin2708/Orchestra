# Orchestra Agent OS Architecture

Status: implemented on `codex/agent-os`.

## Product invariants

1. Existing board, hook, CLI, review, verification, and auto-ship behavior remains compatible.
2. The terminal is never hidden: every managed workspace can expose a raw PTY, exact output,
   exit status, signals, and command history.
3. Core state is provider-neutral. Claude, a generic shell, and future providers are drivers.
4. New state is reconstructable from durable records; in-memory projections are caches only.
5. Every UI mutation has a documented HTTP endpoint and can be driven from the CLI.
6. Hooks remain fail-soft. Policies default to advisory unless explicitly configured otherwise.

## Kernel nouns

- `Workspace`: isolated execution root (shared checkout or git worktree), branch, environment,
  lifecycle, ports, and linked task.
- `AgentSession`: provider-backed conversation/process attached to a workspace.
- `Process`: a PTY-backed command with durable output, status, exit code, and restart recipe.
- `TaskContract`: executable metadata layered over an existing card.
- `DeliveryReport`: immutable Asked snapshot plus revisioned Delivered, verification, override,
  and acceptance records for one managed job.
- `Event`: append-only causal record for commands, tools, files, tests, permissions, questions,
  reviews, and shipping.
- `Artifact`: diff, patch, test report, screenshot, log, evidence bundle, or other durable output.
- `Policy`: scoped filesystem, command, network, secret, and approval rules.
- `AttentionItem`: one actionable human interruption.
- `Checkpoint`: git/context/process recipe snapshot that can be forked safely.
- `Job`: scheduled execution request with provider, priority, retries, and budgets.
- `ContextItem`: inspectable, attributable context selected for a task/session.

Cards remain the compatibility task surface. `task_contracts.card_id` is the stable one-to-one
bridge; the board becomes a projection over task/workspace state.

## Database contract

Add idempotent migrations in a separate module called by `openDb`:

- `workspaces(id, board_id, card_id, name, kind, root_path, worktree_path, branch, base_ref,
  status, env_json, created_at, updated_at)`
- `agent_sessions(id, workspace_id, agent_id, provider, external_id, model, status,
  context_json, created_at, updated_at)`
- `processes(id, workspace_id, name, command, cwd, status, pid, exit_code, cols, rows,
  restartable, recipe_json, started_at, ended_at)`
- `process_output(id, process_id, seq, stream, data, created_at)`
- `os_events(id, board_id, workspace_id, card_id, session_id, process_id, kind, source,
  payload, created_at)`
- `artifacts(id, board_id, workspace_id, card_id, kind, name, mime_type, path, content,
  metadata, created_at)`
- `policies(id, board_id, name, file_globs, command_globs, network_hosts, secret_names,
  approval_scope, created_at, updated_at)`
- `task_contracts(card_id, objective, acceptance_criteria, dependencies, base_ref,
  verify_commands, budget_tokens, budget_cents, priority, policy_id, workspace_id, updated_at)`
- `attention_items(id, board_id, workspace_id, card_id, agent_id, kind, severity, title,
  detail, status, created_at, resolved_at)`
- `checkpoints(id, workspace_id, session_id, name, git_head, patch_artifact_id, context_json,
  process_recipes, created_at)`
- `jobs(id, board_id, card_id, workspace_id, provider, model, priority, status, attempts,
  max_attempts, budget_tokens, budget_cents, spent_tokens, spent_cents, scheduled_at, started_at,
  finished_at, error)`
- `context_items(id, board_id, workspace_id, card_id, kind, source, content, tokens, pinned,
  provenance, created_at, updated_at)`
- `delivery_reports(id, lineage_id, parent_report_id, sequence, board_id, card_id, job_id,
  session_id, workspace_id, status, asked_snapshot, summary, delivered_items, claims_json,
  changed_files, commits, artifact_ids, gaps, actors, timestamps...)`
- `delivery_deliverable_results(report_id, deliverable_id, outcome, note, evidence_refs,
  override_actor, override_reason, override_at, actor, timestamps...)`
- `delivery_criterion_results(report_id, criterion_id, outcome, note, evidence_refs,
  override_actor, override_reason, override_at, actor, timestamps...)`
- `daemon_leases(name, owner_id, pid, acquired_at, heartbeat_at)`

Foreign keys should cascade only for generated child records. Never delete a dirty worktree or
an artifact implicitly.

## Runtime contract

`RuntimeSupervisor` owns live PTYs and process lifecycle. It accepts callbacks for durable events
and output persistence so the runtime module can be tested without Fastify.

Required operations:

- create/list/get/update/archive workspaces;
- create or reuse a worktree without switching the shared checkout;
- spawn PTY command with explicit cwd/env/cols/rows;
- write input, resize, signal, stop, and read output from an offset;
- record PID/status/exit code and bounded durable output;
- discover listening ports for workspace processes where supported;
- mark previously-running records `lost` after daemon restart and expose restart recipes;
- reconcile durable jobs by reattaching resumable sessions or consuming their retry budget;
- acquire a database-wide daemon lease before runtime reconciliation;
- safely fork a checkpoint into a new worktree and apply its patch.

Use a real PTY backend (`node-pty`) and xterm-compatible byte streams. Transport may use the
existing SSE bus plus REST input/resize/signal endpoints; it must not fake a terminal by sending
agent chat messages.

## Provider driver contract

```ts
interface AgentDriver {
  readonly id: string
  capabilities(): DriverCapabilities
  launch(request: DriverLaunchRequest): Promise<DriverSession>
  attach(externalId: string): Promise<DriverSession | null>
  send(sessionId: string, text: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  stop(sessionId: string): Promise<void>
  events(sessionId: string): AsyncIterable<DriverEvent>
}
```

Ship a `claude` adapter around the existing `Conductor` semantics and a `shell` adapter backed by
`RuntimeSupervisor`. Server/UI code must consume driver-neutral types.

## Service/API contract

All new routes live under `/api/v1/os`:

- `GET|POST /boards/:id/workspaces`
- `GET|PATCH|DELETE /workspaces/:id`
- `GET|POST /workspaces/:id/processes`
- `GET /processes/:id`
- `GET /processes/:id/output?after=<seq>`
- `POST /processes/:id/input`
- `POST /processes/:id/resize`
- `POST /processes/:id/signal`
- `POST /processes/:id/restart`
- `GET /boards/:id/events`
- `GET /boards/:id/attention`
- `POST /attention/:id/resolve`
- `GET|PUT /cards/:id/contract`
- `GET|POST /cards/:id/evidence`
- `GET|PUT /workspaces/:id/context`
- `GET|POST /boards/:id/policies`
- `POST /policies/:id/evaluate`
- `GET|POST /workspaces/:id/checkpoints`
- `POST /checkpoints/:id/fork`
- `GET|POST /boards/:id/jobs`
- `POST /jobs/:id/cancel`
- `GET /cards/:id/deliveries`
- `POST /jobs/:id/deliveries/prepare`
- `POST /jobs/:id/deliveries/submit`
- `POST /deliveries/:id/verify|accept|reject|revise`
- `GET /deliveries/:id/export?format=human|json`
- `GET /boards/:id/conflicts`
- `GET /drivers`
- `GET /plugins`

Route registration belongs in a plugin-style module called from `buildServer` to minimize the
critical blast radius. Tests must cover auth inheritance, validation, isolation, and failure paths.

## Task contracts and evidence

Task contracts contain objective, structured acceptance criteria, dependencies, base ref,
verification commands, priority, token/cost budgets, policy, and workspace. Existing cards without
a contract receive a deterministic default on first read.

Evidence bundles are artifacts assembled from the contract, actual diff/diffstat, changed files,
verification result, test/process exit evidence, review decisions, shipped commit, and relevant
events. Agent claims are labeled as claims, never evidence.

## Delivery lifecycle and gates

The scheduler creates a draft delivery report before provider dispatch and freezes the current
task-contract version into `asked_snapshot`. Contract edits affect later jobs only. Submission must
account for every promised deliverable and criterion, including explicit gaps. Independent
verification records evidence-backed results without converting agent claims into proof.

The lifecycle is monotonic and audited:

```text
draft -> submitted -> verified -> accepted
                   \-> rejected -> revised draft
```

Managed cards are identified by a canonical job record. Their move-to-review paths require a
submitted report; move-to-done and approval paths require acceptance. Compatibility projection
creates reports for legacy launches without retroactively placing strict gates on manual cards.
Human overrides preserve the original partial, missed, or unverifiable outcome and add actor,
reason, target, and timestamp rather than mutating history.

The API authenticates operator and managed-agent credentials as distinct principals. Managed
Claude/Codex subprocesses receive only the scoped agent credential during normal launch. Reporting
and independent verification accept that credential; accept/reject/override, Board approval or
send-back, and any move to `done` require the operator principal and record the actor server-side.

## Attention projection

Create/resolve attention items for agent questions, permission requests, path/conflict warnings,
failed processes/tests, failed verification, blocked jobs, and review requests. The endpoint returns
open items ordered by severity then age. Existing message/review flows should emit these records
without changing their current behavior.

## Scheduler

The durable scheduler runs queued jobs by priority while respecting `ORCHESTRA_MAX_LAUNCHED`,
dependencies, retry count, cancellation, and budgets. Job claims and global capacity checks share
one immediate transaction, duplicate active card jobs are rejected durably, and usage is recorded
before retry decisions. It records every transition. The first provider set is `claude` and `shell`;
unsupported providers remain queued with an actionable error rather than silently falling back.

## Policy engine

Evaluate normalized operations against policy globs and return `allow`, `ask`, or `deny` plus a
human-readable reason. Cover filesystem paths, shell commands, network hosts, and secret names.
Manual human PTY input is not AI-mediated and is always allowed, but remains audited. Agent tool
requests use the policy engine before the existing permission-mode fallback.

## Cockpit

Add a keyboard-first `WorkspaceCockpit` reachable from project navigation. It contains:

- workspace/task rail;
- real xterm terminal and process controls;
- agent conversation pane;
- changed-files/diff/evidence pane;
- Asked-versus-Delivered Trackbook with revision history and evidence gaps;
- preview/process/port pane;
- context manifest and policy pane;
- global `Needs You` attention drawer;
- loading skeleton, useful empty state, and visible inline errors.

Keep the existing warm monochrome palette, no gradients, no heavy shadows, no emoji-only controls,
and no generic three-card dashboard. Desktop uses an asymmetric cockpit grid; mobile collapses to
one pane with explicit tabs. All controls need labels and keyboard access.

## CLI parity

Add `orchestra workspace`, `process`, `attention`, `contract`, `evidence`, `checkpoint`, `job`,
`policy`, and `drivers` command groups over the same HTTP APIs. `process attach` preserves raw PTY
semantics and `process restart` uses the durable recipe. Preserve existing commands.

## Verification

- Existing full suite remains green.
- New unit tests cover migrations, event store, policy evaluation, scheduler, evidence, workspace,
  PTY lifecycle, output ordering, checkpoint fork safety, and driver contracts.
- API integration tests cover every route family and auth.
- Web typecheck/build and backend typecheck/build pass.
- Package dry-run must include native runtime dependencies correctly.
- Browser QA covers loading, empty, error, desktop cockpit, mobile collapse, terminal interaction,
  attention resolution, and evidence review.
