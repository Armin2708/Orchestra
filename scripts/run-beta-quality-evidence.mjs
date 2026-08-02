#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MATRIX,
  DEFAULT_REQUIREMENTS,
  DEFAULT_ROOT,
  PINNED_EVIDENCE_SCHEMA_SHA256,
  PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256,
  PINNED_REQUIREMENTS_SHA256,
  PINNED_SIGNATURE_RECEIPT_SCHEMA_SHA256,
  PINNED_TOOL_EVIDENCE_SCHEMA_SHA256,
  verifyQa018EvidenceBundle,
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
const resolveRegularInside = (directory, relative, label) => {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)) throw new Error(`${label} path is invalid`)
  const base = fs.realpathSync(directory)
  const candidate = path.resolve(base, relative)
  const relation = path.relative(base, candidate)
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)
    || hasSymlinkComponent(candidate) || !fs.existsSync(candidate)) throw new Error(`${label} is outside the staging directory, missing, or symlinked`)
  const stat = fs.lstatSync(candidate)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024 * 1024) throw new Error(`${label} must be one bounded regular file`)
  return candidate
}
const atomicWriteFresh = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (fs.existsSync(file) || fs.lstatSync(path.dirname(file)).isSymbolicLink()) throw new Error(`refusing to overwrite evidence target: ${file}`)
  const temporary = `${file}.tmp-${process.pid}-${createHash('sha256').update(`${file}-${Date.now()}`).digest('hex').slice(0, 12)}`
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
  try { fs.linkSync(temporary, file) } finally { fs.unlinkSync(temporary) }
}
const importFreshArtifact = ({ stagingDirectory, output, relative, copied }) => {
  const source = resolveRegularInside(stagingDirectory, relative, `QA-018 artifact ${relative}`)
  const destination = path.resolve(output, relative)
  const outputRelation = path.relative(output, destination)
  if (!outputRelation || outputRelation.startsWith('..') || path.isAbsolute(outputRelation)) throw new Error(`QA-018 destination path is invalid: ${relative}`)
  if (copied.has(relative)) throw new Error(`QA-018 signed inventory contains a duplicate path: ${relative}`)
  copied.add(relative)
  atomicWriteFresh(destination, fs.readFileSync(source))
}

