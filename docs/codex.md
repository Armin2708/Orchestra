# Codex integration

Orchestra supports Codex in two complementary modes:

1. Ambient Codex sessions use Orchestra hooks to register, heartbeat, exchange board messages,
   report approvals/subagents, and coordinate paths with Claude sessions.
2. Daemon-managed Codex agents use one supervised `codex app-server` process for interactive
   threads, card launches, Agent OS jobs, streaming events, approvals, and restart recovery.

Both modes persist `provider='codex'` and a namespaced native thread ID. Neither can silently fall
back to Claude.

## Install and verify

The protocol snapshot and CI target Codex CLI `0.144.6`.

```sh
npm i -g @openai/codex@0.144.6
codex login
codex login status
orchestra install --provider both
orchestra restart
```

Use only Codex hooks with `--provider codex`, or project-local hook configuration with `--project`.
Project/plugin hooks must be reviewed in Codex `/hooks` after the project is trusted.
Global hook installation honors `CODEX_HOME` when it is set. Orchestra's bundled manifests invoke
the exact package version they shipped with rather than downloading a mutable `latest` release.

Confirm the daemon sees both providers:

```sh
orchestra drivers --json
curl -s http://127.0.0.1:4750/api/v1/os/providers
```

The provider response includes availability, non-identifying auth state, app-server health/CLI
version, models, capabilities, usage, and rate limits. Account email and reset-credit identifiers
are intentionally omitted. If Orchestra uses bearer authentication, include the same token as the
web client.

The header's **Usage** control combines Claude's subscription windows with every Codex rate-limit
bucket returned by app-server, including model-specific pools. Hover, focus, or click it to inspect
percent used, reset time, ChatGPT plan, stale/error state, available reset credits, and the Codex
lifetime token total. The compact button shows the highest current utilization across providers.

## Choose Codex

Set worker and specialist defaults in Settings, use the provider selector beside **Hire** or a card
**Launch** button, or override a single CLI launch:

```sh
orchestra hire \
  --provider codex \
  --model gpt-5.4 \
  --effort high \
  --access-profile workspace_write

orchestra task <agent-name> 'Implement the ticket and run its verification commands.'
```

Agent OS jobs use the same driver:

```sh
orchestra job create <card-id> \
  --provider codex \
  --workspace <workspace-id> \
  --tokens 50000
```

The selected provider is immutable for a live agent. Stop it and create a new agent to change
providers. If Codex is unavailable, the API returns `503`, manual hire creates no row, and durable
jobs stay/re-enter the queue with their card claim released.

## Security and approvals

Orchestra maps neutral access profiles to Codex policy explicitly:

| Orchestra profile | Codex sandbox | Approval policy |
|---|---|---|
| `read_only` | `read-only` | `on-request` |
| `workspace_write` | `workspace-write` | `on-request` |
| `full_access` | `danger-full-access` | `on-request` |

`full_access` is never inferred from Claude's `bypassPermissions`; it requires an explicit selection
and warning confirmation. Agent OS launches default to `workspace_write`, even when no task policy is
attached. Specialist roles default to `read_only` and receive their role contract as Codex developer
instructions.

The app-server child receives a small environment allowlist: OS/process basics, locale, proxy/CA,
`CODEX_HOME`, XDG paths, and Codex/OpenAI authentication variables. It does not inherit unrelated
database, cloud, GitHub, Orchestra, Anthropic, or Claude secrets. If a custom installation needs an
additional variable, opt it in by name—for example
`ORCHESTRA_CODEX_FORWARD_ENV=MY_CORPORATE_CA_HINT`—then restart Orchestra. Orchestra/Claude secrets
remain blocked even if named there. Login state is read only with app-server `account/read`; Orchestra
does not parse Codex auth files.

