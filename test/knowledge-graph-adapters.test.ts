import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GitNexusKnowledgeAdapter,
  GraphifyKnowledgeAdapter,
  KnowledgeGraphAdapterError,
  MAX_KNOWLEDGE_GRAPH_ADAPTER_OUTPUT_BYTES,
  type KnowledgeAdapterCommand,
  type KnowledgeAdapterCommandResult,
} from '../src/agent-os/knowledge-graph-adapters.js'

const directories: string[] = []
const BASE = 'a'.repeat(40)

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function repository(): { root: string; graph: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-adapter-'))
  directories.push(root)
  fs.mkdirSync(path.join(root, 'graphify-out'))
  const graph = path.join(root, 'graphify-out', 'graph.json')
  fs.writeFileSync(graph, '{}')
  return { root, graph }
}

const ok = (stdout: string): KnowledgeAdapterCommandResult => ({
  status: 0,
  signal: null,
  stdout,
  stderr: '',
  error: false,
})

function common(root: string) {
  return {
    version: 1 as const,
    repository_key: 'agentboard',
    repository_root: root,
    base_commit_sha: BASE,
    adapter_version: '1.6.9',
    adapter_index_commit_sha: BASE,
  }
}

describe('Knowledge graph adapters', () => {
  it('runs GitNexus without a shell, bounds fanout, and returns stable exact-source signals', () => {
    const { root } = repository()
    const commands: KnowledgeAdapterCommand[] = []
    const runner = (command: KnowledgeAdapterCommand): KnowledgeAdapterCommandResult => {
      commands.push(command)
      return ok(JSON.stringify({
        incoming: {
          calls: [
            { name: 'zeta', filePath: 'src/zeta.ts', startLine: 9 },
            { name: 'alpha', filePath: 'src/alpha.ts', startLine: 2 },
          ],
        },
        outgoing: {
          calls: [{ name: 'alpha', filePath: 'src/alpha.ts', startLine: 2 }],
        },
      }))
    }
    const adapter = new GitNexusKnowledgeAdapter(runner)
    const request = {
      ...common(root),
      requests: [{
        kind: 'code_flow' as const,
        query: 'knowledge "; touch /tmp/never',
        task_context: 'bounded task',
        goal: 'exact source context',
      }],
    }
    const first = adapter.collect(request)
    const second = adapter.collect(request)

    expect(first).toEqual(second)
    expect(first.map((item) => item.source_location)).toEqual([
      'src/alpha.ts:2',
      'src/zeta.ts:9',
    ])
    expect(first.every((item) => item.provenance.adapter_index_commit_sha === BASE)).toBe(true)
    expect(first.every((item) => /^[a-f0-9]{64}$/u.test(item.evidence_sha256))).toBe(true)
    expect(commands).toHaveLength(2)
    expect(commands[0]).toMatchObject({
      command: 'gitnexus',
      cwd: fs.realpathSync(root),
      max_output_bytes: MAX_KNOWLEDGE_GRAPH_ADAPTER_OUTPUT_BYTES,
    })
    expect(commands[0].args).toContain('knowledge "; touch /tmp/never')
    expect(commands[0].args).not.toContain('sh')
  })

  it('parses only Graphify NODE citations and sorts them independently of tool order', () => {
    const { root } = repository()
    const output = [
      'Traversal: BFS depth=2',
      'NODE Zeta [src=docs/zeta.md loc=L19 community=4]',
      'arbitrary summary without a source',
      'NODE Alpha [src=docs/alpha.md loc=L3 community=2]',
    ].join('\n')
    const adapter = new GraphifyKnowledgeAdapter(() => ok(output))
    const request = {
      ...common(root),
      graph_path: 'graphify-out/graph.json',
      questions: [{ kind: 'rationale' as const, question: 'Why is knowledge scoped?' }],
    }
    const signals = adapter.collect(request)
    expect(signals.map((item) => [item.label, item.source_location, item.relationship])).toEqual([
      ['Alpha', 'docs/alpha.md:3', 'community:2'],
      ['Zeta', 'docs/zeta.md:19', 'community:4'],
    ])
    expect(signals.every((item) => item.adapter === 'graphify')).toBe(true)
  })

  it('fails closed on stale indexes, NUL input, malformed/huge output, timeout, and graph escape', () => {
    const { root } = repository()
    const request = {
      ...common(root),
      requests: [{ kind: 'call_graph' as const, symbol: 'KnowledgeStore' }],
    }
    expect(() => new GitNexusKnowledgeAdapter(() => ok('{}')).collect({
      ...request,
      adapter_index_commit_sha: 'b'.repeat(40),
    })).toThrowError(expect.objectContaining({
      code: 'repository_revision_mismatch',
      message: 'knowledge graph adapter revision does not match',
    }))
    expect(() => new GitNexusKnowledgeAdapter(() => ok('{}')).collect({
      ...common(root),
      requests: [{ kind: 'code_flow' as const, query: 'bad\u0000query' }],
    })).toThrowError(KnowledgeGraphAdapterError)
    expect(() => new GitNexusKnowledgeAdapter(() => ok('{')).collect(request))
      .toThrowError(expect.objectContaining({ code: 'output_invalid' }))
    expect(() => new GitNexusKnowledgeAdapter(() => ok(
      'x'.repeat(MAX_KNOWLEDGE_GRAPH_ADAPTER_OUTPUT_BYTES + 1),
    )).collect(request)).toThrowError(expect.objectContaining({ code: 'output_exceeded' }))
    expect(() => new GitNexusKnowledgeAdapter(() => ({
      status: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: 'secret output is not reflected',
      error: true,
    })).collect(request)).toThrowError(expect.objectContaining({
      code: 'command_failed',
      message: 'knowledge graph adapter command failed',
    }))

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-graph-outside-'))
    directories.push(outside)
    fs.writeFileSync(path.join(outside, 'graph.json'), '{}')
    expect(() => new GraphifyKnowledgeAdapter(() => ok('')).collect({
      ...common(root),
      graph_path: path.relative(root, path.join(outside, 'graph.json')),
      questions: [{ kind: 'rationale', question: 'why' }],
    })).toThrowError(expect.objectContaining({ code: 'invalid_request' }))
  })
})
