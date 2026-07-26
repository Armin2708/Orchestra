import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { canonicalHash } from '../src/agent-os/agent-home-support.js'
import { EventStore } from '../src/agent-os/event-store.js'
import { JobAssignmentService } from '../src/agent-os/job-assignments.js'
import { JobMarketService } from '../src/agent-os/job-market.js'
import { openDb } from '../src/db.js'

const tempDirectories: string[] = []
const actor = { type: 'operator', id: 'assignment-test' }

afterEach(() => {
  while (tempDirectories.length) {
    fs.rmSync(tempDirectories.pop()!, { recursive: true, force: true })
  }
})

function fixture(file = ':memory:') {
  const db = openDb(file)
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES (?, 'assignment board')",
  ).run(`/assignment-${Math.random()}`).lastInsertRowid)
  const cardId = Number(db.prepare(
    `INSERT INTO cards (board_id, title, description)
      VALUES (?, 'Canonical assignment', 'Deliver canonical ownership')`,
  ).run(boardId).lastInsertRowid)
  const profiles = new AgentProfileService(db)
  const first = profiles.create({
    boardId,
    name: 'First agent',
    capabilities: ['typescript', 'sqlite'],
    actor,
    idempotencyKey: `profile:first:${cardId}`,
  })
  const second = profiles.create({
    boardId,
    name: 'Second agent',
    capabilities: ['typescript', 'sqlite'],
    actor,
    idempotencyKey: `profile:second:${cardId}`,
  })
  const market = new JobMarketService(db)
  market.get(cardId)
  return {
    db,
    boardId,
    cardId,
    profiles,
    first,
    second,
    market,
    assignments: new JobAssignmentService(db),
  }
}

function claimInput(
  cardId: number,
  profileId: string,
  expectedMarketVersion: number,
  idempotencyKey: string,
) {
  return {
    cardId,
    profileId,
    expectedMarketVersion,
    actor,
    idempotencyKey,
  }
}

