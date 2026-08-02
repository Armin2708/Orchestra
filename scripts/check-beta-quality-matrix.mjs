#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..')
export const DEFAULT_MATRIX = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-matrix.json')

const walkFiles = (root) => {
  if (!fs.existsSync(root)) return []
  const files = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'graphify-out') continue
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(candidate)
      else if (entry.isFile()) files.push(candidate)
    }
  }
  visit(root)
  return files.sort()
}

const readEvidence = (root, descriptor, errors, label) => {
  if (!descriptor || typeof descriptor.path !== 'string') {
    errors.push(`${label}: evidence path is missing`)
    return
  }
  const absolute = path.resolve(root, descriptor.path)
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(absolute)) {
    errors.push(`${label}: missing ${descriptor.path}`)
    return
  }
  const content = fs.readFileSync(absolute, 'utf8')
  for (const anchor of descriptor.anchors ?? []) {
    if (!content.includes(anchor)) errors.push(`${label}: ${descriptor.path} is missing anchor ${JSON.stringify(anchor)}`)
  }
}

export function evaluateBetaQualityMatrix({
  root = DEFAULT_ROOT,
  matrixPath = DEFAULT_MATRIX,
  mode = 'current-base',
} = {}) {
  if (!['current-base', 'release'].includes(mode)) throw new Error(`unknown matrix mode: ${mode}`)
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'))
  const errors = []
  const unresolved = []
  const covered = []
  const itemIds = new Set()
  const caseIds = new Set()
  const searchCache = new Map()

  if (matrix.schema_version !== 1 || !Array.isArray(matrix.items)) {
    return { ok: false, mode, errors: ['matrix schema_version/items are invalid'], unresolved, covered }
  }

  for (const item of matrix.items) {
    if (itemIds.has(item.id)) errors.push(`duplicate item id: ${item.id}`)
    itemIds.add(item.id)
    if (!Array.isArray(item.cases) || item.cases.length === 0) errors.push(`${item.id}: cases are empty`)
    for (const testCase of item.cases ?? []) {
      const key = `${item.id}/${testCase.id}`
      if (caseIds.has(key)) errors.push(`duplicate case id: ${key}`)
      caseIds.add(key)
      if (testCase.status === 'covered') {
        if (testCase.source) readEvidence(root, testCase.source, errors, `${key} source`)
        if (!Array.isArray(testCase.evidence) || testCase.evidence.length === 0) {
          errors.push(`${key}: covered case has no evidence`)
        }
        for (const evidence of testCase.evidence ?? []) readEvidence(root, evidence, errors, `${key} evidence`)
        covered.push(key)
        continue
      }
      if (testCase.status !== 'lane-dependent') {
        errors.push(`${key}: unknown status ${JSON.stringify(testCase.status)}`)
        continue
      }
      if (!testCase.lane || testCase.required_for_beta !== true) {
        errors.push(`${key}: lane-dependent cases must name a lane and be required_for_beta`)
      }
      unresolved.push({ item: item.id, case: testCase.id, lane: testCase.lane })
      for (const guard of testCase.absence_guards ?? []) {
        const cacheKey = path.resolve(root, guard.root)
        const files = searchCache.get(cacheKey) ?? walkFiles(cacheKey)
        searchCache.set(cacheKey, files)
        const expression = new RegExp(guard.pattern, 'u')
        const matches = files.filter((file) => expression.test(fs.readFileSync(file, 'utf8')))
        if (matches.length > 0) {
          errors.push(`${key}: future implementation exists without coverage (${matches
            .map((file) => path.relative(root, file)).join(', ')})`)
        }
      }
    }
  }

  if (mode === 'release') {
    for (const missing of unresolved) {
      errors.push(`${missing.item}/${missing.case}: required beta evidence is still lane-dependent (${missing.lane})`)
    }
  }
  return { ok: errors.length === 0, mode, errors, unresolved, covered }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const modeIndex = process.argv.indexOf('--mode')
  const mode = modeIndex === -1 ? 'release' : process.argv[modeIndex + 1]
  const json = process.argv.includes('--json')
  const result = evaluateBetaQualityMatrix({ mode })
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`Beta quality matrix (${result.mode}): ${result.ok ? 'PASS' : 'FAIL'}\n`)
    process.stdout.write(`Covered: ${result.covered.length}; unresolved: ${result.unresolved.length}; errors: ${result.errors.length}\n`)
    for (const missing of result.unresolved) {
      process.stdout.write(`- ${missing.item}/${missing.case} [Lane ${missing.lane}]\n`)
    }
    for (const error of result.errors) process.stderr.write(`ERROR: ${error}\n`)
  }
  process.exitCode = result.ok ? 0 : 1
}
