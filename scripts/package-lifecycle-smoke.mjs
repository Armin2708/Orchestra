#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageName = 'orchestra-board'
const sha256Pattern = /^[0-9a-f]{64}$/

const invariant = (condition, message) => {
  if (!condition) throw new Error(message)
}

const run = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || result.stdout?.trim() ||
      `${basename(executable)} ${args.join(' ')} failed`,
    )
  }
  return result
}

const artifactIdentity = (artifactPath) => {
  const resolved = resolve(artifactPath)
  const stat = lstatSync(resolved)
  invariant(stat.isFile() && !stat.isSymbolicLink(), 'package artifact must be one regular file')
  invariant(stat.size > 0 && resolved.endsWith('.tgz'), 'package artifact must be a non-empty .tgz')
  return {
    path: resolved,
    filename: basename(resolved),
    bytes: stat.size,
    sha256: createHash('sha256').update(readFileSync(resolved)).digest('hex'),
  }
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const assertPreservedConfiguration = (profileDirectory, codexDirectory, expectHooks) => {
  const claude = readJson(join(profileDirectory, '.claude', 'settings.json'))
  const codex = readJson(join(codexDirectory, 'hooks.json'))
  invariant(claude.keep === 'claude-user-setting', 'Claude user configuration was not preserved')
  invariant(codex.keep === 'codex-user-setting', 'Codex user configuration was not preserved')
  const encoded = JSON.stringify({ claude, codex })
  invariant(
    encoded.includes('orchestra hook') === expectHooks,
    expectHooks ? 'provider hooks were not installed' : 'provider hooks were not removed',
  )
}

const installArtifact = (consumerDirectory, artifactPath) => run(
  'npm',
  [
    'install',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    artifactPath,
  ],
  { cwd: consumerDirectory },
)

const artifactPackageManifest = (artifactPath) => {
  const extracted = run('tar', ['-xOf', artifactPath, 'package/package.json'])
  const manifest = JSON.parse(extracted.stdout)
  invariant(manifest.name === packageName, 'package artifact has an unexpected package name')
  invariant(manifest.bin?.orchestra === './dist/cli.js' || manifest.bin?.orchestra === './cli.js', 'package artifact has no orchestra executable')
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    invariant(!manifest.scripts?.[lifecycle], `package artifact defines forbidden ${lifecycle} script`)
  }
  return manifest
}

const availablePort = () => {
  const probe = run(process.execPath, [
    '-e',
    "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
  ])
  const selected = Number(probe.stdout.trim())
  invariant(Number.isInteger(selected) && selected > 0, 'could not reserve a runtime smoke port')
  return selected
}

const waitForHttp = (url, expectedPattern, exited) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (exited()) throw new Error(`installed runtime exited before serving ${url}`)
    const response = spawnSync(
      'curl',
      ['--fail', '--silent', '--show-error', '--max-time', '1', url],
      { encoding: 'utf8' },
    )
    if (response.status === 0 && expectedPattern.test(response.stdout)) return response.stdout
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  throw new Error(`installed runtime did not serve ${url}`)
}

