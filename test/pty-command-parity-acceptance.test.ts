import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeSupervisor } from '../src/runtime/supervisor.js'

const roots: string[] = []
const supervisors: RuntimeSupervisor[] = []

afterEach(async () => {
  await Promise.allSettled(supervisors.splice(0).map((runtime) => runtime.shutdown(100)))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('PTY-GATE deterministic command parity', () => {
  it.skipIf(process.platform === 'win32')(
    'completes a real coding task through one raw shell with git, node, npm, resize, and reconnect',
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'pty-command-parity-'))
      roots.push(root)
      writeFileSync(path.join(root, 'package.json'), '{"name":"pty-gate","private":true,"type":"module"}\n')
      execFileSync('git', ['init', '--initial-branch=main'], { cwd: root })
      execFileSync('git', ['add', 'package.json'], { cwd: root })
      execFileSync('git', [
        '-c', 'user.name=PTY Gate', '-c', 'user.email=pty@example.invalid',
        'commit', '-m', 'initial',
      ], { cwd: root })

      const runtime = new RuntimeSupervisor()
      supervisors.push(runtime)
      const processRecord = await runtime.spawn({
        workspaceId: 'pty-gate-workspace',
        command: process.env.SHELL || '/bin/sh',
        args: ['-f'],
        shell: false,
        cwd: root,
        cols: 100,
        rows: 30,
      })
      await runtime.resize(processRecord.id, 132, 41)
      const marker = 'PTY_GATE_COMPLETE'
      await runtime.write(processRecord.id, [
        `printf '%s\\n' 'export const answer = 6 * 7' 'console.log(answer)' > answer.mjs`,
        `node answer.mjs`,
        `npm --version`,
        `git diff --no-ext-diff -- answer.mjs`,
        `printf '${marker}\\n'`,
        'exit',
        '',
      ].join('\n'))

      let output = ''
      let cursor = 0
      const deadline = Date.now() + 20_000
      let terminal = false
      while (Date.now() < deadline && !terminal) {
        const page = await runtime.readOutput(processRecord.id, cursor, 10_000)
        output += page.chunks.map((chunk) => chunk.data).join('')
        cursor = page.nextSeq
        const current = await runtime.get(processRecord.id)
        terminal = current !== undefined && ['stopped', 'exited', 'failed', 'lost'].includes(current.status)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await runtime.flush(processRecord.id)
      const finalPage = await runtime.readOutput(processRecord.id, cursor, 10_000)
      output += finalPage.chunks.map((chunk) => chunk.data).join('')
      expect(output).toContain('42')
      expect(output).toContain(marker)
      expect(output).not.toContain('command not found')

      const ended = await runtime.get(processRecord.id)
      expect(ended).toMatchObject({ cols: 132, rows: 41 })
      const reconnected = await runtime.readOutput(processRecord.id, 0, 10_000)
      expect(reconnected.chunks.map((chunk) => chunk.data).join('')).toContain(marker)
      expect(execFileSync('node', ['answer.mjs'], { cwd: root, encoding: 'utf8' }).trim()).toBe('42')
      expect(execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }))
        .toContain('?? answer.mjs')
    },
    30_000,
  )
})
