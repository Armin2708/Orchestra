# Supported environments

This matrix is the current BASE-010 compatibility candidate for Orchestra. It describes
what has actually been exercised; it is not a claim that the complete product is plug-and-play or
ready for public release.

The labels below apply to the named evidence layer. A validated executable/protocol tuple is not a
validated managed-provider release, and a host-observed toolchain is not a clean-machine package
lifecycle. The release decision remains fail-closed when those layers disagree.

Labels mean:

- **Validated** — the exact version and platform scope has an observed host, compatibility-container,
  or CI gate.
- **Experimental** — the version is inside an evaluation range or has package coverage, but lacks
  the complete observed gate. `orchestra doctor` does not call it ready.
- **Unsupported** — Orchestra refuses the required managed-provider preflight.

## Runtime and package tooling

| Component | Validated | Experimental | Unsupported |
|---|---|---|---|
| Node.js | exact `22.20.0` on Ubuntu 24.04 x64 and Darwin arm64 | other `>=22.20.0 <23` versions | `<22.20.0`, `>=23`, missing, or unparseable |
| npm | exact `10.9.3` with Node `22.20.0` | other `>=10.9.3 <11` versions | `<10.9.3`, `>=11`, missing, or unparseable |
| Git | functional readiness range `>=2.30.0 <3.0.0`; host-observed with `2.50.1` on Darwin | none | `<2.30.0`, `>=3.0.0`, missing, or unparseable |

Release evidence and package lifecycle tests use exact Node `22.20.0` and npm `10.9.3`. The package
engines admit only later versions in the same major evaluation range, while the doctor remains
fail-closed unless an exact observed platform + Node + npm tuple matches. Known component versions
are not combined into untested Cartesian products.

## Managed providers

No provider is release-validated at integrated code head
`58fc112a94c2253dd04f2ba617a6477b11d3d966`. The table separates deterministic implementation
compatibility from the managed beta support decision.

| Surface | Implementation tuple | Managed beta support |
|---|---|---|
| Codex managed runtime | Candidate adapter for Codex CLI `0.146.0`, `codex app-server`, stdio JSONL, the checked-in 701-file protocol digest, and a clean signed-out app-server lifecycle probe | **Unsupported** until an exact clean-profile native-subscription acceptance matrix passes; every other CLI version also fails closed |
| Claude managed runtime | Deterministic SDK/native tuple `@anthropic-ai/claude-agent-sdk` `0.3.212`, native package `0.3.212`, bundled Claude Code `2.1.212` | **Unsupported** until subscription automation policy authority and an exact clean-profile native acceptance matrix exist |
| Qwen Code | Credential-safe discovery and an explicit interactive-only personal-plan policy boundary | **Unsupported**; no accepted managed adapter/version/platform tuple and autonomous personal-plan policy remains blocked |
| Kimi Code | Candidate ACP implementation with an explicit Extra Usage consent boundary | **Unsupported**; no accepted native login/overage/cap matrix |
| Ambient Claude CLI | Host-observed `2.1.170` and `2.1.217` version commands only | Experimental raw-terminal use; not a managed-runtime support claim |

Orchestra's Claude conductor does not set `pathToClaudeCodeExecutable`, so SDK `0.3.212` uses its
built-in executable. Doctor resolves the actual platform-native optional package and runs that
binary's `--version`; base-package metadata alone cannot pass. The npm dependency is exact-pinned to
stop published installs from silently moving to an unreviewed SDK/CLI pair.

