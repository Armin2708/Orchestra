import { describe, expect, it } from 'vitest'
import {
  CONTEXT_SELECTION_REASONS,
  CONTEXT_SECTIONS,
  KNOWLEDGE_CONTENT_STATES,
  KNOWLEDGE_FRESHNESS_POLICIES,
  KNOWLEDGE_FRESHNESS_STATES,
  KNOWLEDGE_HASH_DOMAINS,
  KNOWLEDGE_INGEST_STATES,
  KNOWLEDGE_REDACTION_STATES,
  KNOWLEDGE_SOURCE_KINDS,
  KNOWLEDGE_TRUST_CLASSES,
  KnowledgeContractError,
  MAX_CONTEXT_BUDGET_CHARACTERS,
  MAX_CONTEXT_BUDGET_TOKENS,
  canonicalKnowledgeHash,
  canonicalKnowledgeJson,
  contextBuildId,
  contextManifestFingerprint,
  contextRequestFingerprint,
  contextUseId,
  knowledgeChunkId,
  knowledgeSourceId,
  knowledgeSourceSetFingerprint,
  normalizeKnowledgeLocator,
  orderContextCandidates,
  validateContextBuildAccounting,
  validateContextBudget,
  validateContextBudgetUsage,
  validateContextBuildEntry,
  validateContextRequestIdentity,
  validateContextUse,
  validateKnowledgeAccessScope,
  validateKnowledgeSourceRange,
  validateKnowledgeTargetLinks,
  validateRepositoryProvenance,
} from '../src/agent-os/index.js'
import type {
  ContextBuildEntry,
  ContextOrderingCandidate,
  ContextRequestIdentityInput,
  KnowledgeContractErrorCode,
  KnowledgeSourceSetEntry,
  KnowledgeTargetLinks,
} from '../src/agent-os/index.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const SOURCE_A = `ks_${HASH_A}`
const SOURCE_B = `ks_${HASH_B}`
const CHUNK_A = `kc_${HASH_A}`
const CHUNK_B = `kc_${HASH_B}`
const BUILD_A = `cb_${HASH_A}`

function targetLinks(
  overrides: Partial<KnowledgeTargetLinks> = {},
): KnowledgeTargetLinks {
  return {
    board_id: 1,
    workspace_id: 'workspace-1',
    card_id: null,
    contract_ref: null,
    contract_version: null,
    contract_snapshot_sha256: null,
    job_id: 'job-1',
    profile_id: 'profile-1',
    session_id: 'session-1',
    delivery_report_id: null,
    ...overrides,
  }
}

function requestIdentity(
  overrides: Partial<ContextRequestIdentityInput> = {},
): ContextRequestIdentityInput {
  return {
    board_id: 1,
    access_scope: { kind: 'workspace', workspace_id: 'workspace-1' },
    targets: targetLinks(),
    budget: {
      max_tokens: 1_000,
      max_characters: 4_000,
      sections: {},
    },
    selection_request_sha256: HASH_C,
    ...overrides,
  }
}

function caughtContractError(action: () => unknown): KnowledgeContractError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeContractError)
    return error as KnowledgeContractError
  }
  throw new Error('expected a knowledge contract error')
}

function expectContractError(
  action: () => unknown,
  code: KnowledgeContractErrorCode,
): KnowledgeContractError {
  const error = caughtContractError(action)
  expect(error.code).toBe(code)
  return error
}

function trackGetCalls<T extends object>(target: T, onGet: () => void): T {
  return new Proxy(target, {
    get(current, key, receiver) {
      onGet()
      return Reflect.get(current, key, receiver)
    },
  })
}

function seededShuffle<T>(input: readonly T[], seed: number): T[] {
  const output = [...input]
  let state = seed >>> 0
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    const target = state % (index + 1)
    ;[output[index], output[target]] = [output[target], output[index]]
  }
  return output
}

function sourceSetEntry(
  sourceId: string,
  overrides: Partial<KnowledgeSourceSetEntry> = {},
): KnowledgeSourceSetEntry {
  return {
    source_id: sourceId,
    source_revision: 'commit:abc123',
    content_sha256: HASH_A,
    freshness_state: 'fresh',
    redaction_state: 'none',
    ...overrides,
  }
}

function candidate(
  suffix: string,
  overrides: Partial<ContextOrderingCandidate> = {},
): ContextOrderingCandidate {
  return {
    chunk_id: `kc_${suffix.padStart(64, '0')}`,
    section: 'relevant_code',
    pinned: false,
    authority_rank: 10,
    score_micros: 100,
    source_kind: 'code_symbol',
    locator: 'src/core.ts',
    start_line: 10,
    ...overrides,
  }
}

const ZERO_SCORE = {
  authority_micros: 0,
  relevance_micros: 0,
  freshness_micros: 0,
  recency_micros: 0,
  contract_micros: 0,
  pin_micros: 0,
}

function manifestEntry(
  candidateOrdinal: number,
  overrides: Partial<ContextBuildEntry> = {},
): ContextBuildEntry {
  return {
    source_id: candidateOrdinal === 0 ? SOURCE_A : SOURCE_B,
    chunk_id: candidateOrdinal === 0 ? CHUNK_A : CHUNK_B,
    section: 'relevant_code',
    candidate_ordinal: candidateOrdinal,
    selected_ordinal: candidateOrdinal === 0 ? 0 : null,
    decision: candidateOrdinal === 0 ? 'selected' : 'omitted',
    reason: candidateOrdinal === 0 ? 'within_budget' : 'lower_rank',
    score_components: ZERO_SCORE,
    score_micros: 0,
    rendering: candidateOrdinal === 0 ? 'full' : 'none',
    estimated_tokens: candidateOrdinal === 0 ? 8 : 0,
    character_count: candidateOrdinal === 0 ? 24 : 0,
    source_kind: 'code_symbol',
    trust_class: 'reference',
    freshness_state: 'fresh',
    redaction_state: 'none',
    normalized_locator: `src/file-${candidateOrdinal}.ts`,
    source_range: {
      start_line: candidateOrdinal + 1,
      end_line: candidateOrdinal + 1,
      start_byte: null,
      end_byte: null,
    },
    content_sha256: candidateOrdinal === 0 ? HASH_A : HASH_B,
    ...overrides,
  }
}

