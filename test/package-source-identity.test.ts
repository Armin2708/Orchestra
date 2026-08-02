import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyPackageSourceIdentity } from '../scripts/package-source-identity.mjs'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const repository = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-package-source-'))
  temporaryDirectories.push(directory)
  execFileSync('git', ['init', '-q'], { cwd: directory })
  execFileSync('git', ['config', 'user.name', 'Package Test'], { cwd: directory })
  execFileSync('git', ['config', 'user.email', 'package@example.invalid'], { cwd: directory })
  fs.mkdirSync(path.join(directory, 'docs'))
  fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"fixture"}\n')
  fs.writeFileSync(path.join(directory, 'docs', 'guide.md'), '# Guide\n')
  execFileSync('git', ['add', '.'], { cwd: directory })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: directory })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim()
  return { directory, sha }
}

describe('package source identity', () => {
  it('binds the packed inventory to one clean exact commit', () => {
    const sample = repository()
    expect(verifyPackageSourceIdentity({
      cwd: sample.directory,
      expectedSha: sample.sha,
      packedPaths: ['package.json', 'docs/guide.md', 'dist/cli.js', 'web/dist/index.html'],
    })).toEqual({
      expected_commit: sample.sha,
      observed_commit: sample.sha,
      tracked_source_clean: true,
      packaged_nonbuild_inputs_tracked: true,
    })
  })

  it('rejects a claimed commit that is not the packaging checkout', () => {
    const sample = repository()
    expect(() => verifyPackageSourceIdentity({
      cwd: sample.directory,
      expectedSha: 'a'.repeat(40),
    })).toThrow('package source commit mismatch')
  })

  it('rejects staged or unstaged tracked source changes', () => {
    const sample = repository()
    fs.appendFileSync(path.join(sample.directory, 'package.json'), 'dirty\n')
    expect(() => verifyPackageSourceIdentity({
      cwd: sample.directory,
      expectedSha: sample.sha,
    })).toThrow('package source has tracked changes')

    execFileSync('git', ['add', 'package.json'], { cwd: sample.directory })
    expect(() => verifyPackageSourceIdentity({
      cwd: sample.directory,
      expectedSha: sample.sha,
    })).toThrow('package source has tracked changes')
  })

  it('rejects untracked non-build inputs from the npm inventory', () => {
    const sample = repository()
    fs.writeFileSync(path.join(sample.directory, 'docs', 'untracked.md'), '# Untracked\n')
    expect(() => verifyPackageSourceIdentity({
      cwd: sample.directory,
      expectedSha: sample.sha,
      packedPaths: ['package.json', 'docs/untracked.md'],
    })).toThrow('package contains untracked non-build input docs/untracked.md')
  })
})
