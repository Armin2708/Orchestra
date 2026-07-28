# Subscription-first terminal-agent strategy

Status: **delivered contract with TOOL-014 integration in progress; not provider-support evidence**.

Orchestra's primary provider path is a personal subscription used through the vendor's native
terminal coding agent. Direct usage-priced provider API execution is an optional, explicit
secondary mode. An unavailable, logged-out, incompatible, exhausted, or policy-restricted
subscription must fail visibly; it must never cause a provider or billing-mode substitution.

## Separate facts

Every managed launch must declare these independently:

| Field | Purpose |
|---|---|
| Runtime mode | native terminal CLI or explicitly selected direct provider API |
| Billing mode | personal subscription, usage-priced provider API, or unknown |
| Credential kind | provider-account OAuth/session, subscription-scoped key, usage-priced API key, or another declared mechanism |
| Capability set | exact supported lifecycle, model, approval, event, usage, hook/plugin, and recovery behavior |

A subscription-scoped key is not automatically usage-priced API billing. Conversely, launching a
native CLI does not prove subscription billing when ambient API-key variables can take precedence.

Native-launch adapters reuse CLI-owned authentication and must not copy raw credentials into Agent
OS state, logs, events, exports, or unrelated child environments. Any provider-specific credential
reader used only for account/usage metadata must be isolated, read-only, explicitly declared, and
must never persist the raw value.

## Current and target providers

| Provider | Subscription-first upstream path | Current Orchestra state | Required blocker closure |
|---|---|---|---|
| Claude Code | Claude Pro/Max login through the native CLI | Existing managed runtime now applies the contract's subscription environment rules; no TOOL-014 adapter or acceptance evidence is registered | close the automation-policy block, verify account/billing readiness, and pass the exact acceptance matrix |
| Codex CLI | ChatGPT account login through the native CLI | The real app-server adapter, durable matrix storage, and authorized restart recovery are implemented, but Codex remains candidate/unsupported with no real acceptance record | verify exact ChatGPT account/billing mode and pass all eight real acceptance gates before reconciling support |
| Qwen Code | Alibaba Cloud Coding Plan through `/auth`, using its subscription-scoped key and coding endpoint | Manual interactive raw-terminal use only | exact adapter/version matrix and provider confirmation for autonomous/background personal-plan use |
| Kimi Code | Kimi membership through `kimi login` or `/login` OAuth device flow | Manual raw-terminal use only | ACP adapter/version matrix and explicit detection/consent for optional metered Extra Usage |

Qwen Code's retired OAuth free tier is not a current subscription path. Current Coding Plan terms
restrict non-interactive scripts/custom backends, so Orchestra must keep autonomous personal-plan
orchestration disabled unless the provider confirms it is permitted.

Kimi membership's optional Extra Usage can consume metered balance after subscription quota when
enabled. OAuth readiness alone therefore does not prove a zero-overage session. Orchestra must
surface that provider-managed state when it can verify it, otherwise fail closed for a
zero-overage policy.

## Adapter contract

Each declared provider supplies one versioned manifest and implementation for:

- executable discovery, provenance, exact version range, and supported operating systems;
- safe environment construction and subscription/API contamination checks;
- authentication readiness, billing mode, credential kind, and provider policy restrictions;
- launch, follow-up, resume, restart recovery, fork where supported, interrupt, cancel, and stop;
- model discovery/selection, effort or reasoning controls, and explicit unsupported behavior;
- native capabilities, MCP/plugins/skills/hooks, effective permissions, and approval decisions;
- normalized events with provider-native identifiers and credential-safe projection;
- usage, subscription windows/quotas, provider-managed overage, and unavailable-state semantics;
- raw PTY coexistence so arbitrary shells, git, package managers, and installed tools remain
  available.

Terminal scraping alone cannot establish managed resume, approval, usage, or model capability.
Prefer a provider's documented structured protocol—such as Codex app-server or Kimi ACP—while
keeping the raw native terminal as a separate first-class surface.