export const importQa018Bundle = ({ manifestArgument, receiptArgument, output }) => {
  if (!manifestArgument && !receiptArgument) return { manifestReference: null, receiptReference: null }
  if (!manifestArgument || !receiptArgument) throw new Error('--qa018-manifest and --qa018-receipt must be supplied together')
  const manifestSource = path.resolve(manifestArgument)
  const receiptSource = path.resolve(receiptArgument)
  if (!fs.existsSync(manifestSource) || !fs.existsSync(receiptSource)
    || hasSymlinkComponent(manifestSource) || hasSymlinkComponent(receiptSource)
    || !fs.lstatSync(manifestSource).isFile() || !fs.lstatSync(receiptSource).isFile()) throw new Error('QA-018 manifest and receipt must be regular, non-symlink files')
  const stagingDirectory = fs.realpathSync(path.dirname(manifestSource))
  if (fs.realpathSync(path.dirname(receiptSource)) !== stagingDirectory) throw new Error('QA-018 manifest and receipt must share one staging directory')
  const manifestBytes = fs.readFileSync(manifestSource)
  const receiptBytes = fs.readFileSync(receiptSource)
  if (manifestBytes.length < 1 || manifestBytes.length > 4 * 1024 * 1024
    || receiptBytes.length < 1 || receiptBytes.length > 4 * 1024 * 1024) throw new Error('QA-018 manifest or receipt has an invalid size')
  let manifest
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) } catch { throw new Error('QA-018 manifest is not valid JSON') }
  if (!Array.isArray(manifest?.slices)) throw new Error('QA-018 manifest does not contain a slice inventory')

  const manifestPath = path.join(output, 'qa018-integration-manifest.json')
  const receiptPath = path.join(output, 'qa018-signature-receipt.json')
  atomicWriteFresh(manifestPath, manifestBytes)
  atomicWriteFresh(receiptPath, receiptBytes)
  const copied = new Set(['qa018-integration-manifest.json', 'qa018-signature-receipt.json'])
  for (const slice of manifest.slices) {
    for (const tool of ['gitnexus', 'graphify']) {
      const wrapper = slice?.tool_reports?.[tool]
      importFreshArtifact({ stagingDirectory, output, relative: wrapper?.path, copied })
      for (const artifact of wrapper?.raw_artifacts ?? []) {
        importFreshArtifact({ stagingDirectory, output, relative: artifact?.path, copied })
      }
    }
  }
  return {
    manifestReference: { path: relativeInside(output, manifestPath), sha256: sha256(manifestBytes) },
    receiptReference: { path: relativeInside(output, receiptPath), sha256: sha256(receiptBytes) },
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const outputArgument = argument('--output-dir')
  if (!outputArgument) throw new Error('--output-dir is required and must be outside the repository')
  if (process.argv.some((value) => /^--(?:lane-[abcd]|integrator)-(?:gitnexus|graphify)-report$/u.test(value))) {
    throw new Error('per-lane QA-018 flags are unsupported; supply one externally signed manifest and detached receipt')
  }
  const output = path.resolve(outputArgument)
  if (fs.existsSync(output)) throw new Error('evidence output directory must not already exist')
  const outputParent = path.dirname(output)
  if (!fs.existsSync(outputParent) || !fs.lstatSync(outputParent).isDirectory()
    || hasSymlinkComponent(outputParent)) throw new Error('evidence output parent must be a real, existing, non-symlink directory')
  const repository = fs.realpathSync(DEFAULT_ROOT)
  const proposedOutput = path.join(fs.realpathSync(outputParent), path.basename(output))
  const relativeOutput = path.relative(repository, proposedOutput)
  if (!relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('evidence output must be outside the repository')
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: DEFAULT_ROOT, encoding: 'utf8' }).trim()) throw new Error('refusing to test a dirty tracked worktree')
  fs.mkdirSync(output, { recursive: false, mode: 0o700 })
  if (hasSymlinkComponent(output) || fs.realpathSync(output) !== proposedOutput) throw new Error('evidence output directory realpath changed during creation')

  const qa018Imports = importQa018Bundle({
    manifestArgument: argument('--qa018-manifest'),
    receiptArgument: argument('--qa018-receipt'),
    output,
  })
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
      cwd: DEFAULT_ROOT, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024,
    })
    const logPath = path.join(output, `${id}.json`)
    atomicWriteFresh(logPath, execution.stdout ?? '')
    let result = null
    try { result = JSON.parse(execution.stdout ?? '') } catch {}
    const statuses = Array.isArray(result?.testResults) ? result.testResults.flatMap((suite) =>
      Array.isArray(suite?.assertionResults) ? suite.assertionResults.map((assertion) => assertion?.status) : []) : []
    const record = {
      id, argv, exit_code: execution.status ?? 1,
      log_path: relativeInside(output, logPath), log_sha256: sha256(fs.readFileSync(logPath)),
      test_files: Number(result?.numTotalTestSuites ?? 0), tests: Number(result?.numTotalTests ?? 0),
      passed: Number(result?.numPassedTests ?? 0), failed: Number(result?.numFailedTests ?? 1),
      pending: Number(result?.numPendingTests ?? 1),
      skipped: statuses.filter((status) => status === 'skipped').length,
      todo: Number(result?.numTodoTests ?? 1),
    }
    commands.push(record)
    if (record.exit_code === 0 && record.failed === 0 && record.pending === 0
      && record.skipped === 0 && record.todo === 0 && record.passed === record.tests
      && record.tests > 0 && result?.success === true) passedCommandIds.add(id)
  }

  const artifacts = requirements.artifact_paths.map((artifactPath) => ({
    path: artifactPath,
    sha256: sha256(execFileSync('git', ['show', `${testedCommit}:${artifactPath}`], {
      cwd: DEFAULT_ROOT, maxBuffer: 32 * 1024 * 1024,
    })),
  }))
  const qa018 = qa018Imports.manifestReference
    ? verifyQa018EvidenceBundle({
      root: DEFAULT_ROOT, evidenceDirectory: output,
      manifestReference: qa018Imports.manifestReference,
      receiptReference: qa018Imports.receiptReference,
    })
    : { ok: false, errors: ['QA-018 integration manifest and signature receipt were not supplied'] }
  const caseResults = matrix.requirements.filter((entry) => entry.command_ids.every((id) =>
    id === 'qa018-tool-reports' ? qa018.ok : passedCommandIds.has(id)),
  ).map((entry) => ({ item: entry.item, case: entry.case, command_ids: entry.command_ids, status: 'passed' }))

  const report = {
    schema_version: 2,
    tested_commit: testedCommit,
    requirements_sha256: PINNED_REQUIREMENTS_SHA256,
    schema_sha256: PINNED_EVIDENCE_SCHEMA_SHA256,
    tool_schema_sha256: PINNED_TOOL_EVIDENCE_SCHEMA_SHA256,
    integration_schema_sha256: PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256,
    signature_schema_sha256: PINNED_SIGNATURE_RECEIPT_SCHEMA_SHA256,
    qa018_closure_supported: qa018.ok,
    integration_manifest: qa018Imports.manifestReference,
    qa018_signature_receipt: qa018Imports.receiptReference,
    artifacts,
    commands,
    case_results: caseResults,
  }
  const reportPath = path.join(output, 'beta-quality-evidence.json')
  atomicWriteFresh(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${reportPath}\n`)
  if (!qa018.ok) process.stderr.write(`QA-018 remains open: ${qa018.errors.join('; ')}\n`)
  if (!qa018.ok || commands.some((command) => command.exit_code !== 0 || command.failed !== 0
    || command.pending !== 0 || command.skipped !== 0 || command.todo !== 0
    || command.passed !== command.tests)) process.exitCode = 1
}
