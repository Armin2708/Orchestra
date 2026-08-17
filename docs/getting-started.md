# Getting started with Orchestra beta

Status: private retained-tarball and source-checkout technical-beta contract. Public npm/plugin
installation, managed-provider support, and stable promotion are not claimed here.

## Quickstart (published install)

Once the package is published to npm, installation is one command on a clean machine:

```sh
npm i -g orchestra-board
orchestra init
```

`init` checks your environment (Node 22, provider CLIs), starts the daemon,
installs Claude + Codex hooks, installs the workflow command pack into
`.claude/commands`, and opens the board. Every step is also available
individually: `orchestra doctor`, `orchestra serve`,
`orchestra install --provider both --workflows`.

From then on, `orchestra remember '<note>'` keeps a note for future sessions on
this board and `orchestra handoff '<note>'` leaves a one-shot briefing for the
next one; both are injected at session start for Claude and Codex alike. Skip the
command pack with `orchestra init --no-workflows`, and run `orchestra integrations`
to see which knowledge integrations the project already has.

Until that first published version lands, the runbook below remains the only
supported path: trusted-tester tarball installs of unpublished builds.

## What a tester must receive

The release owner must send all of the following through a trusted channel:

- one retained `.tgz` artifact, not instructions to rebuild it;
- its exact SHA-256 digest and source commit;
- the provider/platform limitations for that exact candidate;
- a support contact and the local-only support workflow; and
- the rollback instruction: stop Orchestra, remove only Orchestra hooks and package code, and
  preserve `ORCHESTRA_HOME` unless the tester separately chooses to delete their data.

Do not install when the archive digest differs, the source/digest is missing, or the archive came
from an untrusted location. A local tarball is a private distribution mechanism, not provenance or
a public release by itself.

## Private tarball: verify, install, inspect

Use Node `22.20.0` and npm `10.9.3`. Replace the placeholders with the exact values from the owner:

```sh
node --version
npm --version
ORCHESTRA_BETA_TARBALL=/absolute/path/orchestra-board-CANDIDATE.tgz
shasum -a 256 "$ORCHESTRA_BETA_TARBALL"
# Linux: sha256sum "$ORCHESTRA_BETA_TARBALL"
# Compare the full output with <OWNER_SUPPLIED_SHA256> before continuing.

npm install --global "$ORCHESTRA_BETA_TARBALL"
orchestra --version
orchestra doctor --provider codex
```

The package itself defines no install lifecycle script, but native dependencies require their own
normal npm installation scripts. Use only the verified retained artifact; `--ignore-scripts` is not
the functional install path for SQLite and PTY dependencies.

Substitute `claude` for `codex` when evaluating Claude Code. A doctor failure blocks managed
provider use. It does not silently switch provider, billing mode, or credentials. The command never
logs in or performs a model request; follow its explicit provider login/version remediation and
rerun it.

## The safe first run

From a source checkout, build with the same toolchain before using the equivalent installed CLI:

```sh
node --version   # v22.20.0
npm --version    # 10.9.3
npm ci
npm run build
node dist/cli.js onboard
```

For either installation form, inspect a complete non-interactive plan first:

```sh
orchestra onboard \
  --project /absolute/path/to/test-project \
  --provider codex \
  --mode native_subscription \
  --hooks off \
  --telemetry off
```

When the local UI first opens at `http://localhost:4750`, create its local owner password. A
successful sign-in creates a temporary session that survives refreshes in that tab for up to 12
hours; the password itself is never stored in browser storage. The daemon's reusable transport
credential is not a browser login. To recover a forgotten password, stop Orchestra and run
`orchestra password reset --confirm RESET_LOCAL_PASSWORD`, restart it, and create a new password.

That same password can bootstrap a limited phone DeviceSession only through Orchestra's private
Tailscale tunnel. It is exchanged once, never stored by the phone, and grants the standard
`observe`, `stream`, `message`, and `approve` scopes over the current boards. Public Cloudflare
tunnels and any narrower or elevated grant use a short-lived, single-use pairing ticket instead.

The human output gives the exact safe next steps and lists every provider blocker. JSON automation
can use the same command with `--json`. `--apply` is rejected before invoking configuration or hook
writes while any provider, project, mode, acceptance, or hook blocker remains. Passing doctor alone
does not clear the independent exact provider-acceptance gate.

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
the current candidate, plans are inspection-only. Apply never trusts the returned plan as an authority: it
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

Technical private-beta testers can still connect an already-installed, user-authenticated Claude
Code or Codex CLI terminal to the local board without opening the managed-provider boundary:

```sh
orchestra onboard --project "$PWD" --provider claude --mode native_subscription \
  --hooks project --telemetry off --apply-ambient-hooks
```

This explicit ambient-only action rederives and validates the complete plan, installs only the
selected provider's hooks, and does not write a managed-launch configuration or clear any provider
policy/acceptance blocker. Start a new Claude Code terminal in the project after installing the
hooks. Use `--provider codex` for Codex CLI, or the existing `orchestra install --provider both`
command when intentionally configuring both providers outside the first-run plan.

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
2. Start the local product with `orchestra serve`, open `http://127.0.0.1:4750`, and inspect the
   Board before enabling hooks.
3. Only after the exact provider doctor passes, optionally install project-local observation hooks
   with the explicit `orchestra onboard ... --hooks project --apply-ambient-hooks` command above.
   These reversible hooks expose ordinary terminal sessions to the Board; they do not authorize
   managed launch or turn the provider into a supported claim. Remove them with the matching
   project/provider uninstall command shown below.
4. Do not use the bundled plugin manifests as an unpublished-tarball shortcut: they intentionally
   reference the pinned npm package and require the separately verified public/plugin gate.
5. Run `orchestra lifecycle-demo --project /absolute/path/to/test-project --provider codex`; omit
   `--launch`. The demo creates a real Board/card/contract but spends no provider tokens.
6. Read [data and recovery](data-recovery.md), [telemetry and support](telemetry-support.md), and
   the [remote security boundary](remote-access-security.md).

## Stop, support, and remove

With the daemon running, create an owner-only diagnostics file:

```sh
orchestra ops diagnostics ./orchestra-diagnostics.json.gz
```

Review it locally before sharing. For the digest-bound support-case flow, use the request template
and explicit consent command in [support preview](support-preview.md). Nothing is uploaded by either
command.

To remove the private build without deleting user data:

```sh
orchestra uninstall --project --provider codex  # repeat for each hook scope/provider used
orchestra stop
npm uninstall --global orchestra-board
```

The package uninstall does not authorize deletion of `ORCHESTRA_HOME`, projects, worktrees, or the
retained artifact. Back up and verify state before any separately chosen data removal.

Advanced controls are discoverable in the JSON plan. Unavailable controls stay visible with their
dependency instead of silently disappearing or being enabled with unsafe defaults.
