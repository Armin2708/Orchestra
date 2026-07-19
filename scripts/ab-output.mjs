#!/usr/bin/env node
// Live output-side A/B for the terse-mode rules (#57). Runs scripted turns against the
// real SDK twice — arm A with ORCHESTRA_VERBOSE_OUTPUT=1 (no discipline block), arm B
// with the block — and reports assistant text lengths. Costs real tokens; NOT run in CI
// (CI enforces the deterministic invariants in test/output-discipline.test.ts instead).
// Usage: npx tsx scripts/ab-output.mjs [--model claude-haiku-4-5-20251001] [--json]
import { query } from '@anthropic-ai/claude-agent-sdk'
import { conductorRules } from '../src/rules.js'

const model = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1] : 'claude-haiku-4-5-20251001'
const tok = (chars) => Math.ceil(chars / 4)

// scripted moments where hired agents historically over-narrate
const TURNS = [
  { key: 'completion_report', prompt: 'You just finished card #12 "widget parser": all 14 tests pass, merged as abc1234. Report completion.' },
  { key: 'status_update', prompt: 'A teammate asks for a status check on your card #12 (parser done, writing tests). Answer them.' },
  { key: 'plan_ack', prompt: 'You were just assigned card #13: "add a --json flag to the export CLI; DONE WHEN tests cover both output modes". Acknowledge and state your plan.' },
]

async function arm(name, env) {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  const rules = conductorRules('ab-runner')
  const out = {}
  for (const t of TURNS) {
    const q = query({ prompt: t.prompt, options: {
      cwd: process.cwd(), model, permissionMode: 'bypassPermissions', allowedTools: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: rules },
    } })
    let text = ''
    for await (const m of q) {
      if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'text') text += b.text
      if (m.type === 'result') break
    }
    out[t.key] = { chars: text.length, tokens: tok(text.length) }
    process.stderr.write(`  ${name}/${t.key}: ${text.length} chars\n`)
  }
  process.env = saved
  out.total = Object.values(out).reduce((a, e) => ({ chars: a.chars + e.chars, tokens: 0 }), { chars: 0 })
  out.total.tokens = tok(out.total.chars)
  return out
}

process.stderr.write(`model: ${model}\n`)
const undisciplined = await arm('undisciplined', { ORCHESTRA_VERBOSE_OUTPUT: '1' })
const disciplined = await arm('disciplined', {})

const report = { model, turns: TURNS.map((t) => t.key), undisciplined, disciplined,
  reduction_pct: undisciplined.total.chars === 0 ? 0
    : Math.round((1 - disciplined.total.chars / undisciplined.total.chars) * 1000) / 10 }

if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0) }
console.log(`\n## Output tokens per scripted turn (${model})\n`)
console.log('| turn | undisciplined (tok) | disciplined (tok) | reduction |')
console.log('|---|---|---|---|')
for (const k of [...report.turns, 'total']) {
  const u = undisciplined[k], d = disciplined[k]
  const pct = u.chars ? Math.round((1 - d.chars / u.chars) * 1000) / 10 : 0
  console.log(`| ${k === 'total' ? '**total**' : k} | ${u.tokens} | ${d.tokens} | ${pct}% |`)
}
