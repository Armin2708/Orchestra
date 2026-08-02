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
  PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256,
  PINNED_REQUIREMENTS_SHA256,
  PINNED_TOOL_EVIDENCE_SCHEMA_SHA256,
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
const hasSymlinkComponent = (target) => {
  let current = path.parse(path.resolve(target)).root
  for (const segment of path.resolve(target).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return true
  }
  return false
}
const atomicWriteFresh = (file, content) => {
  if (fs.existsSync(file) || fs.lstatSync(path.dirname(file)).isSymbolicLink()) throw new Error(`refusing to overwrite evidence target: ${file}`)
  const temporary = `${file}.tmp-${process.pid}-${createHash('sha256').update(`${file}-${Date.now()}`).digest('hex').slice(0, 12)}`
  fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try { fs.linkSync(temporary, file) } finally { fs.unlinkSync(temporary) }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const outputArgument = argument('--output-dir')
  if (!outputArgument) throw new Error('--output-dir is required and must be outside the repository')
  const output = path.resolve(outputArgument)
  if (process.argv.some((value) => /^--(?:lane-[abcd]|integrator)-(?:gitnexus|graphify)-report$/u.test(value))) {
    throw new Error('current runner cannot close QA-018; raw integrator-signed tool receipts require a reviewed verifier upgrade')
  }
  if (fs.existsSync(output)) throw new Error('evidence output directory must not already exist')
  const outputParent = path.dirname(output)
  if (!fs.existsSync(outputParent) || !fs.lstatSync(outputParent).isDirectory() || hasSymlinkComponent(outputParent)) throw new Error('evidence output parent must be a real, existing, non-symlink directory')
  const repository = fs.realpathSync(DEFAULT_ROOT)
  const proposedOutput = path.join(fs.realpathSync(outputParent), path.basename(output))
  const relativeOutput = path.relative(repository, proposedOutput)
  if (!relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('evidence output must be outside the repository')
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: DEFAULT_ROOT, encoding: 'utf8' }).trim()) throw new Error('refusing to test a dirty tracked worktree')
  fs.mkdirSync(output, { recursive: false, mode: 0o700 })
  if (hasSymlinkComponent(output) || fs.realpathSync(output) !== proposedOutput) throw new Error('evidence output directory realpath changed during creation')
  const testedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DEFAULT_ROOT, encoding: 'utf8' }).trim()
  const requirements = readJson(DEFAULT_REQUIREMENTS)
  const matrix = readJson(DEFAULT_MATRIX)
  const commands = []
  const passedCommandIds = new Set()

  for (const [id, argv] of Object.entries(requirements.commands)) {
    if (argv[0] !== 'node_modules/.bin/vitest') throw new Error(`command ${id} does not use the pinned local Vitest executable`)
    const executable = path.resolve(DEFAULT_ROOT, argv[0])
    if (!fs.existsSync(executable)) throw new Error(`missing pinned local Vitest executable for ${id}`)
    const execution = spawnSync(executable, argv.slice(1), {
      cwd: DEFAULT_ROOT,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    })
    const logPath = path.join(output, `${id}.json`)
    atomicWriteFresh(logPath, execution.stdout ?? '')
    let result = null
    try { result = JSON.parse(execution.stdout ?? '') } catch {}
    const statuses = Array.isArray(result?.testResults) ? result.testResults.flatMap((suite) =>
      Array.isArray(suite?.assertionResults) ? suite.assertionResults.map((assertion) => assertion?.status) : []) : []
    const record = {
      id,
      argv,
      exit_code: execution.status ?? 1,
      log_path: relativeInside(output, logPath),
      log_sha256: sha256(fs.readFileSync(logPath)),
      test_files: Number(result?.numTotalTestSuites ?? 0),
      tests: Number(result?.numTotalTests ?? 0),
      passed: Number(result?.numPassedTests ?? 0),
      failed: Number(result?.numFailedTests ?? 1),
      pending: Number(result?.numPendingTests ?? 1),
      skipped: statuses.filter((status) => status === 'skipped').length,
      todo: Number(result?.numTodoTests ?? 1),
    }
    commands.push(record)
    if (record.exit_code === 0 && record.failed === 0 && record.pending === 0 && record.skipped === 0
      && record.todo === 0 && record.passed === record.tests && record.tests > 0 && result?.success === true) passedCommandIds.add(id)
  }

  const artifacts = requirements.artifact_paths.map((artifactPath) => ({
    path: artifactPath,
    sha256: sha256(execFileSync('git', ['show', `${testedCommit}:${artifactPath}`], {
      cwd: DEFAULT_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    })),
  }))
  const caseResults = matrix.requirements.filter((entry) => entry.command_ids.every((id) =>
    id !== 'qa018-tool-reports' && passedCommandIds.has(id)),
  ).map((entry) => ({ item: entry.item, case: entry.case, command_ids: entry.command_ids, status: 'passed' }))

  const report = {
    schema_version: 1,
    tested_commit: testedCommit,
    requirements_sha256: PINNED_REQUIREMENTS_SHA256,
    schema_sha256: PINNED_EVIDENCE_SCHEMA_SHA256,
    tool_schema_sha256: PINNED_TOOL_EVIDENCE_SCHEMA_SHA256,
    integration_schema_sha256: PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256,
    qa018_closure_supported: false,
    integration_manifest: null,
    artifacts,
    commands,
    case_results: caseResults,
    tool_reports: {},
  }
  const reportPath = path.join(output, 'beta-quality-evidence.json')
  atomicWriteFresh(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${reportPath}\n`)
  if (commands.some((command) => command.exit_code !== 0 || command.failed !== 0 || command.pending !== 0
    || command.skipped !== 0 || command.todo !== 0 || command.passed !== command.tests)) process.exitCode = 1
}
