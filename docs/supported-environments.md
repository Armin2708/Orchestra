# Supported environments

This matrix is the current BASE-010 compatibility candidate for Orchestra. It describes
what has actually been exercised; it is not a claim that the complete product is plug-and-play or
ready for public release.

Labels mean:

- **Validated** — the exact version and platform scope has an observed host, compatibility-container,
  or CI gate.
- **Experimental** — the version is inside an evaluation range or has package coverage, but lacks
  the complete observed gate. `orchestra doctor` does not call it ready.
- **Unsupported** — Orchestra refuses the required managed-provider preflight.

## Runtime and package tooling

| Component | Validated | Experimental | Unsupported |
|---|---|---|---|
| Node.js | `22.12.0` in the Ubuntu 24.04 x64 compatibility gate; `22.20.0` on Darwin arm64 | other `>=22.12.0 <23` versions | `<22.12.0`, `>=23`, missing, or unparseable |
| npm | `10.9.0` with the Ubuntu gate's Node release; `10.9.3` on the observed Darwin host | other `>=10.9.0 <11` versions | `<10.9.0`, `>=11`, missing, or unparseable |
| Git | functional readiness range `>=2.30.0 <3.0.0`; host-observed with `2.50.1` on Darwin | none | `<2.30.0`, `>=3.0.0`, missing, or unparseable |

Node's official `22.12.0` archive records npm `10.9.0`. The package engines admit the evaluation
range, while the doctor remains fail-closed unless an exact observed platform + Node + npm tuple
matches. Known component versions are not combined into untested Cartesian products.

## Managed providers

| Surface | Validated | Experimental | Unsupported |
|---|---|---|---|
| Codex managed runtime | Codex CLI `0.144.6`; `codex app-server`; stdio JSONL; the checked-in 671-file protocol digest | none | every other CLI version, a missing command, or unparseable version output |
| Claude managed runtime | `@anthropic-ai/claude-agent-sdk` `0.3.212`, its native optional package `0.3.212`, and that package's executable reporting Claude Code `2.1.212` | none | another or missing SDK/native package/executable version |
| Ambient Claude CLI | none | host-observed `2.1.170` (PATH-resolved) and `2.1.217` (alternate install), version commands only | not a managed-runtime requirement; missing is reported but does not block managed Claude |

Orchestra's Claude conductor does not set `pathToClaudeCodeExecutable`, so SDK `0.3.212` uses its
built-in executable. Doctor resolves the actual platform-native optional package and runs that
binary's `--version`; base-package metadata alone cannot pass. The npm dependency is exact-pinned to
stop published installs from silently moving to an unreviewed SDK/CLI pair.

Codex app-server is the documented
[deep-integration surface](https://learn.chatgpt.com/docs/app-server) for authentication, thread
history, approvals, and streamed events. Its generated protocol remains CLI-version-specific.
Orchestra therefore accepts only CLI `0.144.6`, whose generated schema digest is recorded in
`scripts/codex-protocol-contract.json`. A nearby version such as the host-observed `0.145.0` is not
assumed compatible.

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

## First-release provider candidates not yet supported

These providers are in the product target, but no exact Orchestra adapter/version/platform tuple
has passed. They remain **Unsupported** for managed launch until the reopened BASE-010 matrix and
the provider acceptance gates close.

| Provider target | Verified upstream account path | Current Orchestra status |
|---|---|---|
| Qwen Code | Alibaba Cloud Coding Plan is a fixed-fee personal subscription configured through Qwen Code's `/auth`; it uses a subscription-scoped key. Retired Qwen OAuth and usage-priced provider API keys are not equivalent subscription paths. | Manual interactive use is possible inside the raw terminal when independently installed and authenticated. Current Coding Plan terms restrict non-interactive/backend use, so autonomous personal-plan orchestration is blocked pending provider confirmation. No managed compatibility claim. |
| Kimi Code | Kimi membership can authorize the native CLI through the `/login` OAuth device flow. Kimi Open Platform API-key billing is a distinct optional path. | Manual use is possible inside the raw terminal when independently installed and authenticated. A future adapter must also surface optional metered Extra Usage instead of representing OAuth alone as proof of zero overage. No managed compatibility claim. |

Candidate versions will be frozen only after install, login, native-CLI lifecycle, approval,
structured-event, usage, resume, cancellation, and PTY gates pass on every claimed operating
system. Upstream feature documentation is discovery evidence, not Orchestra compatibility
evidence.

## Operating systems

| Platform | Label | Observed scope |
|---|---|---|
| macOS `26.5.1` (Darwin `25.5.0`) / arm64 + Node `22.20.0` + npm `10.9.3` | Validated | focused/full tests, TypeScript, production builds, exact provider doctor on the 2026-07-25 host |
| Other macOS releases/architectures/toolchain combinations | Experimental | dependency artifacts or individual component evidence only |
| Ubuntu `24.04` x64/glibc + Node `22.12.0` + npm `10.9.0` | Validated | exact linux/amd64 compatibility-container gate; the repository CI is pinned to the same operating system and toolchain |
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

Login-state detection does not replace real credentialed Claude/Codex session acceptance.
Clean-machine install/upgrade/uninstall, desktop/phone acceptance, credentialed provider journeys,
and release provenance remain separate public-release gates.
