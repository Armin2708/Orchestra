#!/usr/bin/env node
import {
  prepareCodexAcceptanceV1,
  preparedCodexFingerprintV1,
  preparedCodexLoginCommandV1,
  runCodexAcceptanceV1,
} from './codex/provider-acceptance.js'

type ParsedArguments = {
  command: 'prepare' | 'run'
  values: Map<string, string>
}

const usage = (): never => {
  throw new Error([
    'usage:',
    '  tsx src/provider-acceptance-cli.ts prepare --run-root <absolute-path> [--npm-command <path>]',
    '  tsx src/provider-acceptance-cli.ts run --run-root <absolute-path>',
    '    [--repository-root <path>] [--incompatible-codex-command <path>]',
    '    [--database-path <path>] [--turn-timeout-ms <milliseconds>]',
    '    [--approval-timeout-ms <milliseconds>]',
  ].join('\n'))
}

const parse = (argv: readonly string[]): ParsedArguments => {
  const [rawCommand, ...rest] = argv
  if (rawCommand !== 'prepare' && rawCommand !== 'run') usage()
  const values = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]
    const value = rest[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      usage()
    }
    if (values.has(name)) throw new Error(`duplicate option: ${name}`)
    values.set(name, value)
  }
  const allowed = rawCommand === 'prepare'
    ? new Set(['--run-root', '--npm-command'])
    : new Set([
        '--run-root',
        '--repository-root',
        '--incompatible-codex-command',
        '--database-path',
        '--turn-timeout-ms',
        '--approval-timeout-ms',
      ])
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown option: ${name}`)
  }
  if (!values.get('--run-root')) usage()
  return { command: rawCommand as ParsedArguments['command'], values }
}

const optionalPositiveInteger = (
  value: string | undefined,
  name: string,
): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

const parsed = parse(process.argv.slice(2))

if (parsed.command === 'prepare') {
  const prepared = prepareCodexAcceptanceV1({
    run_root: parsed.values.get('--run-root') as string,
    ...(parsed.values.get('--npm-command')
      ? { npm_command: parsed.values.get('--npm-command') }
      : {}),
  })
  process.stdout.write(`${JSON.stringify({
    state: 'prepared',
    package_spec: prepared.package_spec,
    package_integrity: prepared.package_integrity,
    cli_version: prepared.cli_version,
    platform: prepared.platform,
    run_root: prepared.run_root,
    profile_root: prepared.profile_root,
    codex_command: prepared.codex_command,
    wrapper_sha256: prepared.wrapper_sha256,
    native_sha256: prepared.native_sha256,
    preparation_fingerprint: preparedCodexFingerprintV1(prepared),
    next_command: preparedCodexLoginCommandV1(prepared),
  }, null, 2)}\n`)
} else {
  const result = await runCodexAcceptanceV1({
    run_root: parsed.values.get('--run-root') as string,
    repository_root: parsed.values.get('--repository-root') ?? process.cwd(),
    ...(parsed.values.get('--incompatible-codex-command')
      ? {
          incompatible_codex_command: parsed.values.get(
            '--incompatible-codex-command',
          ),
        }
      : {}),
    ...(parsed.values.get('--database-path')
      ? { database_path: parsed.values.get('--database-path') }
      : {}),
    ...(parsed.values.get('--turn-timeout-ms')
      ? {
          turn_timeout_ms: optionalPositiveInteger(
            parsed.values.get('--turn-timeout-ms'),
            '--turn-timeout-ms',
          ),
        }
      : {}),
    ...(parsed.values.get('--approval-timeout-ms')
      ? {
          approval_timeout_ms: optionalPositiveInteger(
            parsed.values.get('--approval-timeout-ms'),
            '--approval-timeout-ms',
          ),
        }
      : {}),
  })
  process.stdout.write(`${JSON.stringify({
    state: result.all_gates_passed ? 'passed' : 'failed',
    provider_id: result.finalization.matrix.provider_id,
    executable_version: result.finalization.matrix.executable_version,
    platform: result.finalization.matrix.platform,
    source_commit: result.finalization.matrix.source_commit,
    artifact_root: result.artifact_root,
    matrix_ref: result.finalization.matrix_ref,
    matrix_sha256: result.finalization.matrix_sha256,
    database_path: result.database_path,
    evidence_record_id: result.finalization.evidence_record?.id ?? null,
    gates: Object.fromEntries(result.finalization.gates.map((gate) => [
      gate.gate_id,
      {
        state: gate.state,
        evidence_ref: gate.evidence_ref,
        artifact_sha256: gate.artifact_sha256,
      },
    ])),
  }, null, 2)}\n`)
  if (!result.all_gates_passed) process.exitCode = 1
}