describe('immutable knowledge enum contracts', () => {
  it('freezes every exported enum array and preserves identity fixed points', () => {
    const exportedEnums = [
      KNOWLEDGE_SOURCE_KINDS,
      KNOWLEDGE_TRUST_CLASSES,
      KNOWLEDGE_FRESHNESS_STATES,
      KNOWLEDGE_FRESHNESS_POLICIES,
      KNOWLEDGE_REDACTION_STATES,
      KNOWLEDGE_CONTENT_STATES,
      KNOWLEDGE_INGEST_STATES,
      CONTEXT_SECTIONS,
      CONTEXT_SELECTION_REASONS,
      KNOWLEDGE_HASH_DOMAINS,
    ] as const
    const request = requestIdentity({
      budget: {
        max_tokens: 1_000,
        max_characters: 4_000,
        sections: {
          relevant_code: {
            max_tokens: 500,
            max_characters: 2_000,
          },
        },
      },
    })
    const fingerprint = contextRequestFingerprint(request)

    for (const values of exportedEnums) {
      const snapshot = [...values]
      expect(Object.isFrozen(values)).toBe(true)
      expect(() => {
        ;(values as unknown as string[]).splice(0, 1)
      }).toThrow(TypeError)
      expect([...values]).toEqual(snapshot)
    }
    expect(contextRequestFingerprint(request)).toBe(fingerprint)
  })
})