Command, file-change, permissions, structured user-input, and MCP elicitation requests appear in
the agent terminal. Multi-question requests retain their individual answers. MCP forms preserve
string, number, integer, boolean, enum, and multi-select values; URL elicitations expose the native
sign-in link and return the user's decision to app-server. Codex supports allow once, allow for
session, deny, and cancel through the provider-neutral approval API where the native request does.
When an Agent OS task contract has a policy, unambiguous allow/deny decisions are applied before
human prompting; unmatched `ask` decisions and interactive questions remain pending, and malformed
command/file policy requests fail closed.

The terminal is a semantic transcript, not an app-server protocol console. Assistant, reasoning,
and command-output deltas are coalesced into stable entries; tool start/completion updates replace
their prior entry; token counters, thread state, hooks, MCP startup notifications, and unknown native
events stay out of the visible feed. State transitions, approvals, errors, usage accounting, and the
Agent OS raw event log remain intact for control and recovery.

## Lifecycle and recovery

One daemon owns one app-server and multiplexes all Codex threads. It uses JSONL RPC over stdio with
bounded frames, request timeouts, stderr diagnostics, bidirectional approval requests, graceful
shutdown, and bounded exponential restart backoff.

Graceful daemon shutdown detaches local subscriptions without interrupting provider turns or marking
durable jobs failed. The next daemon exclusively reattaches each native thread. A failed reconnect is
terminalized and handed to normal job recovery instead of leaving an open event stream forever.

Native thread/turn/item IDs, completed-item dedupe set, usage totals, model, effort,
access profile, card/workspace mapping, and rate-limit pause snapshot are durable. On an app-server
restart, known threads are resumed and read before events continue. On an Orchestra restart, legacy
board agents and Agent OS jobs take separate single-consumer recovery paths, avoiding duplicate
turns, usage, or card claims.

Retrying Codex rate-limit errors park the board agent in `paused_provider`; authoritative quota/reset
data is persisted when available, and the app-server's retry resumes the agent on the next active
turn event. Cached input remains a subset of input and is never added twice. Token budgets are
enforced; cost budgets are reported unsupported because Codex app-server does not provide an
authoritative per-job cost.

## Compatibility and protocol drift

Run the same gate used in CI:

```sh
npm run check:codex-protocol
```

It generates experimental app-server TypeScript bindings, checks the pinned CLI version, and
compares a deterministic protocol digest. A mismatch is a review gate: audit `src/codex/protocol.ts`
and runtime mappings, then deliberately update `scripts/codex-protocol-contract.json`. For an
intentional local comparison with another CLI version, set
`ORCHESTRA_CODEX_PROTOCOL_ALLOW_UNSUPPORTED=1`; this does not bypass the digest check.

To use a non-default binary, set `ORCHESTRA_CODEX_COMMAND` to its executable path before starting
the daemon.

Run full operator readiness before startup:

```sh
orchestra doctor --provider codex
```

This checks the exact Codex CLI version and `codex login status` without printing raw provider output.
Use `orchestra doctor --provider codex --compatibility-only` when an automated gate must not inspect
login state.

The daemon first enforces the fail-closed core toolchain and native Claude runtime contract, then
applies the exact Codex version check before app-server starts. See the
[supported-environment matrix](supported-environments.md) for the complete Node, npm, provider,
platform, and whole-toolchain evidence.

## Troubleshooting

| Symptom | Check |
|---|---|
| Codex is unavailable | Run `orchestra doctor --provider codex`, then `codex login status` and `orchestra restart`. |
| Authenticated after daemon startup | Restart Orchestra so the runtime/driver registry is enabled safely. |
| Provider says reconnecting | Inspect provider health and wait for bounded app-server restart; launches fail `503` meanwhile. |
| No models | Start with a supported CLI/account and inspect `/api/v1/os/providers`; cached models remain visible if discovery fails. |
| Approval not visible | Open the agent terminal; verify its `approvals` capability and the Codex/plugin hook trust state. |
| Ambient agent lingers | Codex has no SessionEnd hook; Orchestra's reaper expires it. Daemon-managed agents stop explicitly. |
| Cost-budget job is blocked | Use a token budget; Orchestra refuses unverified Codex cost estimates. |
