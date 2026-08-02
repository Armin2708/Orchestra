#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const invariant = (condition, message) => {
  if (!condition) throw new Error(message)
}
const hasSymlinkComponent = (target) => {
  let current = path.parse(path.resolve(target)).root
  for (const segment of path.resolve(target).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return true
  }
  return false
}
const argument = (argv, name) => {
  const index = argv.indexOf(name)
  return index === -1 ? null : argv[index + 1]
}
const regularInside = (root, candidate, label) => {
  invariant(typeof candidate === 'string' && candidate.length > 0 && !path.isAbsolute(candidate), `${label} path must be repository-relative`)
  const absolute = path.resolve(root, candidate)
  const relation = path.relative(root, absolute)
  invariant(relation && !relation.startsWith('..') && !path.isAbsolute(relation), `${label} path is outside the repository`)
  invariant(fs.existsSync(absolute) && !hasSymlinkComponent(absolute), `${label} is missing or symlinked`)
  const stat = fs.lstatSync(absolute)
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 64 * 1024 * 1024, `${label} must be one bounded regular file`)
  return { path: relation.split(path.sep).join('/'), bytes: fs.readFileSync(absolute) }
}

export function captureGraphifyStatus({ root, graphPath, manifestPath, testedCommit } = {}) {
  const repository = fs.realpathSync(root ?? process.cwd())
  invariant(COMMIT_PATTERN.test(String(testedCommit ?? '')), 'tested Graphify commit is invalid')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  invariant(head === testedCommit, 'tested Graphify commit is not exact HEAD')
  const graphFile = regularInside(repository, graphPath, 'Graphify graph')
  const manifestFile = regularInside(repository, manifestPath, 'Graphify manifest')
  let graph
  let manifest
  try { graph = JSON.parse(graphFile.bytes.toString('utf8')) } catch { throw new Error('Graphify graph is not valid JSON') }
  try { manifest = JSON.parse(manifestFile.bytes.toString('utf8')) } catch { throw new Error('Graphify manifest is not valid JSON') }
  invariant(graph?.built_at_commit === testedCommit, 'Graphify graph is not bound to exact HEAD')
  invariant(Array.isArray(graph?.nodes) && Array.isArray(graph?.links), 'Graphify graph is structurally incomplete')
  invariant(manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    && Object.keys(manifest).length > 0, 'Graphify manifest is empty')
  return {
    schema_version: 1,
    operation: 'status',
    tested_commit: testedCommit,
    graph_path: graphFile.path,
    graph_sha256: sha256(graphFile.bytes),
    manifest_path: manifestFile.path,
    manifest_sha256: sha256(manifestFile.bytes),
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const expectedFlags = ['--graph', '--manifest', '--tested-commit']
  const suppliedFlags = process.argv.slice(2).filter((value) => value.startsWith('--'))
  invariant(JSON.stringify(suppliedFlags) === JSON.stringify(expectedFlags), 'expected exactly --graph, --manifest, and --tested-commit in order')
  const result = captureGraphifyStatus({
    root: process.cwd(),
    graphPath: argument(process.argv, '--graph'),
    manifestPath: argument(process.argv, '--manifest'),
    testedCommit: argument(process.argv, '--tested-commit'),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