TOOL-013 delivers the provider-neutral version-1 contract and canonical first-release manifests.
The gateway assigns every managed session ID before invoking an adapter, seals the authorized
selection and effective access evidence, translates controls and events through that assigned ID,
and quarantines adapter/provider identities until stream cleanup is proven complete. Environment
rules bind each managed credential, endpoint, selector, and provisioning variable to its owning
provider/adapter and billing mode. Failed, malformed, or hung cleanup remains bounded by the live
session-capacity limit instead of being evicted by age.

This is a contract boundary, not an adapter-support claim. Adapter implementations are trusted
in-process Orchestra code; the boundary validates and redacts their returned data and contains
ordinary callback failures through the supplied signal API, but it is not a sandbox for deliberate
arbitrary code running in the daemon.

The first TOOL-014 integration slice adds a capability-checking bridge from the existing
`AgentDriver` lifecycle to the version-1 provider contract. It preserves the gateway-authorized
cwd, prompt, environment, model, effort, access profile, cost boundary, and session identity;
normalizes driver events and usage; and refuses any capability the driver cannot implement. The
Agent OS runtime also owns a support-claim registry. That registry requires an exact provider,
adapter/version, mode, runtime, billing, credential, executable-version, platform, and source-commit
tuple with all eight release gates passed before it can return a supported adapter.

The existing Claude and Codex spawn boundaries now remove contract-declared API credential and
endpoint conflicts from managed personal-subscription environments. This prevents ambient
usage-priced or cross-provider credentials from silently changing the selected path; it does not
prove login state, billing mode, provider policy, or real-session compatibility.

The canonical Codex adapter is now registered as an implementation, migration 019 stores
append-only source-commit/artifact-bound matrices, and an opt-in production wrapper dispatches only
after `requireSupported(...)`. No real acceptance matrix exists, so Codex's candidate manifest and
unknown native-subscription mode deliberately prevent that route from enabling; default production
dispatch remains on the existing driver path. TOOL-014, BASE-010, and provider acceptance remain
open. The support states above do not change, and Qwen Code and Kimi Code remain raw-terminal only.

The third TOOL-014 slice adds authorized Codex restart recovery without making raw attach public
authority. The single-use resume action seals the provider-session ID, workspace scope, cwd, model,
effort, access ceiling, and cost boundary. Agent OS reconstructs that action only from its durable
job/session/workspace binding, the adapter revalidates the active workspace before calling native
`thread/resume`/`thread/read`, and persisted turn overrides are restored before event streaming
continues. Raw `attach(providerSessionId)` remains unsupported on the contract wrapper. These are
implementation capabilities only: the candidate provider/mode and exact acceptance gate still
prevent production support.

## Release acceptance

For every claimed provider and operating-system tuple:

1. Install the official CLI in a clean profile and verify executable provenance/version.
2. Remove usage-priced API credentials, complete the subscription path, and verify billing mode
   without exposing raw secrets.
3. Seed conflicting API credentials/config and prove the adapter refuses ambiguity or preserves
   the explicitly selected subscription path.
4. Launch a real task, complete a second turn, select a model, handle approve/reject/timeout, and
   record redacted structured events and usage.
5. Cancel generation and tool execution, restart the CLI and Orchestra, then resume the same
   provider session when supported.
6. Keep a concurrent real PTY usable for shell commands, files, git, packages, signals, resize,
   ANSI output, and provider-native TUI access.
7. Verify exhausted/revoked credentials, incompatible versions, unsupported capabilities,
   provider-policy restrictions, and overage state fail visibly without provider/billing fallback.
8. Prove credentials and raw approval parameters never enter managed events, logs, Trackbook
   records, diagnostics, or exports.

No provider is advertised as compatible until this matrix passes for its exact frozen adapter,
mode, billing, credential, executable-version, platform, and source-commit tuple.

## Official upstream references

- [Codex authentication](https://learn.chatgpt.com/docs/auth?surface=cli)
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Qwen Code repository](https://github.com/QwenLM/qwen-code)
- [Qwen Code authentication](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)
- [Alibaba Cloud Coding Plan scope and billing](https://www.alibabacloud.com/help/en/model-studio/coding-plan)
- [Kimi Code repository](https://github.com/MoonshotAI/kimi-code)
- [Kimi Code CLI getting started](https://www.kimi.com/help/kimi-code/cli-getting-started)
- [Kimi Code membership behavior](https://www.kimi.com/code/docs/en/kimi-code/membership.html)
