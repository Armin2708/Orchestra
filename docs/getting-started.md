# Getting started with Orchestra beta

Status: source-checkout beta onboarding contract. Public npm installation and stable promotion are
not claimed here.

## The safe first run

Build with the validated toolchain, then run the first-run wizard. The integrated root CLI registers
both `onboard` and `lifecycle-demo`:

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

Run `onboard --json` to inspect the plan without applying it. `onboard --apply` fails before writing
configuration or hooks when any blocker exists. Because no provider is release-validated at
integrated code head `58fc112a94c2253dd04f2ba617a6477b11d3d966`, current plans are
inspection-only. Apply never trusts the returned plan as an authority: it
rebuilds the complete plan from its safe provider/mode/project/hook/telemetry identifiers and the
current immutable provider manifest, then requires an exact match. Clearing blockers or forging
provider, billing, runtime, capability, defaults or advanced-control fields cannot enable writes.
Once a future manifest contains independently verified support, applying writes an owner-only
`onboarding.json` and provider hook files in one held hook transaction; failures restore only bytes
and modes still owned by that transaction, while unrelated concurrent edits are preserved and
reported for operator reconciliation.

Managed hook targets are physically contained below the selected project root for project scope and
below the physical home/`CODEX_HOME` root for global scope. Every existing parent component must be a
real directory; `.claude` or `.codex` parent symlinks are rejected. Multi-provider changes resolve
all targets and acquire all writer locks in deterministic order before taking snapshots. On POSIX,
committed renames and removals are followed by a containing-directory `fsync`; Windows receives the
same exact-byte/mode checks but this document makes no crash-durability guarantee for directory
metadata there.

## Provider truth

The wizard reads the canonical v1 manifests; it does not infer support from an installed binary.

| Provider | Current managed beta status | Hook behavior | What is still required |
| --- | --- | --- | --- |
| Claude Code | unsupported; native subscription automation is policy-blocked | source supports provider-specific hooks | policy clearance and an exact real acceptance matrix |
| Codex CLI | candidate | hook projection is not yet verified | exact version/platform/source acceptance evidence |
| Qwen Code | unsupported managed provider | no managed hook install | accepted exact adapter/version/platform evidence plus provider-policy clearance |
| Kimi Code | unsupported managed provider | no managed hook install | accepted exact native matrix plus observed Extra Usage consent, metering and cap behavior |

An installed CLI remains usable in a normal terminal. That is not evidence of managed Orchestra
support. Every managed support claim requires the exact provider/adapter/mode/billing/credential,
executable version, platform, source commit, and all eight acceptance gates.

## Explicit provider API mode

`--mode provider_api` is never selected automatically. It requires the literal
`--accept-usage-priced-api` acknowledgement. The current provider manifests do not expose an
accepted direct provider-API runtime, so the plan remains blocked. Orchestra
must not reuse an ambient API key, switch billing modes, or change providers when subscription
readiness fails.

## After onboarding

1. Run `orchestra doctor --provider <provider>` and treat every required failure as blocking.
2. Start locally and inspect the Board before enabling hooks globally.
3. Run the safe [lifecycle demo](lifecycle-demo.md); it stops before provider execution by default.
4. Read [data and recovery](data-recovery.md), [telemetry and support](telemetry-support.md), and
   the [remote security boundary](remote-access-security.md).

For a local support export, first generate and review diagnostics or use the consent-gated
`orchestra ops support-case` workflow described in [support preview](support-preview.md). It creates
local files only and never uploads or publishes them.

Advanced controls are discoverable in the JSON plan. Unavailable controls stay visible with their
dependency instead of silently disappearing or being enabled with unsafe defaults.
