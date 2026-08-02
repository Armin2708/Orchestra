import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  KnowledgeBenchmarkStore,
  evaluateKnowledgeBenchmark,
  runControlledKnowledgeBenchmark,
  type KnowledgeBenchmarkOutcome,
} from '../src/agent-os/knowledge-benchmark.js'

const temporary: string[] = []
afterEach(() => { for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true }) })
const source = `ks_${'a'.repeat(64)}`
const artifact = { ref: 'artifacts/benchmark.json', sha256: 'b'.repeat(64) }
const outcome = (overrides: Partial<KnowledgeBenchmarkOutcome> = {}): KnowledgeBenchmarkOutcome => ({
  accepted: true, quality_micros: 900_000, input_tokens: 1_000, output_tokens: 200,
  repeated_exploration_steps: 8, cited_source_ids: [], fresh_citation_count: 0,
  evidence_artifact: artifact, ...overrides,
})

describe('controlled Knowledge context benchmark', () => {
  it('passes only when cited fresh context saves tokens/exploration without quality loss', async () => {
    const task = { objective: 'Update the focused service.', acceptance_criteria: ['Tests pass.'],
      repository_head_sha: 'c'.repeat(40), provider: 'codex', model: 'gpt-5', seed: 'fixed-1' }
    const evidence = await runControlledKnowledgeBenchmark(task, async (variant) =>
      variant === 'without_context' ? outcome() : outcome({ quality_micros: 910_000,
        input_tokens: 600, output_tokens: 190, repeated_exploration_steps: 3,
        cited_source_ids: [source], fresh_citation_count: 1 }))
    expect(evidence.gate).toMatchObject({ passed: true, input_tokens_saved: 400,
      repeated_exploration_saved: 5, cited_fresh_context: true })

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-kno-benchmark-'))
    temporary.push(directory)
    const db = openDb(path.join(directory, 'db.sqlite'))
    db.prepare('INSERT INTO boards (id, project_path, name) VALUES (1, ?, ?)')
      .run(directory, 'Benchmark')
    const store = new KnowledgeBenchmarkStore(db)
    const recorded = store.record(1, evidence, '2026-08-02T08:00:00.000Z')
    expect(recorded.gate_passed).toBe(true)
    expect(store.record(1, evidence, '2026-08-02T08:00:00.000Z')).toEqual(recorded)
    db.close()
  })

  it('fails closed when tokens drop but quality, acceptance, citations, or exploration regress', () => {
    const control = outcome()
    expect(evaluateKnowledgeBenchmark(control, outcome({ quality_micros: 800_000,
      input_tokens: 500, repeated_exploration_steps: 2, cited_source_ids: [source],
      fresh_citation_count: 1 })).passed).toBe(false)
    expect(evaluateKnowledgeBenchmark(control, outcome({ accepted: false, input_tokens: 500,
      repeated_exploration_steps: 2, cited_source_ids: [source], fresh_citation_count: 1 })).passed).toBe(false)
    expect(evaluateKnowledgeBenchmark(control, outcome({ input_tokens: 500,
      repeated_exploration_steps: 2 })).passed).toBe(false)
    expect(evaluateKnowledgeBenchmark(control, outcome({ input_tokens: 500,
      repeated_exploration_steps: 9, cited_source_ids: [source], fresh_citation_count: 1 })).passed).toBe(false)
  })
})
