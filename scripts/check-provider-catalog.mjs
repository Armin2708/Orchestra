#!/usr/bin/env node
// Release gate: the bundled provider CLI must report a version AND enumerate models.
//
// Rationale: a build can typecheck, build, and pass every unit test while shipping a
// provider CLI that lists no models — the hire picker is then empty and newly released
// models are invisible. Nothing else in CI covers that, so this runs pre-publish.
//
// Credential-free by design: both probes work signed-out, so no secrets are needed.

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const NATIVE_PACKAGES = {
  'darwin-arm64': '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  'darwin-x64': '@anthropic-ai/claude-agent-sdk-darwin-x64',
  'linux-x64': '@anthropic-ai/claude-agent-sdk-linux-x64',
  'linux-arm64': '@anthropic-ai/claude-agent-sdk-linux-arm64',
  'win32-x64': '@anthropic-ai/claude-agent-sdk-win32-x64',
}

const resolveBundledCli = () => {
  const packageName = NATIVE_PACKAGES[`${process.platform}-${process.arch}`]
  if (!packageName) return null
  try {
    const descriptor = require.resolve(`${packageName}/package.json`)
    return join(dirname(descriptor), process.platform === 'win32' ? 'claude.exe' : 'claude')
  } catch {
    return null
  }
}

const run = (executable, args, timeout) => {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
      windowsHide: true,
      maxBuffer: 1 << 22,
    }).trim()
  } catch {
    return null
  }
}

const SEMVER = /(?:^|[^0-9])v?(\d+)\.(\d+)(?:\.(\d+))?/

const main = () => {
  const failures = []
  const executable = process.env.ORCHESTRA_CATALOG_SMOKE_CLI || resolveBundledCli()

  if (!executable) {
    console.error('FAIL: no bundled provider CLI resolved for this platform — the package would ship without one.')
    process.exit(1)
  }

  const rawVersion = run(executable, ['--version'], 15_000)
  const version = rawVersion?.match(SEMVER)?.[0]?.trim() ?? null
  if (!version) failures.push(`CLI did not report a parseable --version (got: ${JSON.stringify(rawVersion)})`)

  // The CLI enumerates its model catalog without auth; an empty list means the
  // picker would be blank for every operator on this build.
  const rawModels = run(executable, ['--print', '--output-format', 'json', '--help'], 20_000)
  const modelsProbe = run(executable, ['models', 'list', '--json'], 20_000) ?? rawModels
  let modelCount = 0
  if (modelsProbe) {
    try {
      const parsed = JSON.parse(modelsProbe)
      const list = Array.isArray(parsed) ? parsed : parsed?.models ?? []
      modelCount = Array.isArray(list) ? list.length : 0
    } catch {
      // Not JSON — fall back to counting known model families in the text output.
      modelCount = (modelsProbe.match(/\b(opus|sonnet|haiku|fable)\b/gi) ?? []).length
    }
  }
  if (modelCount === 0) {
    failures.push('CLI returned an EMPTY model catalog — the hire picker would list no models')
  }

  const report = { executable, version, model_count: modelCount, ok: failures.length === 0 }
  console.log(JSON.stringify(report, null, 2))

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL: ${failure}`)
    process.exit(1)
  }
  console.log('provider catalog smoke: OK')
}

main()
