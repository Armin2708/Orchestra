# FSL Relicense + npm Plug-and-Play Init — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phases 1+2 of the plug-and-play release train: relicense future versions under FSL-1.1-ALv2 and add a one-command `orchestra init` so a clean machine goes from `npm i -g orchestra-board` to a running, hooked board.

**Architecture:** Phase 1 swaps license artifacts only (LICENSE, package.json, README) plus a guard test that keeps them in agreement. Phase 2 adds a new `src/init-cli.ts` command module following the existing dependency-injected register pattern (`registerFirstRunCommands`, `registerDoctorCommand`), wired into `src/cli.ts` and the enforced surface inventory. Publishing itself is a manual operator step at the end.

**Tech Stack:** TypeScript ESM, commander 15, vitest, existing modules: `readiness-doctor.ts`, `doctor-cli.ts` (`formatDoctorReport`), `daemon.ts` (`ensureDaemon`, `baseUrl`), `install.ts` (`installHooks`).

## Global Constraints

- Node engine pin: `>=22.20.0 <23`; npm `>=10.9.3 <11` (from package.json — do not change).
- ESM only (`"type": "module"`); imports of local files use `.js` extensions.
- Shared checkout discipline: NEVER `git checkout -b` / `git switch` in the primary working directory; commit directly on `main` for these tasks (house rule).
- Before every commit: run GitNexus `detect_changes` (repo `Orchestra`, scope `unstaged`) and confirm the blast radius is only the files you touched.
- New CLI commands MUST be added to `docs/agent-os-surface-inventory.json` `cli_commands` — enforced by `test/agent-os-baseline-docs.test.ts` ("matches every registered CLI command family and subcommand exactly"). The enumeration only scans files listed in `cli_sources`, so register `init` inside `src/cli.ts`.
- Nothing may reference the operator's homedir; all paths resolve from the package or the project.
- Full-suite runtime is ~2 min; per-file `npx vitest run test/<file>` is the inner loop.

---

### Task 1: FSL-1.1-ALv2 license swap + guard test

**Files:**
- Modify: `LICENSE` (replace entire content)
- Modify: `package.json` (license field only)
- Create: `test/license-contract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LICENSE` beginning `# Functional Source License, Version 1.1, ALv2 Future License`; `package.json` `"license": "FSL-1.1-ALv2"`. Task 2's README section and Task 5's pack check rely on both.

- [ ] **Step 1: Write the failing guard test**

```ts
// test/license-contract.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('license contract', () => {
  it('ships FSL-1.1-ALv2 as the package license', () => {
    expect(license).toContain('Functional Source License, Version 1.1, ALv2 Future License')
    expect(license).toContain('FSL-1.1-ALv2')
    expect(license).toContain('Grant of Future License')
    expect(license).toContain('Apache License, Version 2.0')
    expect(pkg.license).toBe('FSL-1.1-ALv2')
  })

  it('keeps the license in the published artifact file list implicitly (npm always packs LICENSE)', () => {
    // npm includes LICENSE/README unconditionally; this guards against a rename breaking that
    expect(() => readFileSync(new URL('../LICENSE', import.meta.url))).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/license-contract.test.ts`
Expected: FAIL — LICENSE still contains "MIT License", `pkg.license` is `"MIT"`.

- [ ] **Step 3: Fetch the canonical FSL-1.1-ALv2 text and write LICENSE**

Fetch https://raw.githubusercontent.com/getsentry/fsl.software/main/FSL-1.1-ALv2.template.md (WebFetch or curl). Replace the `{licensor}` placeholder in the Notice with `arminrad` and the year with `2026`. The result must match this text (verify your fetched copy against it — if they differ, prefer the fetched canonical text):

