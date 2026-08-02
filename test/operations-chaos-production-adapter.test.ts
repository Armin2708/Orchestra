import { afterEach, describe, expect, it } from 'vitest'
import {
  OPERATIONS_CHAOS_IDS,
  assertAdversarialContractPassed,
  runOperationsChaosContract,
} from './support/remote-ops-adversarial-contract.js'
import { ProductionOperationsChaosTarget } from './support/production-operations-chaos-target.js'

let target: ProductionOperationsChaosTarget | null = null

afterEach(async () => {
  await target?.close()
  target = null
})

describe.sequential('QA-016 production-bound operations chaos adapter', () => {
  it('executes OPS-CHAOS-01 through 04 against real recovery, lease, outbox, SQLite, Git, and network seams', async () => {
    target = new ProductionOperationsChaosTarget()
    const results = await runOperationsChaosContract(target)
    expect(results.map(({ id }) => id)).toEqual(OPERATIONS_CHAOS_IDS)
    expect(results).toEqual(results.map((result) => ({
      id: result.id,
      title: result.title,
      status: 'passed',
    })))
    assertAdversarialContractPassed(results)
  }, 60_000)
})
