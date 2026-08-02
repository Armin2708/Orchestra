#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_EVIDENCE_SCHEMA,
  DEFAULT_MATRIX,
  DEFAULT_REQUIREMENTS,
  DEFAULT_ROOT,
  PINNED_EVIDENCE_SCHEMA_SHA256,
  PINNED_REQUIREMENTS_SHA256,
} from './check-beta-quality-matrix.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const argument = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}
const relativeInside = (root, file) => {
  const relative = path.relative(root, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`artifact is outside evidence directory: ${file}`)
  return relative.split(path.sep).join('/')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const outputArgument = argument('--output-dir')
  if (!outputArgument) throw new Error('--output-dir is required and must be outside the repository')
  const output = path.resolve(outputArgument)
  const relativeOutput = path.relative(DEFAULT_ROOT, output)
  if (!relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput)) throw new Error('evidence output must be outside the repository')
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: DEFAULT_ROOT, encoding: 'utf8' }).trim()) throw new Error('refusing to test a dirty tracked worktree')
  fs.mkdirSync(output, { recursive: true })
  const testedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DEFAULT_ROOT, encoding: 'utf8' }).trim()
  const requirements = readJson(DEFAULT_REQUIREMENTS)
  const matrix = readJson(DEFAULT_MATRIX)
  const commands = []
  const passedCommandIds = new Set()

  for (const [id, argv] of Object.entries(requirements.commands)) {
    const execution = spawnSync(argv[0], argv.slice(1), {
      cwd: DEFAULT_ROOT,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    })
    const logPath = path.join(output, `${id}.json`)
    fs.writeFileSync(logPath, execution.stdout ?? '', 'utf8')
    let result = null
    try { result = JSON.parse(execution.stdout ?? '') } catch {}
    const record = {
      id,
      argv,
      exit_code: execution.status ?? 1,
      log_path: relativeInside(output, logPath),
      log_sha256: sha256(fs.readFileSync(logPath)),
      test_files: Number(result?.numTotalTestSuites ?? 0),
      tests: Number(result?.numTotalTests ?? 0),
      failed: Number(result?.numFailedTests ?? 1),
    }
    commands.push(record)
    if (record.exit_code === 0 && record.failed === 0 && result?.success === true) passedCommandIds.add(id)
  }

  const artifacts = requirements.artifact_paths.map((artifactPath) => ({
    path: artifactPath,
    sha256: sha256(execFileSync('git', ['show', `${testedCommit}:${artifactPath}`], {
      cwd: DEFAULT_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    })),
  }))
  const caseResults = matrix.requirements.filter((entry) =>
    entry.command_ids.every((id) => passedCommandIds.has(id)),
  ).map((entry) => ({ item: entry.item, case: entry.case, command_ids: entry.command_ids, status: 'passed' }))

  const toolReports = {}
  for (const tool of ['gitnexus', 'graphify']) {
    const supplied = argument(`--${tool}-report`)
    if (!supplied) continue
    const absolute = path.resolve(supplied)
    const parsed = readJson(absolute)
    if (parsed.tested_commit !== testedCommit) throw new Error(`${tool} report is not bound to exact HEAD`)
    const destination = path.join(output, `${tool}-report.json`)
    fs.copyFileSync(absolute, destination)
    toolReports[tool] = {
      tested_commit: testedCommit,
      path: relativeInside(output, destination),
      sha256: sha256(fs.readFileSync(destination)),
    }
  }

  const report = {
    schema_version: 1,
    tested_commit: testedCommit,
    requirements_sha256: PINNED_REQUIREMENTS_SHA256,
    schema_sha256: PINNED_EVIDENCE_SCHEMA_SHA256,
    artifacts,
    commands,
    case_results: caseResults,
    tool_reports: toolReports,
  }
  const reportPath = path.join(output, 'beta-quality-evidence.json')
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${reportPath}\n`)
  if (commands.some((command) => command.exit_code !== 0 || command.failed !== 0)) process.exitCode = 1
}