```markdown
# Functional Source License, Version 1.1, ALv2 Future License

## Abbreviation

FSL-1.1-ALv2

## Notice

Copyright 2026 arminrad

## Terms and Conditions

### Licensor ("We")

The party offering the Software under these Terms and Conditions.

### The Software

The "Software" is each version of the software that we make available under
these Terms and Conditions, as indicated by our inclusion of these Terms and
Conditions with the Software.

### License Grant

Subject to your compliance with this License Grant and the Patents,
Redistribution and Trademark clauses below, we hereby grant you the right to
use, copy, modify, create derivative works, publicly perform, publicly display
and redistribute the Software for any Permitted Purpose identified below.

### Permitted Purpose

A Permitted Purpose is any purpose other than a Competing Use. A Competing Use
means making the Software available to others in a commercial product or
service that:

1. substitutes for the Software;

2. substitutes for any other product or service we offer using the Software
   that exists as of the date we make the Software available; or

3. offers the same or substantially similar functionality as the Software.

Permitted Purposes specifically include using the Software:

1. for your internal use and access;

2. for non-commercial education;

3. for non-commercial research; and

4. in connection with professional services that you provide to a licensee
   using the Software in accordance with these Terms and Conditions.

### Patents

To the extent your use for a Permitted Purpose would necessarily infringe our
patents, the license grant above includes a license under our patents. If you
make a claim against any party that the Software infringes or contributes to
the infringement of any patent, then your patent license to the Software ends
immediately.

### Redistribution

The Terms and Conditions apply to all copies, modifications and derivatives of
the Software.

If you redistribute any copies, modifications or derivatives of the Software,
you must include a copy of or a link to these Terms and Conditions and not
remove any copyright notices provided in or with the Software.

### Disclaimer

THE SOFTWARE IS PROVIDED "AS IS" AND WITHOUT WARRANTIES OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING WITHOUT LIMITATION WARRANTIES OF FITNESS FOR A
PARTICULAR PURPOSE, MERCHANTABILITY, TITLE OR NON-INFRINGEMENT.

IN NO EVENT WILL WE HAVE ANY LIABILITY TO YOU ARISING OUT OF OR RELATED TO THE
SOFTWARE, INCLUDING INDIRECT, SPECIAL, INCIDENTAL OR CONSEQUENTIAL DAMAGES,
EVEN IF WE HAVE BEEN INFORMED OF THEIR POSSIBILITY IN ADVANCE.

### Trademarks

Except for displaying the License Details and identifying us as the origin of
the Software, you have no right under these Terms and Conditions to use our
trademarks, trade names, service marks or product names.

## Grant of Future License

We hereby irrevocably grant you an additional license to use the Software
under the Apache License, Version 2.0, that is effective on the second
anniversary of the date we make the Software available. On or after that date,
you may use the Software under the Apache License, Version 2.0, in which case
the following will apply:

Licensed under the Apache License, Version 2.0 (the "License"); you may not
use this file except in compliance with the License.

You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
License for the specific language governing permissions and limitations under
the License.
```

- [ ] **Step 4: Update package.json license field**

In `package.json` change `"license": "MIT"` to `"license": "FSL-1.1-ALv2"`. Touch nothing else in the file.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/license-contract.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Check for accidental breakage**

Run: `npx vitest run test/package-artifact.test.ts 2>/dev/null; grep -rln '"license": "MIT"\|MIT License' test/ scripts/ src/ | grep -v node_modules`
Expected: no test or script asserts the old MIT string (if a hit appears, read it — only update assertions that pin the license value, nothing else).

- [ ] **Step 7: Commit**

```bash
git add LICENSE package.json test/license-contract.test.ts
git commit -m "feat(license): relicense future versions under FSL-1.1-ALv2

Versions through fd4cd58 remain MIT. FSL: free for any use including
internal company use; no competing products; each release converts to
Apache-2.0 after two years."
```

---

### Task 2: README licensing + installation sections

**Files:**
- Modify: `README.md` (the `## Installation status` section, lines ~39–50, and a new `## License` section at the end)

**Interfaces:**
- Consumes: Task 1's LICENSE (link target).
- Produces: README copy that Task 5's published tarball ships.

- [ ] **Step 1: Replace the "Installation status" section**

Replace the entire `## Installation status` section body (keep the heading) with:

```markdown
**Orchestra is being prepared for public npm release.** Until the first
published version lands, the npm package and public plugin installation are
not release claims — the bundled plugin hook manifests invoke the pinned
package version through npm, so they are not the installation path for an
unpublished build.

Once published, installation is one command on a clean machine:

​```bash
npm i -g orchestra-board
orchestra init   # checks your environment, starts the daemon, installs hooks, opens the board
​```

A named trusted tester can instead install one retained tarball after independently matching the
SHA-256 supplied by the release owner. That path uses the tarball's installed `orchestra` binary,
keeps managed provider launch fail-closed, and provides reversible project hooks, the local UI,
the safe lifecycle demo, and a verified local support bundle. Follow the exact
[private technical-beta runbook](docs/getting-started.md); do not substitute a newly rebuilt or
unverified archive.
```