describe('strict canonical knowledge hashing', () => {
  it('sorts keys recursively, preserves array order, and normalizes negative zero', () => {
    expect(canonicalKnowledgeJson({
      z: -0,
      a: { z: 2, a: 1 },
      list: ['second', 'first'],
    })).toBe('{"a":{"a":1,"z":2},"list":["second","first"],"z":0}')

    expect(canonicalKnowledgeJson({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}')
  })

  it('is stable across insertion order and separates every identity domain', () => {
    const left = { repository: 'repo', nested: { z: 2, a: 1 } }
    const right = { nested: { a: 1, z: 2 }, repository: 'repo' }
    expect(canonicalKnowledgeHash('source', left))
      .toBe(canonicalKnowledgeHash('source', right))
    expect(canonicalKnowledgeHash('source', left))
      .not.toBe(canonicalKnowledgeHash('chunk', left))
    expect(canonicalKnowledgeHash('context-request', left))
      .not.toBe(canonicalKnowledgeHash('source', left))
  })

  it('serializes descriptor snapshots without invoking changing Proxy get traps', () => {
    let objectGetCalls = 0
    const objectValue = new Proxy(
      { nested: { safe: true }, value: 0 },
      {
        get(target, key, receiver) {
          objectGetCalls += 1
          if (key === 'value') return objectGetCalls
          return Reflect.get(target, key, receiver)
        },
      },
    )
    const objectJson = '{"nested":{"safe":true},"value":0}'
    const objectHash = canonicalKnowledgeHash('source', objectValue)
    expect(canonicalKnowledgeJson(objectValue)).toBe(objectJson)
    expect(canonicalKnowledgeJson(objectValue)).toBe(objectJson)
    expect(canonicalKnowledgeHash('source', objectValue)).toBe(objectHash)
    expect(objectGetCalls).toBe(0)

    let arrayGetCalls = 0
    const arrayValue = new Proxy(
      [0, { safe: true }],
      {
        get(target, key, receiver) {
          arrayGetCalls += 1
          if (key === '0') return arrayGetCalls
          return Reflect.get(target, key, receiver)
        },
      },
    )
    const arrayJson = '[0,{"safe":true}]'
    const arrayHash = canonicalKnowledgeHash('chunk', arrayValue)
    expect(canonicalKnowledgeJson(arrayValue)).toBe(arrayJson)
    expect(canonicalKnowledgeJson(arrayValue)).toBe(arrayJson)
    expect(canonicalKnowledgeHash('chunk', arrayValue)).toBe(arrayHash)
    expect(arrayGetCalls).toBe(0)
  })

  it('uses descriptor snapshots across validators, fingerprints, and IDs', () => {
    let getCalls = 0
    const tracked = <T extends object>(value: T): T =>
      trackGetCalls(value, () => {
        getCalls += 1
      })

    const canonicalOptions = tracked({
      max_depth: 4,
      max_nodes: 100,
      max_string_characters: 1_000,
      max_serialized_bytes: 4_000,
    })
    expect(canonicalKnowledgeJson({ safe: true }, canonicalOptions))
      .toBe('{"safe":true}')

    const sourceRange = tracked({
      start_line: 4,
      end_line: 8,
      start_byte: 10,
      end_byte: 40,
    })
    expect(validateKnowledgeSourceRange(sourceRange)).toEqual({
      start_line: 4,
      end_line: 8,
      start_byte: 10,
      end_byte: 40,
    })

    const accessScope = tracked({
      kind: 'workspace' as const,
      workspace_id: 'workspace-1',
    })
    expect(validateKnowledgeAccessScope(accessScope)).toEqual({
      kind: 'workspace',
      workspace_id: 'workspace-1',
    })

    const provenance = tracked({
      repository_key: 'agentboard',
      base_commit_sha: 'd'.repeat(40),
      worktree_state_hash: HASH_A,
      relative_root: '.',
      adapter_id: 'gitnexus',
      adapter_version: '1.0.0',
      adapter_index_commit_sha: 'e'.repeat(40),
      observed_at: '2026-07-25T12:00:00.000Z',
    })
    expect(validateRepositoryProvenance(provenance).base_commit_sha)
      .toBe('d'.repeat(40))

    const targets = tracked(targetLinks())
    expect(validateKnowledgeTargetLinks(targets)).toEqual(targetLinks())

    const sectionBudget = tracked({
      max_tokens: 100,
      max_characters: 500,
    })
    const budget = tracked({
      max_tokens: 1_000,
      max_characters: 4_000,
      sections: tracked({ relevant_code: sectionBudget }),
    })
    expect(validateContextBudget(budget)).toEqual({
      max_tokens: 1_000,
      max_characters: 4_000,
      sections: {
        relevant_code: {
          max_tokens: 100,
          max_characters: 500,
        },
      },
    })

    const sectionUsage = tracked({
      used_tokens: 8,
      used_characters: 24,
    })
    const usage = tracked({
      used_tokens: 8,
      used_characters: 24,
      sections: tracked({ relevant_code: sectionUsage }),
    })
    expect(validateContextBudgetUsage(usage, budget).used_tokens).toBe(8)

    const orderingValues = tracked([
      tracked(candidate('1')),
    ])
    expect(orderContextCandidates(orderingValues)).toHaveLength(1)

    const baseManifestEntry = manifestEntry(0)
    const trackedManifestEntry = tracked({
      ...baseManifestEntry,
      score_components: tracked({ ...baseManifestEntry.score_components }),
      source_range: tracked({ ...baseManifestEntry.source_range }),
    })
    expect(validateContextBuildEntry(trackedManifestEntry).chunk_id).toBe(CHUNK_A)
    const manifest = tracked([trackedManifestEntry])
    const manifestFingerprint = contextManifestFingerprint(manifest)
    expect(manifestFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(
      validateContextBuildAccounting(manifest, usage, budget).manifest_fingerprint,
    ).toBe(manifestFingerprint)

    const sourceIdentity = tracked({
      repository_key: 'agentboard',
      source_kind: 'code_symbol' as const,
      normalized_locator: 'src/agent-os/snapshots.ts',
      source_revision: 'commit:snapshot',
      content_sha256: HASH_A,
    })
    const sourceId = knowledgeSourceId(sourceIdentity)
    expect(sourceId).toMatch(/^ks_[a-f0-9]{64}$/u)

    const sourceSet = tracked([
      tracked(sourceSetEntry(sourceId)),
    ])
    const sourceSetFingerprint = knowledgeSourceSetFingerprint(sourceSet)
    expect(sourceSetFingerprint).toMatch(/^[a-f0-9]{64}$/u)

    const contextRequest: ContextRequestIdentityInput = tracked({
      board_id: 1,
      access_scope: accessScope,
      targets,
      budget,
      selection_request_sha256: HASH_C,
    })
    expect(validateContextRequestIdentity(contextRequest).board_id).toBe(1)
    const requestFingerprint = contextRequestFingerprint(contextRequest)
    expect(requestFingerprint).toMatch(/^[a-f0-9]{64}$/u)

    const chunkIdentity = tracked({
      source_id: sourceId,
      ordinal: 0,
      content_sha256: HASH_B,
      source_range: tracked({
        start_line: 4,
        end_line: 8,
        start_byte: 10,
        end_byte: 40,
      }),
    })
    const chunkId = knowledgeChunkId(chunkIdentity)
    expect(chunkId).toMatch(/^kc_[a-f0-9]{64}$/u)

    const buildIdentity = tracked({
      request: contextRequest,
      source_set_fingerprint: sourceSetFingerprint,
      manifest_fingerprint: manifestFingerprint,
    })
    const buildId = contextBuildId(buildIdentity)
    expect(buildId).toMatch(/^cb_[a-f0-9]{64}$/u)

    const useIdentity = tracked({
      context_build_id: buildId,
      job_id: 'job-snapshot',
      session_id: 'session-snapshot',
      injection_ordinal: 0,
    })
    expect(contextUseId(useIdentity)).toMatch(/^cu_[a-f0-9]{64}$/u)
    expect(getCalls).toBe(0)
  })

  it('prevents changing Proxy reads from bypassing commit and hash validation', () => {
    const baseCommitSha = 'd'.repeat(40)
    let provenanceGetCalls = 0
    const provenance = new Proxy(
      {
        repository_key: 'agentboard',
        base_commit_sha: baseCommitSha,
        worktree_state_hash: HASH_A,
        relative_root: '.',
        adapter_id: 'graphify',
        adapter_version: '1.0.0',
        adapter_index_commit_sha: null,
        observed_at: '2026-07-25T12:00:00.000Z',
      },
      {
        get(target, key, receiver) {
          provenanceGetCalls += 1
          if (key === 'base_commit_sha') {
            return provenanceGetCalls === 1 ? baseCommitSha : 'NOT-A-COMMIT'
          }
          return Reflect.get(target, key, receiver)
        },
      },
    )
    expect(validateRepositoryProvenance(provenance).base_commit_sha)
      .toBe(baseCommitSha)
    expect(provenanceGetCalls).toBe(0)

    let sourceGetCalls = 0
    const sourceIdentity = new Proxy(
      {
        repository_key: 'agentboard',
        source_kind: 'code_symbol' as const,
        normalized_locator: 'src/agent-os/proxy.ts',
        source_revision: 'commit:proxy',
        content_sha256: HASH_A,
      },
      {
        get(target, key, receiver) {
          sourceGetCalls += 1
          if (key === 'content_sha256') {
            return sourceGetCalls === 1 ? HASH_A : 'NOT-A-SHA'
          }
          return Reflect.get(target, key, receiver)
        },
      },
    )
    const sourceId = knowledgeSourceId(sourceIdentity)
    expect(knowledgeSourceId(sourceIdentity)).toBe(sourceId)
    expect(sourceGetCalls).toBe(0)
  })

  it('redacts hostile and revoked Proxy reflection failures at every snapshot seam', () => {
    const secret = 'SENTINEL_PROXY_REFLECTION_CREDENTIAL'
    const fail = (): never => {
      throw new Error(secret)
    }
    const expectRedacted = (
      action: () => unknown,
      code: KnowledgeContractErrorCode,
    ): void => {
      const error = expectContractError(action, code)
      expect(error.message).not.toContain(secret)
      expect(error.stack ?? '').not.toContain(secret)
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
    }

    const descriptorWithPoisonedGetters = new Proxy({}, {
      get: fail,
    }) as PropertyDescriptor
    const invariantTarget = Object.defineProperty(
      {},
      secret,
      { value: true, enumerable: true, configurable: false },
    )
    let revokeBetweenReflectionPhases = (): void => undefined
    const revokedBetweenPhases = Proxy.revocable(
      { value: true },
      {
        ownKeys(target) {
          const keys = Reflect.ownKeys(target)
          revokeBetweenReflectionPhases()
          return keys
        },
      },
    )
    revokeBetweenReflectionPhases = revokedBetweenPhases.revoke

    for (const value of [
      new Proxy({}, { getPrototypeOf: fail }),
      new Proxy({}, { ownKeys: fail }),
      new Proxy({ value: 1 }, { getOwnPropertyDescriptor: fail }),
      new Proxy({ value: 1 }, {
        getOwnPropertyDescriptor: () => descriptorWithPoisonedGetters,
      }),
      new Proxy(invariantTarget, { ownKeys: () => [] }),
      revokedBetweenPhases.proxy,
    ]) {
      expectRedacted(
        () => canonicalKnowledgeJson(value),
        'invalid_canonical_value',
      )
    }

    for (const value of [
      new Proxy({ kind: 'board' }, { getPrototypeOf: fail }),
      new Proxy({ kind: 'board' }, { ownKeys: fail }),
      new Proxy({ kind: 'board' }, { getOwnPropertyDescriptor: fail }),
    ]) {
      expectRedacted(
        () => validateKnowledgeAccessScope(value),
        'invalid_scope',
      )
    }

    for (const value of [
      new Proxy([candidate('1')], { ownKeys: fail }),
      new Proxy([candidate('1')], { getOwnPropertyDescriptor: fail }),
    ]) {
      expectRedacted(
        () => orderContextCandidates(value),
        'invalid_contract',
      )
    }

    const revokedCanonical = Proxy.revocable({}, {})
    const revokedRecord = Proxy.revocable({ kind: 'board' }, {})
    const revokedArray = Proxy.revocable([candidate('1')], {})
    revokedCanonical.revoke()
    revokedRecord.revoke()
    revokedArray.revoke()
    expectContractError(
      () => canonicalKnowledgeJson(revokedCanonical.proxy),
      'invalid_canonical_value',
    )
    expectContractError(
      () => validateKnowledgeAccessScope(revokedRecord.proxy),
      'invalid_scope',
    )
    expectContractError(
      () => orderContextCandidates(revokedArray.proxy),
      'invalid_contract',
    )
  })

  it('requires array own keys to exactly match length and every dense index', () => {
    let canonicalElementDescriptorCalls = 0
    const incoherentCanonical = new Proxy([7], {
      ownKeys: () => ['length', '1'],
      getOwnPropertyDescriptor(target, key) {
        if (key === '0') canonicalElementDescriptorCalls += 1
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    expectContractError(
      () => canonicalKnowledgeJson(incoherentCanonical),
      'invalid_canonical_value',
    )
    expect(canonicalElementDescriptorCalls).toBe(0)

    let contractElementDescriptorCalls = 0
    const incoherentContracts = new Proxy([candidate('1')], {
      ownKeys: () => ['length', '1'],
      getOwnPropertyDescriptor(target, key) {
        if (key === '0') contractElementDescriptorCalls += 1
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    expectContractError(
      () => orderContextCandidates(incoherentContracts),
      'invalid_contract',
    )
    expect(contractElementDescriptorCalls).toBe(0)
  })

  it('creates stable content-addressed IDs and changes them when identity changes', () => {
    const sourceIdentity = {
      repository_key: 'agentboard',
      source_kind: 'code_symbol' as const,
      normalized_locator: 'src/agent-os/example.ts',
      source_revision: 'commit:abc123',
      content_sha256: HASH_A,
    }
    const sourceId = knowledgeSourceId(sourceIdentity)
    expect(sourceId).toMatch(/^ks_[a-f0-9]{64}$/u)
    expect(knowledgeSourceId({ ...sourceIdentity })).toBe(sourceId)
    expect(knowledgeSourceId({ ...sourceIdentity, content_sha256: HASH_B }))
      .not.toBe(sourceId)

    const chunkId = knowledgeChunkId({
      source_id: sourceId,
      ordinal: 0,
      content_sha256: HASH_B,
      source_range: { start_line: 2, end_line: 4, start_byte: 10, end_byte: 80 },
    })
    expect(chunkId).toMatch(/^kc_[a-f0-9]{64}$/u)

    const request = requestIdentity()
    const requestFingerprint = contextRequestFingerprint(request)
    expect(requestFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    const sourceSetFingerprint = knowledgeSourceSetFingerprint([
      sourceSetEntry(sourceId),
    ])
    const manifestFingerprint = contextManifestFingerprint([])
    const buildId = contextBuildId({
      request,
      source_set_fingerprint: sourceSetFingerprint,
      manifest_fingerprint: manifestFingerprint,
    })
    expect(buildId).toMatch(/^cb_[a-f0-9]{64}$/u)
    expect(contextUseId({
      context_build_id: buildId,
      job_id: 'job-1',
      session_id: 'session-1',
      injection_ordinal: 0,
    })).toMatch(/^cu_[a-f0-9]{64}$/u)
  })

  it('keeps hashes, fingerprints, and content-addressed IDs at a fixed point', () => {
    const sourceIdentity = {
      repository_key: 'agentboard',
      source_kind: 'code_symbol' as const,
      normalized_locator: 'src/agent-os/fixed-point.ts',
      source_revision: 'commit:def456',
      content_sha256: HASH_A,
    }
    const sourceId = knowledgeSourceId(sourceIdentity)
    const chunkIdentity = {
      source_id: sourceId,
      ordinal: 3,
      content_sha256: HASH_B,
      source_range: {
        start_line: 7,
        end_line: 9,
        start_byte: 20,
        end_byte: 80,
      },
    }
    const request = requestIdentity()
    const sourceSet = [sourceSetEntry(sourceId)]
    const manifest = [manifestEntry(0)]
    const buildIdentity = {
      request,
      source_set_fingerprint: knowledgeSourceSetFingerprint(sourceSet),
      manifest_fingerprint: contextManifestFingerprint(manifest),
    }
    const buildId = contextBuildId(buildIdentity)
    const useIdentity = {
      context_build_id: buildId,
      job_id: 'job-fixed-point',
      session_id: 'session-fixed-point',
      injection_ordinal: 2,
    }
    const snapshot = () => ({
      canonical_hash: canonicalKnowledgeHash('source', sourceIdentity),
      source_id: knowledgeSourceId(sourceIdentity),
      chunk_id: knowledgeChunkId(chunkIdentity),
      request_fingerprint: contextRequestFingerprint(request),
      source_set_fingerprint: knowledgeSourceSetFingerprint(sourceSet),
      manifest_fingerprint: contextManifestFingerprint(manifest),
      build_id: contextBuildId(buildIdentity),
      use_id: contextUseId(useIdentity),
    })

    expect(snapshot()).toEqual(snapshot())
  })

  it('rejects unsupported JavaScript shapes instead of silently dropping them', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expectContractError(() => canonicalKnowledgeJson(cycle), 'canonical_cycle')

    for (const value of [
      { missing: undefined },
      { function: () => undefined },
      { bigint: 1n },
      { infinite: Number.POSITIVE_INFINITY },
      { nan: Number.NaN },
      new Date('2026-01-01T00:00:00.000Z'),
      Object.assign(Object.create({ inherited: true }), { own: true }),
      [, 'array-hole'],
    ]) {
      expectContractError(
        () => canonicalKnowledgeJson(value),
        'invalid_canonical_value',
      )
    }

    const symbolObject = { safe: true, [Symbol('hidden')]: 'not-hashed' }
    expectContractError(
      () => canonicalKnowledgeJson(symbolObject),
      'invalid_canonical_value',
    )
    const accessorObject = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 'not-evaluated',
    })
    expectContractError(
      () => canonicalKnowledgeJson(accessorObject),
      'invalid_canonical_value',
    )
  })

  it('rejects accessors, inherited prototypes, and sparse arrays without reading them', () => {
    let accessorGetCalls = 0
    const accessorObject = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        accessorGetCalls += 1
        return 'not-evaluated'
      },
    })
    expectContractError(
      () => canonicalKnowledgeJson(accessorObject),
      'invalid_canonical_value',
    )
    expect(accessorGetCalls).toBe(0)

    let inheritedGetCalls = 0
    const inheritedPrototype = Object.defineProperty({}, 'inherited', {
      enumerable: true,
      get: () => {
        inheritedGetCalls += 1
        return 'not-evaluated'
      },
    })
    const inheritedObject = Object.assign(
      Object.create(inheritedPrototype) as Record<string, unknown>,
      { own: 'safe' },
    )
    expectContractError(
      () => canonicalKnowledgeJson(inheritedObject),
      'invalid_canonical_value',
    )
    expect(inheritedGetCalls).toBe(0)

    let sparseGetCalls = 0
    const sparseTarget: unknown[] = []
    sparseTarget.length = 2
    sparseTarget[1] = 'present'
    const sparseArray = new Proxy(sparseTarget, {
      get(target, key, receiver) {
        sparseGetCalls += 1
        return Reflect.get(target, key, receiver)
      },
    })
    expectContractError(
      () => canonicalKnowledgeJson(sparseArray),
      'invalid_canonical_value',
    )
    expect(sparseGetCalls).toBe(0)
  })

  it('enforces depth, node, string, and serialized byte limits', () => {
    expectContractError(
      () => canonicalKnowledgeJson({ nested: { value: true } }, { max_depth: 1 }),
      'canonical_depth_exceeded',
    )
    expectContractError(
      () => canonicalKnowledgeJson([1, 2], { max_nodes: 2 }),
      'canonical_node_limit_exceeded',
    )
    expectContractError(
      () => canonicalKnowledgeJson('1234', { max_string_characters: 3 }),
      'canonical_string_limit_exceeded',
    )
    expectContractError(
      () => canonicalKnowledgeJson({ a: '1234' }, { max_serialized_bytes: 8 }),
      'canonical_size_exceeded',
    )
    expectContractError(
      () => canonicalKnowledgeJson(true, { max_nodes: 100_001 }),
      'invalid_contract',
    )
    expectContractError(
      () => canonicalKnowledgeJson(true, { unexpected: 1 } as never),
      'invalid_contract',
    )
    for (const field of [
      'max_depth',
      'max_nodes',
      'max_string_characters',
      'max_serialized_bytes',
    ] as const) {
      expectContractError(
        () => canonicalKnowledgeJson(true, { [field]: null } as never),
        'invalid_contract',
      )
    }
  })

  it('bounds descriptor reflection before rejecting oversized records', () => {
    const keys = Array.from({ length: 2_000 }, (_, index) => `field_${index}`)
    let canonicalDescriptorCalls = 0
    const canonicalValue = new Proxy({}, {
      ownKeys: () => keys,
      getOwnPropertyDescriptor: () => {
        canonicalDescriptorCalls += 1
        return {
          value: true,
          enumerable: true,
          configurable: true,
          writable: true,
        }
      },
    })
    expectContractError(
      () => canonicalKnowledgeJson(canonicalValue, { max_nodes: 1 }),
      'canonical_node_limit_exceeded',
    )
    expect(canonicalDescriptorCalls).toBe(0)

    let recordDescriptorCalls = 0
    const oversizedRecord = new Proxy({}, {
      ownKeys: () => keys,
      getOwnPropertyDescriptor: () => {
        recordDescriptorCalls += 1
        return {
          value: true,
          enumerable: true,
          configurable: true,
          writable: true,
        }
      },
    })
    expectContractError(
      () => validateKnowledgeAccessScope(oversizedRecord),
      'invalid_scope',
    )
    expect(recordDescriptorCalls).toBe(0)
  })

  it('rejects attacker-controlled sparse lengths before walking the array', () => {
    const hugeSparse: unknown[] = []
    hugeSparse.length = 10_000_000
    expectContractError(
      () => canonicalKnowledgeJson(hugeSparse),
      'canonical_node_limit_exceeded',
    )

    const boundedSparse: unknown[] = []
    boundedSparse.length = 10
    expectContractError(
      () => orderContextCandidates(boundedSparse as ContextOrderingCandidate[]),
      'invalid_contract',
    )
  })

  it('never echoes rejected content, object keys, or locators in errors', () => {
    const secret = 'credential-SUPER-SECRET-987'
    const invalid = { [secret]: undefined }
    const errors = [
      caughtContractError(() => canonicalKnowledgeJson(invalid)),
      caughtContractError(() => canonicalKnowledgeJson(secret, {
        max_string_characters: 3,
      })),
      caughtContractError(() => normalizeKnowledgeLocator(`${secret}\u0000`)),
    ]
    for (const error of errors) expect(error.message).not.toContain(secret)
  })

  it('rejects credential-bearing URL locators after full slash and URL normalization', () => {
    const marker = 'SENTINEL_LOCATOR_CREDENTIAL'
    const adversarialLocators = [
      `https://user:${marker}@example.test/repo`,
      `ssh://${marker}@example.test/repo`,
      `ssh:user:${marker}@example.test/repo`,
      `ssh:/user:${marker}@example.test/repo`,
      `ssh:///user:${marker}@example.test/repo`,
      `git+ssh:user:${marker}@example.test/repo`,
      `git+ssh:///user:${marker}@example.test/repo`,
      `git+https:user:${marker}@example.test/repo`,
      `git+https:///user:${marker}@example.test/repo`,
      `https:\\\\user:${marker}@example.test/repo`,
      `https:/\\user:${marker}@example.test/repo`,
      `https:///user:${marker}@example.test/repo`,
      `https:user:${marker}@example.test/repo`,
      `https:/user:${marker}@example.test/repo`,
      `https://user%3A${marker}%40example.test/repo`,
      `https://user%3A${marker}%2540example.test/repo`,
      `custom://user:${marker}@example.test/repo`,
      `https://example.test/repo%25%33%46token=${marker}`,
      `https://example.test/repo%25%32%33${marker}`,
      `custom://user:${marker}%25%34%30example.test/repo`,
      String.raw`custom:\\user:${marker}%25%34%30example.test/repo`,
      `https%3A//user:${marker}@example.test/repo`,
      `https%3A%2F%2Fuser:${marker}@example.test/repo`,
      `custom:%2F%2Fuser:${marker}@example.test/repo`,
      `ssh:%2F%2Fuser:${marker}@example.test/repo`,
      'file:/%2Ftmp/repo',
      'file:/%5C%5Cserver/share',
      'file:/tmp/repo%00',
      'file:/tmp/repo%0A',
      `https://example.test/repo?token=${marker}`,
      `https://example.test/repo#${marker}`,
    ]
    const visibleOutputs: string[] = []
    for (const locator of adversarialLocators) {
      const error = expectContractError(
        () => normalizeKnowledgeLocator(locator),
        'invalid_contract',
      )
      visibleOutputs.push(error.message)
    }
    expect(JSON.stringify(visibleOutputs)).not.toContain(marker)
    expect(normalizeKnowledgeLocator('https:example.test/repo'))
      .toBe('https://example.test/repo')
    const encodedSafePath = 'https://example.test/repo%20name'
    expect(normalizeKnowledgeLocator(encodedSafePath)).toBe(encodedSafePath)
    expect(normalizeKnowledgeLocator(normalizeKnowledgeLocator(encodedSafePath)))
      .toBe(encodedSafePath)
  })

  it('uses one idempotent, hostless local file URL identity', () => {
    const canonical = 'file:///tmp/agentboard-repo'
    expect(normalizeKnowledgeLocator('file:/tmp/agentboard-repo')).toBe(canonical)
    expect(normalizeKnowledgeLocator(canonical)).toBe(canonical)
    expect(normalizeKnowledgeLocator(normalizeKnowledgeLocator(canonical)))
      .toBe(canonical)

    for (const ambiguous of [
      'file://tmp/agentboard-repo',
      'file://localhost/tmp/agentboard-repo',
      'file:////tmp/agentboard-repo',
      'file:relative/agentboard-repo',
    ]) {
      expectContractError(
        () => normalizeKnowledgeLocator(ambiguous),
        'invalid_contract',
      )
    }

    const identity = {
      repository_key: 'agentboard',
      source_kind: 'documentation' as const,
      normalized_locator: canonical,
      source_revision: 'commit:abc123',
      content_sha256: HASH_A,
    }
    expect(knowledgeSourceId(identity)).toBe(knowledgeSourceId({
      ...identity,
      normalized_locator: normalizeKnowledgeLocator('file:/tmp/agentboard-repo'),
    }))
  })
})

describe('knowledge provenance and target contracts', () => {
  it('validates paired inclusive line and exclusive byte ranges', () => {
    expect(validateKnowledgeSourceRange({
      start_line: 2,
      end_line: 9,
      start_byte: 10,
      end_byte: 40,
    })).toEqual({
      start_line: 2,
      end_line: 9,
      start_byte: 10,
      end_byte: 40,
    })
    expect(validateKnowledgeSourceRange({
      start_line: null,
      end_line: null,
      start_byte: null,
      end_byte: null,
    })).toEqual({
      start_line: null,
      end_line: null,
      start_byte: null,
      end_byte: null,
    })

    for (const range of [
      { start_line: 1, end_line: null, start_byte: null, end_byte: null },
      { start_line: 0, end_line: 1, start_byte: null, end_byte: null },
      { start_line: 3, end_line: 2, start_byte: null, end_byte: null },
      { start_line: null, end_line: null, start_byte: 2, end_byte: null },
      { start_line: null, end_line: null, start_byte: 2, end_byte: 2 },
    ]) {
      expectContractError(
        () => validateKnowledgeSourceRange(range),
        'invalid_range',
      )
    }
  })

  it('accepts only closed, bounded access-scope variants', () => {
    expect(validateKnowledgeAccessScope({ kind: 'board' })).toEqual({ kind: 'board' })
    expect(validateKnowledgeAccessScope({
      kind: 'workspace',
      workspace_id: ' workspace-1 ',
    })).toEqual({ kind: 'workspace', workspace_id: 'workspace-1' })
    expect(validateKnowledgeAccessScope({
      kind: 'contract',
      card_id: 4,
      contract_version: 2,
    })).toEqual({ kind: 'contract', card_id: 4, contract_version: 2 })
    expect(validateKnowledgeAccessScope({ kind: 'job', job_id: 'job-1' }))
      .toEqual({ kind: 'job', job_id: 'job-1' })
    expect(validateKnowledgeAccessScope({ kind: 'profile', profile_id: 'profile-1' }))
      .toEqual({ kind: 'profile', profile_id: 'profile-1' })
    expect(validateKnowledgeAccessScope({ kind: 'session', session_id: 'session-1' }))
      .toEqual({ kind: 'session', session_id: 'session-1' })

    for (const scope of [
      { kind: 'board', workspace_id: 'smuggled' },
      { kind: 'workspace', workspace_id: '' },
      { kind: 'contract', card_id: 1, contract_version: 0 },
      { kind: 'unknown' },
    ]) {
      expectContractError(() => validateKnowledgeAccessScope(scope), 'invalid_scope')
    }
  })

  it('binds request and build identities to board, scope, targets, and budget', () => {
    const request = requestIdentity()
    expect(validateContextRequestIdentity(request)).toEqual(request)
    const fingerprint = contextRequestFingerprint(request)
    const changedBudget = requestIdentity({
      budget: { ...request.budget, max_tokens: 999 },
    })
    expect(contextRequestFingerprint(changedBudget)).not.toBe(fingerprint)

    const build = contextBuildId({
      request,
      source_set_fingerprint: HASH_A,
      manifest_fingerprint: HASH_B,
    })
    expect(contextBuildId({
      request: changedBudget,
      source_set_fingerprint: HASH_A,
      manifest_fingerprint: HASH_B,
    })).not.toBe(build)

    for (const invalid of [
      requestIdentity({ board_id: 2 }),
      requestIdentity({
        access_scope: { kind: 'workspace', workspace_id: 'workspace-other' },
      }),
      requestIdentity({
        access_scope: { kind: 'job', job_id: 'job-other' },
      }),
      requestIdentity({
        access_scope: { kind: 'contract', card_id: 7, contract_version: 3 },
      }),
    ]) {
      expectContractError(
        () => validateContextRequestIdentity(invalid),
        'invalid_contract',
      )
    }
  })

  it('requires exact repository revision and safe repo-relative provenance', () => {
    const provenance = {
      repository_key: 'agentboard',
      base_commit_sha: '1'.repeat(40),
      worktree_state_hash: HASH_A,
      relative_root: 'packages/agent-os',
      adapter_id: 'gitnexus',
      adapter_version: '1.2.3',
      adapter_index_commit_sha: HASH_B,
      observed_at: '2026-07-25T12:34:56.789Z',
    }
    expect(validateRepositoryProvenance(provenance)).toEqual(provenance)
    expect(validateRepositoryProvenance({ ...provenance, relative_root: '.' }).relative_root)
      .toBe('.')
    expect(validateRepositoryProvenance({
      ...provenance,
      adapter_index_commit_sha: '2'.repeat(40),
    }).adapter_index_commit_sha).toBe('2'.repeat(40))

    for (const invalid of [
      { ...provenance, base_commit_sha: 'A'.repeat(40) },
      { ...provenance, worktree_state_hash: 'A'.repeat(64) },
      { ...provenance, relative_root: '/absolute/path' },
      { ...provenance, relative_root: '../outside' },
      { ...provenance, relative_root: 'safe/../outside' },
      { ...provenance, relative_root: 'safe\\outside' },
      { ...provenance, relative_root: 'C:/outside' },
      { ...provenance, observed_at: '2026-07-25' },
      { ...provenance, extra: 'not-allowed' },
    ]) {
      expectContractError(
        () => validateRepositoryProvenance(invalid),
        'invalid_provenance',
      )
    }
  })

  it('keeps contract links coherent and rejects partial or forged snapshots', () => {
    const links = {
      board_id: 1,
      workspace_id: 'workspace-1',
      card_id: 7,
      contract_ref: 'card:7:v3',
      contract_version: 3,
      contract_snapshot_sha256: HASH_C,
      job_id: 'job-1',
      profile_id: 'profile-1',
      session_id: 'session-1',
      delivery_report_id: 'report-1',
    }
    expect(validateKnowledgeTargetLinks(links)).toEqual(links)
    expect(validateKnowledgeTargetLinks({
      ...links,
      card_id: null,
      contract_ref: null,
      contract_version: null,
      contract_snapshot_sha256: null,
    })).toMatchObject({ card_id: null, contract_ref: null })

    for (const invalid of [
      { ...links, contract_ref: 'card:7:v2' },
      { ...links, contract_version: null },
      { ...links, contract_snapshot_sha256: null },
      { ...links, card_id: null },
      { ...links, board_id: 0 },
      { ...links, contract_snapshot_sha256: 'A'.repeat(64) },
    ]) {
      expectContractError(
        () => validateKnowledgeTargetLinks(invalid),
        'invalid_targets',
      )
    }
  })

  it('does not echo adversarial provenance values in validation failures', () => {
    const secret = 'password=do-not-log-this'
    const error = expectContractError(
      () => validateRepositoryProvenance({
        repository_key: 'agentboard',
        base_commit_sha: '1'.repeat(40),
        worktree_state_hash: HASH_A,
        relative_root: `../${secret}`,
        adapter_id: 'git',
        adapter_version: '1',
        adapter_index_commit_sha: null,
        observed_at: '2026-07-25T12:34:56.789Z',
      }),
      'invalid_provenance',
    )
    expect(error.message).not.toContain(secret)
  })
})

describe('strict context budgets', () => {
  it('allows an explicit zero-context budget and canonicalizes section order', () => {
    expect(validateContextBudget({
      max_tokens: 0,
      max_characters: 0,
      sections: {},
    })).toEqual({ max_tokens: 0, max_characters: 0, sections: {} })

    const budget = validateContextBudget({
      max_tokens: 1_000,
      max_characters: 4_000,
      sections: {
        working_memory_delta: { max_tokens: 100, max_characters: 400 },
        task_contract: { max_tokens: 200, max_characters: 800 },
        project_brief: { max_tokens: 50, max_characters: 200 },
      },
    })
    expect(Object.keys(budget.sections)).toEqual([
      'project_brief',
      'task_contract',
      'working_memory_delta',
    ])
    expect(Object.keys(budget.sections).map((section) => CONTEXT_SECTIONS.indexOf(
      section as typeof CONTEXT_SECTIONS[number],
    ))).toEqual([0, 1, 7])
  })

  it('rejects unsafe, unknown, negative, and section-over-total budgets', () => {
    const valid = { max_tokens: 10, max_characters: 40, sections: {} }
    for (const invalid of [
      { ...valid, max_tokens: -1 },
      { ...valid, max_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, max_tokens: MAX_CONTEXT_BUDGET_TOKENS + 1 },
      { ...valid, max_characters: 1.5 },
      { ...valid, max_characters: MAX_CONTEXT_BUDGET_CHARACTERS + 1 },
      { ...valid, sections: { unknown: { max_tokens: 1, max_characters: 1 } } },
      {
        ...valid,
        sections: { relevant_code: { max_tokens: 11, max_characters: 40 } },
      },
      {
        ...valid,
        sections: { relevant_code: { max_tokens: 10, max_characters: 41 } },
      },
    ]) {
      expectContractError(() => validateContextBudget(invalid), 'invalid_budget')
    }
  })

  it('enforces total and section hard caps while allowing wrapper overhead', () => {
    const budget = {
      max_tokens: 100,
      max_characters: 1_000,
      sections: {
        task_contract: { max_tokens: 40, max_characters: 400 },
        relevant_code: { max_tokens: 50, max_characters: 500 },
      },
    }
    expect(validateContextBudgetUsage({
      used_tokens: 95,
      used_characters: 950,
      sections: {
        relevant_code: { used_tokens: 45, used_characters: 450 },
        task_contract: { used_tokens: 35, used_characters: 350 },
      },
    }, budget)).toEqual({
      used_tokens: 95,
      used_characters: 950,
      sections: {
        task_contract: { used_tokens: 35, used_characters: 350 },
        relevant_code: { used_tokens: 45, used_characters: 450 },
      },
    })

    for (const usage of [
      { used_tokens: 101, used_characters: 100, sections: {} },
      {
        used_tokens: 50,
        used_characters: 500,
        sections: { task_contract: { used_tokens: 41, used_characters: 300 } },
      },
      {
        used_tokens: 50,
        used_characters: 500,
        sections: { relevant_code: { used_tokens: 40, used_characters: 501 } },
      },
      {
        used_tokens: 10,
        used_characters: 100,
        sections: { relevant_code: { used_tokens: 11, used_characters: 100 } },
      },
      {
        used_tokens: 10,
        used_characters: 100,
        sections: { unknown: { used_tokens: 1, used_characters: 1 } },
      },
    ]) {
      expectContractError(
        () => validateContextBudgetUsage(usage, budget),
        'budget_exceeded',
      )
    }
  })
})

describe('context-use lifecycle contracts', () => {
  it('requires completed token evidence and monotonic completion time', () => {
    const identity = {
      context_build_id: BUILD_A,
      job_id: 'job-lifecycle',
      session_id: 'session-lifecycle',
      injection_ordinal: 0,
    }
    const running = {
      id: contextUseId(identity),
      ...identity,
      board_id: 1,
      manifest_fingerprint: HASH_A,
      estimated_tokens: 5,
      actual_tokens: null,
      cache_identity: 'cache-lifecycle',
      outcome: 'running' as const,
      injected_at: '2026-07-26T09:01:00.000Z',
      completed_at: null,
    }

    expect(validateContextUse(running)).toEqual(running)
    expect(validateContextUse({
      ...running,
      outcome: 'failed',
      completed_at: '2026-07-26T09:02:00.000Z',
    })).toMatchObject({ outcome: 'failed', actual_tokens: null })
    expectContractError(
      () => validateContextUse({
        ...running,
        outcome: 'completed',
        completed_at: '2026-07-26T09:02:00.000Z',
      }),
      'invalid_contract',
    )
    expectContractError(
      () => validateContextUse({
        ...running,
        outcome: 'completed',
        actual_tokens: 4,
        completed_at: '2026-07-26T09:00:59.999Z',
      }),
      'invalid_contract',
    )
  })
})

describe('deterministic context selection order', () => {
  it('applies every stable tie breaker in the documented order', () => {
    expect(orderContextCandidates([
      candidate('1', { section: 'task_contract', pinned: true }),
      candidate('2', { section: 'project_brief', pinned: false }),
    ]).map((item) => item.chunk_id)).toEqual([
      candidate('2').chunk_id,
      candidate('1').chunk_id,
    ])

    expect(orderContextCandidates([
      candidate('1', { pinned: false, authority_rank: 100 }),
      candidate('2', { pinned: true, authority_rank: 0 }),
    ])[0].chunk_id).toBe(candidate('2').chunk_id)
    expect(orderContextCandidates([
      candidate('1', { authority_rank: 9, score_micros: 1_000 }),
      candidate('2', { authority_rank: 10, score_micros: 0 }),
    ])[0].chunk_id).toBe(candidate('2').chunk_id)
    expect(orderContextCandidates([
      candidate('1', { score_micros: 99 }),
      candidate('2', { score_micros: 100 }),
    ])[0].chunk_id).toBe(candidate('2').chunk_id)
    expect(orderContextCandidates([
      candidate('1', { source_kind: 'readme' }),
      candidate('2', { source_kind: 'architecture' }),
    ])[0].chunk_id).toBe(candidate('1').chunk_id)
    expect(orderContextCandidates([
      candidate('1', { locator: 'src/z.ts' }),
      candidate('2', { locator: 'src/a.ts' }),
    ])[0].chunk_id).toBe(candidate('2').chunk_id)
    expect(orderContextCandidates([
      candidate('1', { start_line: null }),
      candidate('2', { start_line: 100 }),
    ])[0].chunk_id).toBe(candidate('2').chunk_id)
    expect(orderContextCandidates([
      candidate('2'),
      candidate('1'),
    ])[0].chunk_id).toBe(candidate('1').chunk_id)
  })

  it('is invariant across seeded input shuffles and does not mutate input', () => {
    const candidates = [
      candidate('1', { section: 'project_brief' }),
      candidate('2', { pinned: true }),
      candidate('3', { authority_rank: 20 }),
      candidate('4', { score_micros: 200 }),
      candidate('5', { source_kind: 'readme' }),
      candidate('6', { locator: 'src/a.ts' }),
      candidate('7', { start_line: 1 }),
      candidate('8', { locator: 'src\\nested//file.ts' }),
    ]
    const expected = orderContextCandidates(candidates).map((item) => item.chunk_id)
    const snapshot = structuredClone(candidates)
    for (let seed = 1; seed <= 128; seed += 1) {
      expect(orderContextCandidates(seededShuffle(candidates, seed))
        .map((item) => item.chunk_id)).toEqual(expected)
    }
    expect(candidates).toEqual(snapshot)
    expect(orderContextCandidates([candidate('9', {
      locator: 'src\\nested//file.ts',
    })])[0].locator).toBe('src/nested/file.ts')
  })

  it('rejects duplicate chunks and unsafe ranking fields', () => {
    expectContractError(
      () => orderContextCandidates([candidate('1'), candidate('1')]),
      'duplicate_identity',
    )
    expectContractError(
      () => orderContextCandidates([candidate('1', { score_micros: 1.5 })]),
      'invalid_contract',
    )
    expectContractError(
      () => orderContextCandidates([candidate('1', { locator: 'unsafe\u0000path' })]),
      'invalid_contract',
    )
  })
})

describe('source-set and context-manifest fingerprints', () => {
  it('makes source-set fingerprints independent of input order', () => {
    const entries = [
      sourceSetEntry(SOURCE_A, { content_sha256: HASH_A }),
      sourceSetEntry(SOURCE_B, { content_sha256: HASH_B }),
      sourceSetEntry(`ks_${HASH_C}`, {
        content_sha256: HASH_C,
        freshness_state: 'stale',
      }),
    ]
    const expected = knowledgeSourceSetFingerprint(entries)
    for (let seed = 1; seed <= 128; seed += 1) {
      expect(knowledgeSourceSetFingerprint(seededShuffle(entries, seed))).toBe(expected)
    }
    expect(knowledgeSourceSetFingerprint([
      entries[0],
      { ...entries[1], source_revision: 'commit:different' },
      entries[2],
    ])).not.toBe(expected)
  })

  it('rejects duplicate source identities even when their revisions differ', () => {
    expectContractError(
      () => knowledgeSourceSetFingerprint([
        sourceSetEntry(SOURCE_A),
        sourceSetEntry(SOURCE_A, { source_revision: 'other' }),
      ]),
      'duplicate_identity',
    )
  })

  it('validates selection invariants and canonicalizes manifest order', () => {
    const selected = manifestEntry(0)
    const omitted = manifestEntry(1)
    const expected = contextManifestFingerprint([selected, omitted])
    expect(contextManifestFingerprint([omitted, selected])).toBe(expected)
    expect(contextManifestFingerprint([])).toMatch(/^[a-f0-9]{64}$/u)
    expect(validateContextBuildEntry(selected)).toEqual(selected)

    for (const entries of [
      [manifestEntry(1)],
      [manifestEntry(0), manifestEntry(0, { chunk_id: CHUNK_B })],
      [manifestEntry(0, { selected_ordinal: 1 })],
      [manifestEntry(0, { rendering: 'none' })],
      [manifestEntry(0, { reason: 'lower_rank' })],
      [manifestEntry(0, { estimated_tokens: 0 })],
      [manifestEntry(0, { redaction_state: 'withheld' })],
      [manifestEntry(1, { estimated_tokens: 1 })],
      [manifestEntry(1, { rendering: 'summary' })],
      [manifestEntry(0, { score_micros: 1 })],
    ]) {
      expectContractError(
        () => contextManifestFingerprint(entries),
        'invalid_manifest',
      )
    }
    expect(validateContextBuildEntry(manifestEntry(1, {
      redaction_state: 'withheld',
      reason: 'withheld',
    })).redaction_state).toBe('withheld')
    expectContractError(
      () => contextManifestFingerprint([
        manifestEntry(0),
        manifestEntry(1, { chunk_id: CHUNK_A }),
      ]),
      'duplicate_identity',
    )
  })

  it('reconciles selected contributions with section usage and hard budgets', () => {
    const entries = [manifestEntry(0), manifestEntry(1)]
    const budget = {
      max_tokens: 12,
      max_characters: 40,
      sections: {
        relevant_code: { max_tokens: 10, max_characters: 30 },
      },
    }
    const accounting = validateContextBuildAccounting(entries, {
      used_tokens: 10,
      used_characters: 30,
      sections: {
        relevant_code: { used_tokens: 8, used_characters: 24 },
      },
    }, budget)
    expect(accounting.entries).toEqual(entries)
    expect(accounting.manifest_fingerprint).toBe(contextManifestFingerprint(entries))

    expectContractError(
      () => validateContextBuildAccounting(entries, {
        used_tokens: 0,
        used_characters: 0,
        sections: {},
      }, budget),
      'budget_exceeded',
    )
    expectContractError(
      () => validateContextBuildAccounting(entries, {
        used_tokens: 8,
        used_characters: 24,
        sections: {
          relevant_code: { used_tokens: 8, used_characters: 24 },
        },
      }, {
        max_tokens: 7,
        max_characters: 24,
        sections: {},
      }),
      'budget_exceeded',
    )
  })

  it('keeps rejected manifest text out of error messages', () => {
    const secret = 'api_key=manifest-secret-value'
    const error = expectContractError(
      () => validateContextBuildEntry(manifestEntry(0, {
        normalized_locator: `https://user:${secret}@example.test/file`,
      })),
      'invalid_contract',
    )
    expect(error.message).not.toContain(secret)
  })
})