describe('canonical Job Market assignment domain', () => {
  it('claims, audits, lists, and replays an immutable result without projecting legacy ownership', () => {
    const { db, boardId, cardId, first, market, assignments } = fixture()
    const before = market.get(cardId)
    const claimed = assignments.claim(
      claimInput(cardId, first.id, before.market_version, 'assignment:claim-once'),
    )

    expect(claimed).toMatchObject({
      replayed: false,
      assignment: {
        board_id: boardId,
        card_id: cardId,
        profile_id: first.id,
        origin: 'claim',
        status: 'active',
        assigned_market_version: before.market_version + 1,
        version: 1,
      },
      market: {
        status: 'assigned',
        market_version: before.market_version + 1,
      },
    })
    expect(assignments.current(cardId)?.id).toBe(claimed.assignment.id)
    expect(assignments.history(cardId)).toEqual([claimed.assignment])
    expect(assignments.listBoard(boardId, { status: 'active', profileId: first.id }))
      .toEqual([claimed.assignment])
    expect(db.prepare('SELECT owner_agent_id FROM cards WHERE id=?').get(cardId))
      .toEqual({ owner_agent_id: null })

    const event = new EventStore(db).listBoard(boardId, { cardId, limit: 10 })
      .find((candidate) => candidate.kind === 'job_market.assignment_claimed')
    expect(event).toMatchObject({
      idempotency_key: 'assignment:claim-once',
      source: 'job-market',
      payload: {
        assignment_id: claimed.assignment.id,
        actor,
        request_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(JSON.stringify(event?.payload)).not.toContain('idempotencyKey')

    const replay = assignments.claim(
      claimInput(cardId, first.id, before.market_version, 'assignment:claim-once'),
    )
    expect(replay).toEqual({ ...claimed, replayed: true })
    expect(() => assignments.claim({
      ...claimInput(cardId, first.id, before.market_version, 'assignment:claim-once'),
      reason: 'changed intent',
    })).toThrow(/different assignment command/)
    expect(assignments.history(cardId)).toHaveLength(1)
    db.close()
  })

  it('releases with dual compare-and-set and preserves original command replay snapshots', () => {
    const { db, cardId, first, market, assignments } = fixture()
    const initialMarket = market.get(cardId)
    const claimed = assignments.assign(
      claimInput(cardId, first.id, initialMarket.market_version, 'assignment:assign-once'),
    )
    const released = assignments.release({
      cardId,
      assignmentId: claimed.assignment.id,
      expectedMarketVersion: claimed.market.market_version,
      expectedAssignmentVersion: claimed.assignment.version,
      actor,
      idempotencyKey: 'assignment:release-once',
      reason: 'returned to the market',
    })

    expect(released).toMatchObject({
      replayed: false,
      assignment: {
        id: claimed.assignment.id,
        status: 'released',
        version: 2,
        end_reason: 'returned to the market',
        ended_market_version: claimed.market.market_version + 1,
      },
      market: {
        status: 'open',
        market_version: claimed.market.market_version + 1,
      },
    })
    expect(assignments.current(cardId)).toBeNull()
    expect(() => assignments.release({
      cardId,
      assignmentId: claimed.assignment.id,
      expectedMarketVersion: released.market.market_version,
      expectedAssignmentVersion: 2,
      actor,
      idempotencyKey: 'assignment:release-again',
    })).toThrow(/released/)

    const releaseReplay = assignments.release({
      cardId,
      assignmentId: claimed.assignment.id,
      expectedMarketVersion: claimed.market.market_version,
      expectedAssignmentVersion: claimed.assignment.version,
      actor,
      idempotencyKey: 'assignment:release-once',
      reason: 'returned to the market',
    })
    expect(releaseReplay).toEqual({ ...released, replayed: true })
    const releaseEvent = db.prepare(`SELECT payload FROM os_events
      WHERE board_id=? AND idempotency_key='assignment:release-once'`).get(
      released.assignment.board_id,
    ) as { payload: string }
    const forgedReleasePayload = JSON.parse(releaseEvent.payload) as {
      result: { assignment: { ended_at: string } }
    }
    forgedReleasePayload.result.assignment.ended_at = '2099-01-01T00:00:00.000Z'
    db.exec('DROP TRIGGER os_events_job_assignment_identity_update')
    db.prepare(`UPDATE os_events SET payload=?
      WHERE board_id=? AND idempotency_key='assignment:release-once'`).run(
      JSON.stringify(forgedReleasePayload),
      released.assignment.board_id,
    )
    expect(() => assignments.release({
      cardId,
      assignmentId: claimed.assignment.id,
      expectedMarketVersion: claimed.market.market_version,
      expectedAssignmentVersion: claimed.assignment.version,
      actor,
      idempotencyKey: 'assignment:release-once',
      reason: 'returned to the market',
    })).toThrow(/invalid result state/)
    const originalClaimReplay = assignments.assign(
      claimInput(cardId, first.id, initialMarket.market_version, 'assignment:assign-once'),
    )
    expect(originalClaimReplay).toEqual({ ...claimed, replayed: true })
    expect(originalClaimReplay.assignment.status).toBe('active')
    db.close()
  })

  it('reassigns by superseding history and never leaves two active owners', () => {
    const { db, cardId, first, second, market, assignments } = fixture()
    const before = market.get(cardId)
    const claimed = assignments.claim(
      claimInput(cardId, first.id, before.market_version, 'assignment:claim-reassign'),
    )
    const reassigned = assignments.reassign({
      cardId,
      assignmentId: claimed.assignment.id,
      profileId: second.id,
      expectedMarketVersion: claimed.market.market_version,
      expectedAssignmentVersion: claimed.assignment.version,
      actor,
      idempotencyKey: 'assignment:reassign-once',
      reason: 'better capability fit',
    })

    expect(reassigned).toMatchObject({
      assignment: {
        profile_id: second.id,
        origin: 'reassign',
        status: 'active',
        predecessor_assignment_id: claimed.assignment.id,
        predecessor_version: 1,
        assigned_market_version: claimed.market.market_version + 1,
      },
      market: {
        status: 'assigned',
        market_version: claimed.market.market_version + 1,
      },
    })
    expect(assignments.current(cardId)?.id).toBe(reassigned.assignment.id)
    const history = assignments.history(cardId)
    expect(history).toHaveLength(2)
    expect(history.find((item) => item.id === claimed.assignment.id)).toMatchObject({
      status: 'superseded',
      version: 2,
      ended_market_version: reassigned.market.market_version,
    })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM job_market_assignments
      WHERE card_id=? AND status='active'`).get(cardId)).toEqual({ count: 1 })
    expect(() => assignments.reassign({
      cardId,
      assignmentId: reassigned.assignment.id,
      profileId: second.id,
      expectedMarketVersion: reassigned.market.market_version,
      expectedAssignmentVersion: reassigned.assignment.version,
      actor,
      idempotencyKey: 'assignment:same-profile-noop',
      reason: 'no change',
    })).toThrow(/already belongs/)
    db.close()
  })

  it('allows reasoned same-profile reassignment only after the market version advances', () => {
    const { db, cardId, first, market, assignments } = fixture()
    const claimed = assignments.claim(
      claimInput(cardId, first.id, market.get(cardId).market_version, 'assignment:claim-same'),
    )
    market.transition(cardId, 'running')
    market.transition(cardId, 'submitted')
    market.transition(cardId, 'rejected')
    const rejected = market.get(cardId)
    expect(() => market.transition(cardId, 'draft')).toThrow(
      /release the active job market assignment before reopening or drafting/,
    )
    expect(() => assignments.reassign({
      cardId,
      assignmentId: claimed.assignment.id,
      profileId: first.id,
      expectedMarketVersion: rejected.market_version,
      expectedAssignmentVersion: claimed.assignment.version,
      actor,
      idempotencyKey: 'assignment:same-without-reason',
    })).toThrow(/reason is required/)
    const retried = assignments.reassign({
      cardId,
      assignmentId: claimed.assignment.id,
      profileId: first.id,
      expectedMarketVersion: rejected.market_version,
      expectedAssignmentVersion: claimed.assignment.version,
      actor,
      idempotencyKey: 'assignment:same-with-reason',
      reason: 'retry after review feedback',
    })
    expect(retried).toMatchObject({
      assignment: { profile_id: first.id, predecessor_assignment_id: claimed.assignment.id },
      market: { status: 'assigned', market_version: rejected.market_version + 1 },
    })
    db.close()
  })

  it('enforces capability, dependency, workspace, board, legacy-owner, and profile lifecycle guards', () => {
    const { db, boardId, cardId, first, profiles, market, assignments } = fixture()
    market.update(cardId, { required_capabilities: ['typescript', 'gpu'] })
    const constrained = market.get(cardId)
    expect(() => assignments.claim(
      claimInput(cardId, first.id, constrained.market_version, 'assignment:missing-capability'),
    )).toThrow(/lacks required capabilities: gpu/)

    profiles.update(first.id, {
      capabilities: ['typescript', 'sqlite', 'gpu'],
      actor,
      idempotencyKey: 'profile:add-gpu',
    })
    const dependencyCardId = Number(db.prepare(
      `INSERT INTO cards (board_id, title, description, column_name)
        VALUES (?, 'Dependency', 'Finish first', 'backlog')`,
    ).run(boardId).lastInsertRowid)
    market.update(cardId, {
      dependency_rules: [{
        card_id: dependencyCardId,
        blocking_reason: 'foundation incomplete',
        completion_condition: 'card_done',
      }],
    })
    const blocked = market.get(cardId)
    expect(() => assignments.claim(
      claimInput(cardId, first.id, blocked.market_version, 'assignment:dependency-blocked'),
    )).toThrow(/dependency .* is not complete/)

    db.prepare("UPDATE cards SET column_name='done' WHERE id=?").run(dependencyCardId)
    const otherBoardId = Number(db.prepare(
      "INSERT INTO boards (project_path, name) VALUES ('/assignment-other', 'other')",
    ).run().lastInsertRowid)
    const foreignProfile = profiles.create({
      boardId: otherBoardId,
      name: 'Foreign',
      capabilities: ['typescript', 'gpu'],
      actor,
      idempotencyKey: 'profile:foreign',
    })
    expect(() => assignments.claim(
      claimInput(cardId, foreignProfile.id, blocked.market_version, 'assignment:foreign-profile'),
    )).toThrow(/different board/)

    db.prepare(`INSERT INTO workspaces
      (id, board_id, card_id, name, kind, root_path, status)
      VALUES ('foreign-workspace', ?, NULL, 'foreign', 'shared', '/foreign', 'active')`)
      .run(otherBoardId)
    expect(() => assignments.claim({
      ...claimInput(cardId, first.id, blocked.market_version, 'assignment:foreign-workspace'),
      workspaceId: 'foreign-workspace',
    })).toThrow(/workspace scope/)

    const legacyAgentId = Number(db.prepare(
      "INSERT INTO agents (board_id, name) VALUES (?, 'legacy')",
    ).run(boardId).lastInsertRowid)
    db.prepare('UPDATE cards SET owner_agent_id=? WHERE id=?').run(legacyAgentId, cardId)
    expect(() => assignments.claim(
      claimInput(cardId, first.id, blocked.market_version, 'assignment:legacy-owner'),
    )).toThrow(/legacy owner/)
    db.prepare('UPDATE cards SET owner_agent_id=NULL WHERE id=?').run(cardId)

    const claimed = assignments.claim(
      claimInput(cardId, first.id, blocked.market_version, 'assignment:guarded-claim'),
    )
    expect(() => profiles.archive(first.id, {
      actor,
      idempotencyKey: 'profile:archive-active-assignment',
    })).toThrow(/active job market assignment/)
    expect(claimed.assignment.status).toBe('active')
    db.close()
  })

  it('blocks direct assigned/open lifecycle shortcuts around canonical ownership', () => {
    const { db, cardId, first, market, assignments } = fixture()
    const before = market.get(cardId)
    expect(() => market.transition(cardId, 'assigned')).toThrow(/canonical job assignment/)
    const claimed = assignments.assign(
      claimInput(cardId, first.id, before.market_version, 'assignment:lifecycle'),
    )
    expect(() => market.transition(cardId, 'open')).toThrow(/release the active/)
    expect(market.get(cardId)).toMatchObject({
      status: 'assigned',
      market_version: claimed.market.market_version,
    })
    db.close()
  })

  it('rejects stale competing writers across two database handles and replays the winner', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-assignment-race-'))
    tempDirectories.push(directory)
    const file = path.join(directory, 'race.sqlite')
    const firstHandle = fixture(file)
    const secondDb = openDb(file)
    const secondAssignments = new JobAssignmentService(secondDb)
    const expectedMarketVersion = firstHandle.market.get(firstHandle.cardId).market_version
    const winnerInput = claimInput(
      firstHandle.cardId,
      firstHandle.first.id,
      expectedMarketVersion,
      'assignment:cross-handle-winner',
    )
    const winner = firstHandle.assignments.claim(winnerInput)
    expect(() => secondAssignments.assign(claimInput(
      firstHandle.cardId,
      firstHandle.second.id,
      expectedMarketVersion,
      'assignment:cross-handle-loser',
    ))).toThrow(/version is stale|cannot be assigned/)
    expect(secondAssignments.claim(winnerInput)).toEqual({ ...winner, replayed: true })
    expect(secondAssignments.history(firstHandle.cardId)).toHaveLength(1)
    secondDb.close()
    firstHandle.db.close()
  })

  it('maps cross-handle write-lock contention to a stable retryable conflict', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-assignment-lock-'))
    tempDirectories.push(directory)
    const file = path.join(directory, 'lock.sqlite')
    const firstHandle = fixture(file)
    const secondDb = openDb(file)
    secondDb.pragma('busy_timeout = 1')
    const secondAssignments = new JobAssignmentService(secondDb)
    const input = claimInput(
      firstHandle.cardId,
      firstHandle.first.id,
      firstHandle.market.get(firstHandle.cardId).market_version,
      'assignment:locked-writer',
    )
    firstHandle.db.exec('BEGIN IMMEDIATE')
    try {
      expect(() => secondAssignments.claim(input))
        .toThrow(/database is busy; reload and retry/)
    } finally {
      firstHandle.db.exec('ROLLBACK')
    }
    expect(secondAssignments.claim(input)).toMatchObject({
      replayed: false,
      assignment: { status: 'active' },
    })
    secondDb.close()
    firstHandle.db.close()
  })

  it('rejects a forged replay result even when its top-level audit identity is valid', () => {
    const { db, boardId, cardId, first, second, market, assignments } = fixture()
    const current = market.get(cardId)
    const idempotencyKey = 'assignment:forged-replay'
    const fingerprint = canonicalHash({
      command: 'job_assignment.claim',
      cardId,
      profileId: first.id,
      workspaceId: null,
      expectedMarketVersion: current.market_version,
      actor,
      reason: null,
    })
    const assignmentId = 'forged-replay-assignment'
    const at = '2026-07-25T19:00:00.000Z'
    db.prepare(`INSERT INTO job_market_assignments (
      id, board_id, card_id, profile_id, workspace_id, ownership_mode,
      origin, status, assigned_market_version, version,
      predecessor_assignment_id, predecessor_version,
      created_actor_type, created_actor_id, idempotency_key,
      request_fingerprint, reason, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, NULL, 'exclusive', 'claim', 'active', ?, 1,
      NULL, NULL, ?, ?, ?, ?, NULL, ?, ?
    )`).run(
      assignmentId,
      boardId,
      cardId,
      first.id,
      current.market_version + 1,
      actor.type,
      actor.id,
      idempotencyKey,
      fingerprint,
      at,
      at,
    )
    const row = db.prepare('SELECT * FROM job_market_assignments WHERE id=?')
      .get(assignmentId) as Record<string, unknown>
    const insertForgedEvent = () => db.prepare(`INSERT INTO os_events (
      id, board_id, workspace_id, card_id, kind, source, payload,
      idempotency_key, created_at
    ) VALUES (
      'forged-replay-event', ?, NULL, ?, 'job_market.assignment_claimed',
      'job-market', ?, ?, ?
    )`).run(
      boardId,
      cardId,
      JSON.stringify({
        assignment_id: assignmentId,
        request_fingerprint: fingerprint,
        result: {
          assignment: { ...row, profile_id: second.id },
          market: {
            status: 'archived',
            market_version: current.market_version + 1,
          },
          replayed: false,
        },
      }),
      idempotencyKey,
      at,
    )
    expect(insertForgedEvent).toThrow(/audit scope or command identity is inconsistent/)
    db.exec('DROP TRIGGER os_events_job_assignment_insert')
    insertForgedEvent()

    expect(() => assignments.claim(
      claimInput(cardId, first.id, current.market_version, idempotencyKey),
    )).toThrow(/does not match retained history|invalid creation result state/)
    db.close()
  })
})