(Remove the zero-width characters around the code fence when writing — they exist here only to nest the fence in this plan.)

- [ ] **Step 2: Add a License section at the end of README**

```markdown
## License

Orchestra is licensed under the [Functional Source License, Version 1.1,
ALv2 Future License](LICENSE) (FSL-1.1-ALv2):

- **Free for you and your company** — use, modify, and self-host it for any
  internal purpose, personal or commercial.
- **What you can't do** — offer a competing commercial product or service
  built on it.
- **It becomes Apache-2.0** — each release automatically converts to the
  Apache License 2.0 two years after publication.

Versions released before the FSL switch (through commit `fd4cd58`) were
published under the MIT license and remain MIT.
```

- [ ] **Step 3: Verify packaged markdown links stay intact**

Run: `node -e "import('./scripts/package-link-integrity.mjs').then(m => m.verifyPackagedMarkdownLinks ? console.log('helper exists — run via pack smoke') : 0)" ; npx vitest run test/license-contract.test.ts`
Expected: no broken-link regression tooling errors; license test still PASS. (Full link verification runs inside the pack smoke in Task 5.)

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): FSL license section and npm install story"
```

---

### Task 3: `src/init-cli.ts` — one-command init (TDD)

**Files:**
- Create: `src/init-cli.ts`
- Create: `test/init-cli.test.ts`

**Interfaces:**
- Consumes: `runOperatorReadinessDoctor(provider, env?, deps?): OperatorDoctorReport` and type `DoctorProvider` from `./readiness-doctor.js`; `formatDoctorReport(report): string` from `./doctor-cli.js`; `ensureDaemon(): Promise<boolean>` and `baseUrl(): string` from `./daemon.js`; `installHooks(scope, {provider}): void` and types `HookScope`, `InstallProvider` from `./install.js`.
- Produces: `registerInitCommand(program: Command, deps?: InitCliDeps): void` and `defaultOpenBrowser(url: string): void` — Task 4 imports `registerInitCommand` in `src/cli.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/init-cli.test.ts
import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { registerInitCommand, type InitCliDeps } from '../src/init-cli.js'

type Call = string

const harness = (overrides: Partial<InitCliDeps> = {}) => {
  const calls: Call[] = []
  const lines: string[] = []
  const deps: InitCliDeps = {
    runDoctor: (provider) => {
      calls.push(`doctor:${provider}`)
      return {
        ready: true, status: 'validated', provider, checks: [],
      } as never
    },
    formatReport: () => 'DOCTOR REPORT',
    startDaemon: async () => { calls.push('daemon'); return true },
    installProviderHooks: (scope, options) => { calls.push(`hooks:${scope}:${options.provider}`) },
    openBrowser: (url) => { calls.push(`open:${url}`) },
    boardUrl: () => 'http://127.0.0.1:4820',
    output: (line) => { lines.push(line) },
    ...overrides,
  }
  const program = new Command()
  program.exitOverride()
  registerInitCommand(program, deps)
  const run = (argv: string[]) => program.parseAsync(['node', 'orchestra', ...argv])
  return { calls, lines, run }
}

