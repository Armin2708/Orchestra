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

Codex app-server is an
[experimental upstream command](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-app-server)
whose protocol may change without notice. Orchestra therefore accepts only CLI `0.144.6`, whose
generated schema digest is recorded in `scripts/codex-protocol-contract.json`. A nearby version such
as the host-observed `0.145.0` is not assumed compatible.

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

`environment-compatibility.json` is the canonical machine-readable contract. Inspect it or run a
credential-free preflight:

```sh
orchestra doctor --contract
orchestra doctor --provider both
orchestra doctor --provider codex --json
```

The preflight invokes only version commands and reads installed package metadata. It does not log in,
read provider credentials, start a provider session, or make a model request. It exits non-zero
unless every required check, including the whole observed toolchain tuple, is **Validated**.

Daemon startup applies the core platform/toolchain/Claude-native policy before opening state or
registering managed runtimes. An unvalidated core environment stops startup with a doctor command.
After that core gate, unsupported, missing, or unparseable Codex versions leave Codex visible but
unavailable; no app-server process or authentication request is attempted.

Provider authentication, clean-machine install/upgrade/uninstall, desktop/phone acceptance, and
release provenance remain separate public-release gates.
