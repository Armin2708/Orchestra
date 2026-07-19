import { describe, expect, it } from 'vitest'
import { PolicyEngine } from '../src/agent-os/policy-engine.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { CODEX_REQUEST_UNHANDLED } from '../src/codex/client.js'
import { codexApprovalPolicyHandler } from '../src/codex/policy.js'
import { openDb } from '../src/db.js'
import type { CodexDriverApprovalRequest } from '../src/runtime/drivers/codex.js'

const request = (kind: CodexDriverApprovalRequest['kind'], params: Record<string, unknown>): CodexDriverApprovalRequest => ({
  kind,
  sessionId: 'driver-session',
  threadId: 'thread-policy',
  turnId: 'turn-policy',
  itemId: 'item-policy',
  requestId: 'request-policy',
  method: `test/${kind}`,
  params: { threadId: 'thread-policy', ...params },
})

describe('Codex Agent OS approval policy bridge', () => {
  it('auto-allows, auto-denies, asks, and fails closed from durable task policy', async () => {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO boards (id, project_path, name) VALUES (1, '/project', 'project')").run()
    db.prepare("INSERT INTO cards (id, board_id, title, description) VALUES (1, 1, 'Policy card', 'safe work')").run()
    db.prepare(`INSERT INTO workspaces
      (id, board_id, card_id, name, kind, root_path, base_ref)
      VALUES ('workspace-policy', 1, 1, 'policy', 'shared', '/project', 'HEAD')`).run()
    const policy = new PolicyEngine(db).create({
      boardId: 1,
      name: 'codex-safe',
      commandGlobs: ['npm test*', '!rm *'],
      fileGlobs: ['src/**', '!src/secrets/**'],
      approvalScope: 'ask',
    })
    new TaskContractService(db).put(1, { policy_id: policy.id })
    db.prepare(`INSERT INTO jobs
      (id, board_id, card_id, workspace_id, provider, status)
      VALUES ('job-policy', 1, 1, 'workspace-policy', 'codex', 'running')`).run()
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, external_id, status, context_json)
      VALUES ('session-policy', 'workspace-policy', 'codex', 'thread-policy', 'running', '{"job_id":"job-policy"}')`).run()
    const handle = codexApprovalPolicyHandler(db)

    await expect(handle(request('command', { command: 'npm test -- auth' }))).resolves.toEqual({ decision: 'accept' })
    await expect(handle(request('command', { command: 'rm build' }))).resolves.toEqual({ decision: 'decline' })
    await expect(handle(request('command', { command: 'git status' }))).resolves.toBe(CODEX_REQUEST_UNHANDLED)
    await expect(handle(request('file-change', { path: 'src/secrets/key.ts' }))).resolves.toEqual({ decision: 'decline' })
    await expect(handle(request('command', {}))).resolves.toEqual({ decision: 'decline' })
  })
})
