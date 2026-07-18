#!/usr/bin/env node
// Runs the token-diet A/B harness and prints the before/after table used in
// docs/token-diet.md. Usage: node scripts/ab-token-diet.mjs [--json]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-report-')), 'report.json')
try {
  execFileSync('npx', ['vitest', 'run', 'test/token-diet-ab.test.ts'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, AB_REPORT: report },
  })
} catch {
  process.exit(1) // vitest already printed the failure
}

const r = JSON.parse(fs.readFileSync(report, 'utf8'))
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(r, null, 2))
  process.exit(0)
}

const events = [...new Set([...Object.keys(r.verbose.by_event), ...Object.keys(r.compact.by_event)])]
const row = (label, v, c) => {
  const pct = v ? Math.round((1 - c / v) * 1000) / 10 : 0
  return `| ${label} | ${v} | ${c} | ${pct}% |`
}
console.log('\n## Injected tokens per session (identical replayed scenario)\n')
console.log('| hook event | verbose (tok) | compact (tok) | reduction |')
console.log('|---|---|---|---|')
for (const e of events) {
  console.log(row(e, r.verbose.by_event[e]?.tokens ?? 0, r.compact.by_event[e]?.tokens ?? 0))
}
console.log(row('**total**', r.verbose.total.tokens, r.compact.total.tokens))
console.log('\n## Compliance gates (must be identical)\n')
console.log('| gate | verbose | compact |')
console.log('|---|---|---|')
for (const k of Object.keys(r.verbose.compliance)) {
  console.log(`| ${k} | ${r.verbose.compliance[k] ? '✓' : '✗'} | ${r.compact.compliance[k] ? '✓' : '✗'} |`)
}
if (!r.modes_differ) {
  console.log('\n⚠ verbose and compact produced identical output — the compact injections (#35) are not on this branch yet.')
}
