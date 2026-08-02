# Getting started with Orchestra beta

Status: source-checkout beta onboarding contract. Public npm installation and stable promotion are
not claimed here.

## The safe first run

Build with the validated toolchain, then run the first-run wizard after the Lane D integrator wires
`registerFirstRunCommands` into the root CLI:

```sh
node --version   # v22.20.0
npm --version    # 10.9.3
npm ci
npm run build
node dist/cli.js onboard
```

The wizard selects one absolute project root, one provider, one execution/billing mode, an optional
provider-specific hook scope, and external telemetry consent. It writes no provider credential. Its
defaults are:

- loopback-only daemon binding;
- native subscription requested, with no usage-priced API fallback;
- remote access and remote terminal writes off;
- external telemetry off;
- isolated worktrees for writable managed jobs; and
- manual, recoverable cleanup only.

Run `onboard --json` to inspect the plan without applying it. Run `onboard --apply` only after
reviewing the plan. Applying saves an owner-only `onboarding.json` under `ORCHESTRA_HOME` and installs
only the explicitly selected Claude or Codex hooks. Hook writes are provider-specific, reversible,
and immediately verified.

## Provider truth

The wizard reads the canonical v1 manifests; it does not infer support from an installed binary.

| Provider | Current managed status on this lane | Hook behavior | What is still required |
| --- | --- | --- | --- |
| Claude Code | unsupported; native subscription automation is policy-blocked | source supports provider-specific hooks | policy clearance and an exact real acceptance matrix |
| Codex CLI | candidate | hook projection is not yet verified | exact version/platform/source acceptance evidence |
| Qwen Code | unsupported managed provider | no managed hook install | Lane B adapter plus provider-policy clearance |
| Kimi Code | unsupported managed provider | no managed hook install | Lane B ACP adapter plus explicit overage handling |

An installed CLI remains usable in a normal terminal. That is not evidence of managed Orchestra
support. Every managed support claim requires the exact provider/adapter/mode/billing/credential,
executable version, platform, source commit, and all eight acceptance gates.

## Explicit provider API mode

`--mode provider_api` is never selected automatically. It requires the literal
`--accept-usage-priced-api` acknowledgement. The current provider manifests do not expose a direct
provider-API runtime, so the plan remains blocked until Lane B integrates that runtime. Orchestra
must not reuse an ambient API key, switch billing modes, or change providers when subscription
readiness fails.

## After onboarding

1. Run `orchestra doctor --provider <provider>` and treat every required failure as blocking.
2. Start locally and inspect the Board before enabling hooks globally.
3. Run the safe [lifecycle demo](lifecycle-demo.md); it stops before provider execution by default.
4. Read [data and recovery](data-recovery.md), [telemetry and support](telemetry-support.md), and
   the [remote security boundary](remote-access-security.md).

Advanced controls are discoverable in the JSON plan. Unavailable controls stay visible with their
dependency instead of silently disappearing or being enabled with unsafe defaults.