const exerciseInstalledRuntime = (executable, projectDirectory, environment) => {
  const doctor = run(executable, ['doctor', '--contract'], {
    cwd: projectDirectory,
    env: environment,
  })
  let doctorContract
  try {
    doctorContract = JSON.parse(doctor.stdout)
  } catch {
    throw new Error('installed doctor did not return the environment contract as JSON')
  }
  invariant(
    doctorContract?.schema_version === 1 && Array.isArray(doctorContract?.validated_toolchains),
    'installed doctor returned an invalid environment contract',
  )

  const port = availablePort()
  const runtimeEnvironment = { ...environment, ORCHESTRA_PORT: String(port) }
  const daemon = spawn(executable, ['serve'], {
    cwd: projectDirectory,
    env: runtimeEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let daemonError = ''
  let daemonOutput = ''
  daemon.stderr.on('data', (chunk) => { daemonError += String(chunk) })
  daemon.stdout.on('data', (chunk) => { daemonOutput += String(chunk) })
  try {
    const exited = () => daemon.exitCode !== null || daemon.signalCode !== null
    const health = waitForHttp(
      `http://127.0.0.1:${port}/health`,
      /"ok"\s*:\s*true/,
      exited,
    )
    const web = waitForHttp(
      `http://127.0.0.1:${port}/`,
      /<html|<!doctype html/i,
      exited,
    )
    return {
      doctor_contract: true,
      daemon_health: JSON.parse(health).ok === true,
      web_index_served: /<html|<!doctype html/i.test(web),
    }
  } catch (error) {
    const diagnostics = [daemonError.trim(), daemonOutput.trim()].filter(Boolean).join(' | ')
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}` +
      `${diagnostics ? `: ${diagnostics}` : ''}` +
      ` (exit=${daemon.exitCode ?? 'running'}, signal=${daemon.signalCode ?? 'none'})`,
    )
  } finally {
    daemon.kill('SIGTERM')
  }
}

export function runPackageLifecycle({
  artifactPath,
  previousArtifactPath,
  reportPath,
  keepTemporary = false,
  runAudit = true,
} = {}) {
  const artifact = artifactIdentity(artifactPath)
  artifactPackageManifest(artifact.path)
  const previous = previousArtifactPath
    ? artifactIdentity(previousArtifactPath)
    : artifact
  artifactPackageManifest(previous.path)
  const root = mkdtempSync(join(tmpdir(), 'orchestra-package-lifecycle-'))
  const consumerDirectory = join(root, 'consumer')
  const profileDirectory = join(root, 'profile')
  const codexDirectory = join(root, 'codex-profile')
  const stateDirectory = join(root, 'orchestra-state')
  const projectDirectory = join(root, 'project')
  const stateMarkerPath = join(stateDirectory, 'data-preservation-marker.json')
  const projectMarkerPath = join(projectDirectory, 'user-project-marker.txt')
  const marker = {
    schema_version: 1,
    owner: 'clean-consumer-fixture',
    contents: 'must survive package upgrade and uninstall',
  }

  mkdirSync(consumerDirectory, { recursive: true })
  mkdirSync(join(profileDirectory, '.claude'), { recursive: true })
  mkdirSync(codexDirectory, { recursive: true })
  mkdirSync(stateDirectory, { recursive: true })
  mkdirSync(projectDirectory, { recursive: true })
  writeFileSync(
    join(consumerDirectory, 'package.json'),
    '{"name":"orchestra-clean-consumer","version":"1.0.0","private":true}\n',
  )
  writeFileSync(
    join(profileDirectory, '.claude', 'settings.json'),
    '{"keep":"claude-user-setting","hooks":{}}\n',
  )
  writeFileSync(
    join(codexDirectory, 'hooks.json'),
    '{"keep":"codex-user-setting","hooks":{}}\n',
  )
  writeFileSync(stateMarkerPath, `${JSON.stringify(marker, null, 2)}\n`)
  writeFileSync(projectMarkerPath, 'preserve this project file\n')

  const isolatedEnvironment = {
    ...process.env,
    HOME: profileDirectory,
    USERPROFILE: profileDirectory,
    CODEX_HOME: codexDirectory,
    ORCHESTRA_HOME: stateDirectory,
  }

  try {
    installArtifact(consumerDirectory, previous.path)
    const executable = join(consumerDirectory, 'node_modules', '.bin', 'orchestra')
    invariant(existsSync(executable), 'clean install did not expose the orchestra executable')
    const installedVersion = run(executable, ['--version'], {
      cwd: projectDirectory,
      env: isolatedEnvironment,
    }).stdout.trim()
    const runtime = exerciseInstalledRuntime(executable, projectDirectory, isolatedEnvironment)
    run(executable, ['install', '--provider', 'both'], {
      cwd: projectDirectory,
      env: isolatedEnvironment,
    })
    assertPreservedConfiguration(profileDirectory, codexDirectory, true)

    installArtifact(consumerDirectory, artifact.path)
    const upgradedVersion = run(executable, ['--version'], {
      cwd: projectDirectory,
      env: isolatedEnvironment,
    }).stdout.trim()
    invariant(
      JSON.stringify(readJson(stateMarkerPath)) === JSON.stringify(marker),
      'state data changed during package upgrade',
    )

    let audit = { executed: false, high: 0, critical: 0, passed: false }
    if (runAudit) {
      const auditRun = spawnSync(
        'npm',
        ['audit', '--omit=dev', '--audit-level=high', '--json'],
        {
          cwd: consumerDirectory,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        },
      )
      let auditReport
      try {
        auditReport = JSON.parse(auditRun.stdout)
      } catch {
        throw new Error(auditRun.stderr.trim() || 'package artifact audit did not return JSON')
      }
      const vulnerabilities = auditReport.metadata?.vulnerabilities ?? {}
      audit = {
        executed: true,
        high: Number(vulnerabilities.high ?? 0),
        critical: Number(vulnerabilities.critical ?? 0),
        passed: auditRun.status === 0,
      }
      invariant(
        audit.high === 0 && audit.critical === 0 && auditRun.status === 0,
        `package artifact audit found ${audit.high} high and ${audit.critical} critical vulnerabilities`,
      )
    }

    run(executable, ['uninstall', '--provider', 'both'], {
      cwd: projectDirectory,
      env: isolatedEnvironment,
    })
    assertPreservedConfiguration(profileDirectory, codexDirectory, false)
    run(
      'npm',
      ['uninstall', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', packageName],
      { cwd: consumerDirectory },
    )

    invariant(!existsSync(executable), 'npm uninstall left the orchestra executable installed')
    invariant(
      !existsSync(join(consumerDirectory, 'node_modules', packageName)),
      'npm uninstall left the package installed',
    )
    invariant(
      JSON.stringify(readJson(stateMarkerPath)) === JSON.stringify(marker),
      'state data was deleted or changed during uninstall',
    )
    invariant(
      readFileSync(projectMarkerPath, 'utf8') === 'preserve this project file\n',
      'project data was deleted or changed during uninstall',
    )

    const report = {
      schema_version: 1,
      package_name: packageName,
      artifact: {
        filename: artifact.filename,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      },
      previous_artifact: {
        filename: previous.filename,
        sha256: previous.sha256,
        mode: previous.path === artifact.path ? 'same-artifact-reinstall' : 'prior-artifact-upgrade',
      },
      installed_version: installedVersion,
      upgraded_version: upgradedVersion,
      package_install_scripts_absent: true,
      dependency_install_scripts_allowed: true,
      provider_hooks_reversible: true,
      state_preserved_after_upgrade: true,
      state_preserved_after_uninstall: true,
      project_preserved_after_uninstall: true,
      runtime,
      package_removed: true,
      audit,
      passed: true,
    }
    invariant(sha256Pattern.test(report.artifact.sha256), 'artifact digest is invalid')
    if (reportPath) {
      writeFileSync(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    }
    return report
  } finally {
    if (!keepTemporary) rmSync(root, { recursive: true, force: true })
  }
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  try {
    invariant(
      process.argv.length === 3 || process.argv.length === 4,
      'usage: package-lifecycle-smoke.mjs <package.tgz> [previous-package.tgz]',
    )
    const report = runPackageLifecycle({
      artifactPath: process.argv[2],
      previousArtifactPath: process.argv[3],
      reportPath: process.env.ORCHESTRA_PACKAGE_LIFECYCLE_REPORT,
      keepTemporary: process.env.ORCHESTRA_KEEP_LIFECYCLE_TEMP === '1',
    })
    console.log(
      `package lifecycle passed for ${report.artifact.filename} ` +
      `(${report.artifact.sha256})`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