Codex app-server is the documented
[deep-integration surface](https://learn.chatgpt.com/docs/app-server) for authentication, thread
history, approvals, and streamed events. Its generated protocol remains CLI-version-specific.
Orchestra therefore accepts only CLI `0.146.0`, whose generated schema digest is recorded in
`scripts/codex-protocol-contract.json`. The 0.146.0 reconciliation compared its 701 generated files
with the former 0.144.6 snapshot, audited every request/response shape Orchestra consumes, and ran
initialize, signed-out account read, model list, read-only thread start/read, and unsubscribe in a
new isolated profile. Nearby versions are not assumed compatible.

The provider-neutral contract version 1 and the first TOOL-014 integration slice have source-level
and test validation on the observed Darwin/Node 22.20.0 host. The contract covers gateway-assigned
session identity, sealed launch/fork evidence, provider-owned environment rules, explicit billing
and credential modes, lifecycle controls, normalized events and usage, bounded cancellation, and
cleanup quarantine. The integration slice adds a capability-checking `AgentDriver` bridge, an
Agent OS support-claim registry, and exact source-commit-bound acceptance evidence. Existing managed
Claude and Codex launches now apply the contract's personal-subscription environment rules, so
declared API credentials and endpoint selectors cannot silently replace that path.

The second TOOL-014 slice registers the real Codex app-server adapter as an implementation,
persists append-only exact-tuple acceptance evidence through migration 019, and adds an opt-in
Agent OS production wrapper that requires the exact source commit and never falls back to the raw
driver. This is implementation evidence, not provider acceptance. No real matrix is persisted,
Codex remains candidate/unsupported at the registry gate, and the opt-in route therefore cannot
enable yet. The slice does not remove Claude's policy block or add Qwen Code/Kimi Code managed
support.

The third TOOL-014 slice implements Codex resume/restart recovery behind that same gate. Resume
authority is single-use and seals the exact provider session, workspace, cwd, model, effort, access
ceiling, and cost boundary. Agent OS prefers this durable recovery path when a driver exposes it;
legacy drivers retain their existing internal attach path. The contract wrapper still exposes no
raw attach authority. Codex native-subscription resume/restart are therefore declared implemented
capabilities while the provider remains candidate and its mode remains unknown; neither capability
declaration nor source-level tests substitute for the missing clean-profile eight-gate matrix.

The repository now also has a two-phase Codex acceptance harness. It installs the official pinned
package into a new isolated profile, records registry and executable provenance, requires official
ChatGPT device login through the CLI, and writes one redacted digest-bound artifact per gate. The
harness requires a clean exact source commit and refuses to persist incomplete evidence. Its
implementation, protocol digest, and signed-out live probe are not provider acceptance: the clean-profile credentialed run
is still pending, Codex remains candidate/unsupported, and no production support claim changes.

## First-release provider candidates not yet supported

All five providers are in the product target, but none has passed the complete exact
provider/adapter/mode/billing/credential/version/platform/source/eight-gate acceptance contract.
Claude, Codex, Qwen, Kimi and OpenCode therefore remain **Unsupported** for managed beta launch.
Installed CLIs remain usable as ordinary terminal programs; installation or a version probe is not
release acceptance.

| Provider target | Verified upstream account path | Current Orchestra status |
|---|---|---|
| Qwen Code | Alibaba Cloud Coding Plan is a fixed-fee personal subscription configured through Qwen Code's `/auth`; it uses a subscription-scoped key. Retired Qwen OAuth and usage-priced provider API keys are not equivalent subscription paths. | Manual interactive use is possible inside the raw terminal when independently installed and authenticated. Current Coding Plan terms restrict non-interactive/backend use, so autonomous personal-plan orchestration is blocked pending provider confirmation. No managed compatibility claim. |
| Kimi Code | Kimi membership can authorize the native CLI through the `/login` OAuth device flow. Kimi Open Platform API-key billing is a distinct optional path. | Manual use is possible inside the raw terminal when independently installed and authenticated. A future adapter must also surface optional metered Extra Usage instead of representing OAuth alone as proof of zero overage. No managed compatibility claim. |
| OpenCode | OpenCode is bring-your-own-provider: it brokers whichever upstream model provider(s) the user has configured through `opencode auth`/its own config, which may themselves be subscription- or usage-priced. Orchestra cannot classify that from the outside, so no single verified account path is claimed. | A working driver/adapter exists (`opencode serve` + `@opencode-ai/sdk`, structured events, real per-turn usage), registered `candidate`. Whether OpenCode's own upstream-provider terms permit autonomous/non-interactive use is unresolved; `automation_policy` is declared `unknown`, which fail-closes managed/background launch until confirmed. No managed compatibility claim. |

Candidate versions will be frozen only after install, login, native-CLI lifecycle, approval,
structured-event, usage, resume, cancellation, and PTY gates pass on every claimed operating
system. Upstream feature documentation is discovery evidence, not Orchestra compatibility
evidence.

## Operating systems

| Platform | Evidence label | Observed scope |
|---|---|---|
| macOS `26.5.1` (Darwin `25.5.0`) / arm64 + Node `22.20.0` + npm `10.9.3` | Host-observed | focused/full tests, TypeScript, production builds and provider doctor; not the clean final-artifact lifecycle required by QA-017 |
| Other macOS releases/architectures/toolchain combinations | Experimental | dependency artifacts or individual component evidence only |
| Ubuntu `24.04` x64/glibc + Node `22.20.0` + npm `10.9.3` | CI-observed | repository CI/toolchain evidence only; no retained final-artifact clean install/upgrade/uninstall matrix |
| WSL/WSL2, including Ubuntu `24.04` | Experimental | upstream provider support only; no observed Orchestra terminal/browser/provider gate |
| Other Linux distributions, musl, arm64, or another toolchain combination | Experimental | dependency artifacts or individual component evidence only |
| Windows | Unsupported | no clean-machine, native PTY, browser, or managed-provider acceptance gate |
| Other systems | Unsupported | outside the first-release surface |

Upstream Codex and the Claude SDK may ship Windows binaries. That does not validate Orchestra's
Windows terminal, installation, browser, and recovery contracts.

## Enforcement and verification

`environment-compatibility.json` is the canonical machine-readable contract. Run full operator
readiness to check the environment, Git and selected-provider login state:

```sh
orchestra doctor --provider both
orchestra doctor --provider codex --json
```

The current doctor accepts only `claude`, `codex`, or `both`. Qwen Code and Kimi Code must not be
presented as selectable or ready until their adapters and compatibility contracts are implemented.

The readiness doctor invokes only bounded version and login-status commands with fixed argument
arrays. It does not log in, print raw provider output, start a model session, or make a model request.
Executable source is reported as a safe category and opaque path fingerprint rather than a raw local
path. It exits non-zero unless every required compatibility, Git and selected-provider login check is
**Validated**, and each failure includes machine-readable non-executing remediation.

Use the explicit credential-free compatibility mode for CI, release evidence, or core-environment
diagnosis:

```sh
orchestra doctor --contract
orchestra doctor --provider both --json --compatibility-only
```

Compatibility-only mode invokes version commands and reads installed package metadata, but does not
inspect provider login state. `--contract` performs no probes.

Daemon startup applies the core platform/toolchain/Claude-native policy before opening state or
registering managed runtimes. An unvalidated core environment stops startup with a doctor command.
After that core gate, unsupported, missing, or unparseable Codex versions leave Codex visible but
unavailable; no app-server process or authentication request is attempted.

Login-state detection does not replace real credentialed provider acceptance. Clean-machine
install/upgrade/uninstall on macOS and Linux, desktop/phone acceptance, every claimed provider's
native-subscription journey, and release provenance remain separate beta gates.
