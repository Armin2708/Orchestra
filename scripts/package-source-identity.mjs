import { spawnSync } from 'node:child_process'

const commitPattern = /^[0-9a-f]{40}$/
const generatedPackagePath = (path) =>
  path.startsWith('dist/') || path.startsWith('web/dist/')

const git = (cwd, args) => spawnSync('git', args, {
  cwd,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
})

const gitOutput = (cwd, args, label) => {
  const result = git(cwd, args)
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${label} failed`)
  }
  return result.stdout
}

export function verifyPackageSourceIdentity({ cwd, expectedSha, packedPaths = undefined }) {
  const expectedCommit = String(expectedSha ?? '').trim().toLowerCase()
  if (!commitPattern.test(expectedCommit)) {
    throw new Error('package source commit must be one full lowercase Git SHA')
  }

  const observedCommit = gitOutput(cwd, ['rev-parse', '--verify', 'HEAD'], 'Git HEAD lookup')
    .trim()
    .toLowerCase()
  if (observedCommit !== expectedCommit) {
    throw new Error(
      `package source commit mismatch: expected ${expectedCommit}, observed ${observedCommit}`,
    )
  }

  const trackedDiff = git(cwd, ['diff', '--quiet', '--exit-code', 'HEAD', '--'])
  if (trackedDiff.status === 1) {
    throw new Error('package source has tracked changes after the exact commit')
  }
  if (trackedDiff.status !== 0) {
    throw new Error(
      trackedDiff.stderr.trim() || trackedDiff.stdout.trim() || 'package source cleanliness check failed',
    )
  }

  let packagedNonbuildInputsTracked = null
  if (packedPaths !== undefined) {
    if (!Array.isArray(packedPaths)) throw new Error('package file inventory must be an array')
    const trackedFiles = new Set(
      gitOutput(cwd, ['ls-files', '-z'], 'Git tracked-file inventory')
        .split('\0')
        .filter(Boolean),
    )
    for (const value of packedPaths) {
      const path = String(value ?? '')
      if (
        path === '' || path.startsWith('/') || path.includes('\\') ||
        path.split('/').includes('..')
      ) {
        throw new Error(`package file inventory contains unsafe path ${JSON.stringify(value)}`)
      }
      if (!generatedPackagePath(path) && !trackedFiles.has(path)) {
        throw new Error(`package contains untracked non-build input ${path}`)
      }
    }
    packagedNonbuildInputsTracked = true
  }

  return {
    expected_commit: expectedCommit,
    observed_commit: observedCommit,
    tracked_source_clean: true,
    packaged_nonbuild_inputs_tracked: packagedNonbuildInputsTracked,
  }
}