describe('orchestra init', () => {
  it('runs doctor, starts the daemon, installs both-provider hooks, opens the board — in that order', async () => {
    const { calls, lines, run } = await Promise.resolve(harness())
    await run(['init'])
    expect(calls).toEqual([
      'doctor:both', 'daemon', 'hooks:global:both', 'open:http://127.0.0.1:4820',
    ])
    expect(lines.join('\n')).toContain('DOCTOR REPORT')
    expect(lines.join('\n')).toContain('http://127.0.0.1:4820')
    expect(lines.join('\n')).toContain('hire your first agent')
  })

  it('honors --provider, --project, and --no-open', async () => {
    const { calls, run } = harness()
    await run(['init', '--provider', 'claude', '--project', '--no-open'])
    expect(calls).toEqual(['doctor:claude', 'daemon', 'hooks:project:claude'])
  })

  it('continues past a NOT READY doctor report but surfaces it as a warning', async () => {
    const { calls, lines, run } = harness({
      runDoctor: (provider) => ({ ready: false, status: 'unsupported', provider, checks: [] } as never),
    })
    await run(['init'])
    expect(calls).toContain('daemon')
    expect(calls.some((call) => call.startsWith('hooks:'))).toBe(true)
    expect(lines.join('\n')).toContain('not fully ready')
  })

  it('fails hard when the daemon does not come up, before touching hooks', async () => {
    const { calls, run } = harness({ startDaemon: async () => false })
    await expect(run(['init'])).rejects.toThrow(/daemon/i)
    expect(calls.some((call) => call.startsWith('hooks:'))).toBe(false)
  })

  it('rejects an unknown provider', async () => {
    const { run } = harness()
    await expect(run(['init', '--provider', 'gemini'])).rejects.toThrow(/claude\|codex\|both/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/init-cli.test.ts`
Expected: FAIL — `Cannot find module '../src/init-cli.js'`.

- [ ] **Step 3: Implement `src/init-cli.ts`**

```ts
import { spawn } from 'node:child_process'
import { Command, InvalidArgumentError } from 'commander'
import { baseUrl, ensureDaemon } from './daemon.js'
import { formatDoctorReport } from './doctor-cli.js'
import { installHooks, type HookScope, type InstallProvider } from './install.js'
import {
  runOperatorReadinessDoctor,
  type DoctorProvider,
  type OperatorDoctorReport,
} from './readiness-doctor.js'

export type InitCliDeps = {
  runDoctor?: (provider: DoctorProvider) => OperatorDoctorReport
  formatReport?: (report: OperatorDoctorReport) => string
  startDaemon?: () => Promise<boolean>
  installProviderHooks?: (scope: HookScope, options: { provider: InstallProvider }) => void
  openBrowser?: (url: string) => void
  boardUrl?: () => string
  output?: (line: string) => void
}

// best-effort, never throws: init must succeed on headless boxes too
export const defaultOpenBrowser = (url: string): void => {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref()
  } catch { /* headless or no handler — the printed URL is the fallback */ }
}

const initProvider = (value: string): DoctorProvider => {
  if (value === 'claude' || value === 'codex' || value === 'both') return value
  throw new InvalidArgumentError('expected claude|codex|both')
}

export const registerInitCommand = (program: Command, deps: InitCliDeps = {}): void => {
  const runDoctor = deps.runDoctor
    ?? ((provider: DoctorProvider) => runOperatorReadinessDoctor(provider))
  const formatReport = deps.formatReport ?? formatDoctorReport
  const startDaemon = deps.startDaemon ?? ensureDaemon
  const installProviderHooks = deps.installProviderHooks ?? installHooks
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser
  const boardUrl = deps.boardUrl ?? baseUrl
  const output = deps.output ?? console.log

  program.command('init')
    .description('one-command setup: check the environment, start the daemon, install hooks, open the board')
    .option('--provider <provider>', 'provider hooks to install (claude|codex|both)', initProvider, 'both')
    .option('--project', 'install hooks into the current project instead of the user config')
    .option('--no-open', 'do not open the board in a browser')
    .action(async (options: { provider: DoctorProvider, project?: boolean, open: boolean }) => {
      const report = runDoctor(options.provider)
      output(formatReport(report))
      if (!report.ready) {
        output('Environment is not fully ready — continuing anyway; fix the items above, then re-run `orchestra doctor`.')
      }
      if (!await startDaemon()) {
        throw new Error('daemon failed to start — run `orchestra serve` in the foreground and read the error')
      }
      const url = boardUrl()
      installProviderHooks(options.project ? 'project' : 'global', { provider: options.provider })
      if (options.open) openBrowser(url)
      output([
        `Orchestra is running on ${url}`,
        `Hooks installed (${options.provider}); new agent sessions in hooked projects join the board automatically.`,
        'Next: open the board and hire your first agent (+ Hire), or run `orchestra remote` for phone access.',
      ].join('\n'))
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/init-cli.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/init-cli.ts test/init-cli.test.ts
git commit -m "feat(init): one-command setup module — doctor, daemon, hooks, open board"
```

---

### Task 4: Wire `init` into the CLI + surface inventory

**Files:**
- Modify: `src/cli.ts` (import + registration call, next to `registerDoctorCommand(program)`)
- Modify: `docs/agent-os-surface-inventory.json` (`cli_commands.canonical`)
- Modify: `docs/agent-os-surface-inventory.md` (CLI commands listing, same section style as neighbors)
- Test: `test/agent-os-baseline-docs.test.ts` (existing — must pass unmodified)

**Interfaces:**
- Consumes: `registerInitCommand` from Task 3.
- Produces: `orchestra init` as a registered, inventoried command. Task 5's smoke uses it.

**IMPORTANT:** The inventory test enumerates `.command('...')` calls only in `cli_sources` (`src/cli.ts`, `src/agent-os-cli.ts`, `src/job-assignment-cli.ts`). `registerInitCommand` lives in `src/init-cli.ts`, which is NOT a cli_source — so the `program.command('init')` call would be invisible to the enumerator. Register it the way the enumerator can see: move the `program.command('init')` literal into `src/cli.ts` — i.e. `registerInitCommand` receives the program and attaches, but the enumerator regex needs the literal inside a cli_source. Resolution that keeps both the enumerator and the module boundary happy: in `src/init-cli.ts` export the action builder, and declare the command in `src/cli.ts`:

- [ ] **Step 1: Run the inventory test to see the current green baseline**

Run: `npx vitest run test/agent-os-baseline-docs.test.ts`
Expected: PASS (baseline before the change).

- [ ] **Step 2: Refactor registration so the command literal lives in `src/cli.ts`**

In `src/init-cli.ts`, replace `registerInitCommand` with an exported `buildInitAction(deps: InitCliDeps = {})` that returns the async action function, plus an exported `initProviderOption` parser (rename of `initProvider`). Keep `InitCliDeps` and `defaultOpenBrowser` exports. The tests from Task 3 change their harness to:

```ts
const program = new Command()
program.exitOverride()
program.command('init')
  .option('--provider <provider>', 'claude|codex|both', initProviderOption, 'both')
  .option('--project')
  .option('--no-open')
  .action(buildInitAction(deps))
```

(Update `test/init-cli.test.ts` imports to `{ buildInitAction, initProviderOption, type InitCliDeps }`.)

In `src/cli.ts`, next to `registerDoctorCommand(program)` add:

```ts
program.command('init')
  .description('one-command setup: check the environment, start the daemon, install hooks, open the board')
  .option('--provider <provider>', 'provider hooks to install (claude|codex|both)', initProviderOption, 'both')
  .option('--project', 'install hooks into the current project instead of the user config')
  .option('--no-open', 'do not open the board in a browser')
  .action(buildInitAction())
```

with the import `import { buildInitAction, initProviderOption } from './init-cli.js'` at the top.

- [ ] **Step 3: Run init tests + inventory test to see the expected inventory failure**

Run: `npx vitest run test/init-cli.test.ts test/agent-os-baseline-docs.test.ts`
Expected: init-cli PASS; baseline-docs FAIL with `init` present in registered commands but missing from the inventory.

- [ ] **Step 4: Add `init` to the surface inventory JSON and markdown**

In `docs/agent-os-surface-inventory.json`, add `"init"` to `cli_commands.canonical` keeping the array alphabetically consistent with its neighbors. In `docs/agent-os-surface-inventory.md`, add `init` to the CLI command listing following the exact formatting of the surrounding command entries (one line, same style). Do NOT hand-edit any counts — if the md carries totals, recompute them from the json (house rule: counts are recomputed, never incremented).

- [ ] **Step 5: Run the full docs/inventory gate**

Run: `npx vitest run test/agent-os-baseline-docs.test.ts test/beta-quality-matrix.test.ts`
Expected: PASS. (beta-quality runs because `src/cli.ts` changed; if it flags a new state-machine candidate for `src/init-cli.ts`, classify it in `docs/quality/beta-quality-requirements.json` `classified_state_machine_files`, update `state_machine_discovery_sha256` from `stateMachineDiscoveryDigest()`, and repin `PINNED_REQUIREMENTS_SHA256` in `scripts/check-beta-quality-matrix.mjs` with the file's new sha256 — same procedure as commit fd4cd58.)

- [ ] **Step 6: Manual smoke on this machine**

Run: `npx tsx src/cli.ts init --no-open --provider claude --project 2>&1 | tail -8` from a scratch directory (e.g. `mkdir -p /private/tmp/claude-501/-Users-arminrad-Desktop-agentboard/*/scratchpad/init-smoke && cd there` — use the session scratchpad). Confirm: doctor report prints, daemon detected/started, hooks written to `./.claude/settings.json` in the scratch dir (NOT the agentboard repo), next-steps block prints. Then remove the scratch dir.
Expected: exit 0, correct output, no files written outside the scratch dir.

- [ ] **Step 7: Full test suite**

Run: `npm test`
Expected: all green (2551+ tests, ~2 min).

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/init-cli.ts test/init-cli.test.ts docs/agent-os-surface-inventory.json docs/agent-os-surface-inventory.md
# plus docs/quality + scripts/check-beta-quality-matrix.mjs if step 5 required classification
git commit -m "feat(cli): orchestra init — one command from clean machine to running hooked board"
```

---

### Task 5: Publish preflight — pack verification, docs flip, name check

**Files:**
- Modify: `docs/getting-started.md` (quickstart section)
- No new code — verification + operator handoff.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified `orchestra-board-0.1.0.tgz` and the operator's go/no-go for `npm publish`.

- [ ] **Step 1: Check the npm name is available**

Run: `npm view orchestra-board name 2>&1`
Expected: `npm error 404` (name free). **If the name is taken: STOP and surface the rename decision to the operator — do not pick a name unilaterally.**

- [ ] **Step 2: Add the published-install quickstart to getting-started**

At the top of `docs/getting-started.md`, before the trusted-tester runbook content, insert:

```markdown
## Quickstart (published install)

​```bash
npm i -g orchestra-board
orchestra init
​```

`init` checks your environment (Node 22, provider CLIs), starts the daemon,
installs Claude + Codex hooks, and opens the board. Every step is also
available individually: `orchestra doctor`, `orchestra serve`,
`orchestra install --provider both`.

The runbook below remains the path for trusted-tester tarball installs of
unpublished builds.
```

(Strip the zero-width characters around the inner fence.)

- [ ] **Step 3: Build and pack**

Run: `npm run build && cd web && npm run build && cd .. && npm pack --pack-destination /tmp 2>&1 | tail -3`
Expected: `orchestra-board-0.1.0.tgz` produced; the pack file listing includes `LICENSE`, `README.md`, `dist/cli.js`, `web/dist/`.

- [ ] **Step 4: Clean-prefix install smoke of the tarball**

```bash
SMOKE=$(mktemp -d) && npm i -g --prefix "$SMOKE" /tmp/orchestra-board-0.1.0.tgz \
  && "$SMOKE/bin/orchestra" --version \
  && "$SMOKE/bin/orchestra" init --help \
  && tar -tzf /tmp/orchestra-board-0.1.0.tgz | grep -c '^package/LICENSE' \
  && rm -rf "$SMOKE"
```

Expected: version prints, `init` help shows provider/project/no-open flags, LICENSE count is 1.

- [ ] **Step 5: Commit and hand off**

```bash
git add docs/getting-started.md
git commit -m "docs(getting-started): published-install quickstart via orchestra init"
```

Then report to the operator: tarball verified at `/tmp/orchestra-board-0.1.0.tgz`; publishing is their manual action (`npm publish` from the shared checkout after `orchestra deploy --check` is green), because it is irreversible and public.

---

## Self-Review Notes

- Spec coverage: Phase 1 → Tasks 1–2; Phase 2 (publish, init, wizard-less setup, CI smoke) → Tasks 3–5. The container CI smoke wiring already exists (`scripts/package-install-smoke.mjs` in `beta-platform-lifecycle.yml`); Task 5 exercises the same artifact locally rather than duplicating CI.
- The Task 4 registration refactor exists because `test/agent-os-baseline-docs.test.ts` only enumerates command literals in `cli_sources` — verified against the enumerator regex.
- Type names cross-checked: `DoctorProvider`, `OperatorDoctorReport` (readiness-doctor.ts:59–79), `HookScope`/`InstallProvider` (install.ts:6–8), `ensureDaemon` (daemon.ts:1090), `formatDoctorReport` (doctor-cli.ts:46).
- npm publish deliberately stays manual (irreversible, outward-facing).
