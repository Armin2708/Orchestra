#!/usr/bin/env node

import fs from 'node:fs'
import readline from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.144.6\n')
  process.exit(0)
}

if (process.argv[2] !== 'app-server') {
  process.stderr.write(`unsupported fake Codex invocation: ${process.argv.slice(2).join(' ')}\n`)
  process.exit(2)
}

const statePath = process.env.FAKE_CODEX_STATE
if (!statePath) {
  process.stderr.write('FAKE_CODEX_STATE is required\n')
  process.exit(2)
}

const freshState = () => ({
  boots: 0,
  nextThread: 1,
  nextTurn: 1,
  calls: [],
  threads: {},
})

const loadState = () => {
  try {
    return { ...freshState(), ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }
  } catch {
    return freshState()
  }
}

let state = loadState()
state.boots += 1

const saveState = () => {
  const temporary = `${statePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(temporary, statePath)
}

const threadShape = (stored) => ({
  id: stored.id,
  sessionId: `session-${stored.id}`,
  parentThreadId: null,
  status: stored.turns.some((turn) => turn.status === 'inProgress')
    ? { type: 'active', activeFlags: [] }
    : { type: 'idle' },
  cwd: stored.cwd,
  cliVersion: '0.144.6-fake',
  agentNickname: null,
  agentRole: null,
  createdAt: 1_700_000_000,
  turns: stored.turns,
})

const threadResponse = (stored) => ({
  thread: threadShape(stored),
  model: 'gpt-restart-fake',
  modelProvider: 'openai',
  serviceTier: null,
  cwd: stored.cwd,
  instructionSources: [],
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox: { type: 'readOnly' },
  reasoningEffort: 'high',
})

let closing = false
const timers = new Set()

const write = (value) => {
  if (closing || process.stdout.destroyed) return
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const respond = (id, result) => write({ id, result })
const notify = (method, params) => write({ method, params })
const later = (callback) => {
  const timer = setTimeout(() => {
    timers.delete(timer)
    if (!closing) callback()
  }, 30)
  timers.add(timer)
}

const requiredThread = (threadId) => {
  const stored = state.threads[threadId]
  if (!stored) throw new Error(`thread not found: ${threadId}`)
  return stored
}

const recordCall = (method) => {
  state.calls.push({ method, boot: state.boots })
  saveState()
}

saveState()

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch (error) {
    process.stderr.write(`invalid JSONL: ${error instanceof Error ? error.message : String(error)}\n`)
    return
  }

  const { id, method, params = {} } = message
  if (typeof method !== 'string') return
  recordCall(method)

  try {
    switch (method) {
      case 'initialize':
        respond(id, {
          userAgent: 'codex-restart-acceptance',
          codexHome: '/tmp/codex-restart-acceptance',
          platformFamily: 'unix',
          platformOs: process.platform,
        })
        return
      case 'initialized':
        return
      case 'account/read':
        respond(id, {
          account: {
            type: 'chatgpt',
            email: 'restart-acceptance@example.invalid',
            planType: 'test',
          },
          requiresOpenaiAuth: true,
        })
        return
      case 'account/rateLimits/read':
        respond(id, {
          rateLimits: null,
          rateLimitsByLimitId: null,
          rateLimitResetCredits: null,
        })
        return
      case 'account/usage/read':
        respond(id, { summary: {}, dailyUsageBuckets: null })
        return
      case 'model/list':
        respond(id, {
          data: [{
            id: 'gpt-restart-fake',
            model: 'gpt-restart-fake',
            displayName: 'GPT Restart Fake',
            description: 'Deterministic restart acceptance model',
            hidden: false,
            supportedReasoningEfforts: [{
              reasoningEffort: 'high',
              description: 'High',
            }],
            defaultReasoningEffort: 'high',
            inputModalities: ['text'],
            supportsPersonality: false,
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
          }],
          nextCursor: null,
        })
        return
      case 'thread/start': {
        const threadId = `restart-thread-${state.nextThread++}`
        const stored = {
          id: threadId,
          cwd: params.cwd,
          turns: [],
          phaseOneEmitted: false,
          phaseTwoEmitted: false,
        }
        state.threads[threadId] = stored
        saveState()
        respond(id, threadResponse(stored))
        return
      }
      case 'thread/resume': {
        const stored = requiredThread(params.threadId)
        respond(id, threadResponse(stored))
        return
      }
      case 'thread/read': {
        const stored = requiredThread(params.threadId)
        respond(id, { thread: threadShape(stored) })
        return
      }
      case 'turn/start': {
        const stored = requiredThread(params.threadId)
        const turn = {
          id: `restart-turn-${state.nextTurn++}`,
          items: [],
          status: 'inProgress',
          error: null,
        }
        stored.turns.push(turn)
        saveState()
        respond(id, { turn })
        if (!stored.phaseOneEmitted) {
          stored.phaseOneEmitted = true
          saveState()
          later(() => {
            notify('turn/started', {
              threadId: stored.id,
              turn,
              eventId: 'restart-turn-started',
            })
            notify('item/agentMessage/delta', {
              threadId: stored.id,
              turnId: turn.id,
              itemId: 'restart-message-before',
              delta: 'persisted before daemon restart',
              eventId: 'restart-output-before',
            })
          })
        }
        return
      }
      case 'turn/steer': {
        const stored = requiredThread(params.threadId)
        const turn = stored.turns.find((candidate) => candidate.id === params.expectedTurnId)
        if (!turn) throw new Error(`turn not found: ${params.expectedTurnId}`)
        respond(id, { turnId: turn.id })
        if (!stored.phaseTwoEmitted) {
          stored.phaseTwoEmitted = true
          turn.status = 'completed'
          saveState()
          later(() => {
            notify('item/agentMessage/delta', {
              threadId: stored.id,
              turnId: turn.id,
              itemId: 'restart-message-after',
              delta: 'continued after daemon restart',
              eventId: 'restart-output-after',
            })
            notify('turn/completed', {
              threadId: stored.id,
              turn: { ...turn, status: 'completed' },
              eventId: 'restart-turn-completed',
            })
          })
        }
        return
      }
      case 'turn/interrupt':
        respond(id, {})
        return
      case 'thread/unsubscribe':
        respond(id, { status: 'unsubscribed' })
        return
      default:
        respond(id, {})
    }
  } catch (error) {
    write({
      id,
      error: {
        code: -32602,
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }
})

const close = () => {
  if (closing) return
  closing = true
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  input.close()
  process.exitCode = 0
}

input.on('close', close)
process.once('SIGTERM', close)
process.once('SIGINT', close)
process.stdout.on('error', close)
