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
import Database from 'better-sqlite3'
import { verifyPriorArtifactEvidence } from './prior-artifact-evidence.mjs'
import { assertTarRegularEntries } from './tar-artifact-integrity.mjs'

const packageName = 'orchestra-board'
const sha256Pattern = /^[0-9a-f]{64}$/
const waitArray = new Int32Array(new SharedArrayBuffer(4))
const rotatingPrimaryKeyTables = new Set([
  // Reconciliation replaces bounded, generation-scoped success receipts after replay.
  // The durable journal state/day seals and every canonical/user table remain strict.
  'os_compatibility_failure_success_receipts',
])

const invariant = (condition, message) => {
  if (!condition) throw new Error(message)
}

const sleep = (milliseconds) => Atomics.wait(waitArray, 0, 0, milliseconds)

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

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const artifactIdentity = (artifactPath) => {
  const resolved = resolve(artifactPath)
  const stat = lstatSync(resolved)
  invariant(stat.isFile() && !stat.isSymbolicLink(), 'package artifact must be one regular file')
  invariant(stat.size > 0 && resolved.endsWith('.tgz'), 'package artifact must be a non-empty .tgz')
  assertTarRegularEntries(resolved)
  return {
    path: resolved,
    filename: basename(resolved),
    bytes: stat.size,
    sha256: sha256(readFileSync(resolved)),
  }
}

const artifactPackageManifest = (artifactPath) => {
  const extracted = run('tar', ['-xOf', artifactPath, 'package/package.json'])
  const manifest = JSON.parse(extracted.stdout)
  invariant(manifest.name === packageName, 'package artifact has an unexpected package name')
  invariant(
    // npm publish normalizes bin paths by stripping the leading './'
    ['./dist/cli.js', 'dist/cli.js', './cli.js', 'cli.js'].includes(manifest.bin?.orchestra),
    'package artifact has no orchestra executable',
  )
  invariant(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(String(manifest.version ?? '')),
    'package artifact version is not supported SemVer',
  )
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    invariant(!manifest.scripts?.[lifecycle], `package artifact defines forbidden ${lifecycle} script`)
  }
  return manifest
}

const installArtifact = (consumerDirectory, artifactPath) => run(
  'npm',
  ['install', '--no-audit', '--no-fund', '--loglevel=error', artifactPath],
  { cwd: consumerDirectory },
)

const executablePath = (consumerDirectory) =>
  join(consumerDirectory, 'node_modules', '.bin', 'orchestra')

const installedVersion = (executable, projectDirectory, environment) =>
  run(executable, ['--version'], { cwd: projectDirectory, env: environment }).stdout.trim()

const providerHookState = (profileDirectory, codexDirectory) => {
  const claude = readJson(join(profileDirectory, '.claude', 'settings.json'))
  const codex = readJson(join(codexDirectory, 'hooks.json'))
  invariant(claude.keep === 'claude-user-setting', 'Claude user configuration was not preserved')
  invariant(codex.keep === 'codex-user-setting', 'Codex user configuration was not preserved')
  const claudeHooks = JSON.stringify(claude.hooks ?? {})
  const codexHooks = JSON.stringify(codex.hooks ?? {})
  return {
    claude: {
      installed: claudeHooks.includes('orchestra hook'),
      own_provider: claudeHooks.includes('--provider claude'),
      cross_provider: claudeHooks.includes('--provider codex'),
    },
    codex: {
      installed: codexHooks.includes('orchestra hook'),
      own_provider: codexHooks.includes('--provider codex'),
      cross_provider: codexHooks.includes('--provider claude'),
    },
  }
}

const assertHookState = (profileDirectory, codexDirectory, expected) => {
  const observed = providerHookState(profileDirectory, codexDirectory)
  for (const provider of ['claude', 'codex']) {
    invariant(
      observed[provider].installed === expected[provider],
      `${provider} hook installation state is incorrect`,
    )
    invariant(
      observed[provider].cross_provider === false,
      `${provider} hook configuration contains the other provider`,
    )
    invariant(
      observed[provider].own_provider === expected[provider],
      `${provider} hook configuration does not contain exact provider content`,
    )
  }
  return observed
}

const exerciseProviderHooks = (executable, projectDirectory, environment, profileDirectory, codexDirectory) => {
  run(executable, ['install', '--provider', 'claude'], { cwd: projectDirectory, env: environment })
  const claudeOnly = assertHookState(profileDirectory, codexDirectory, {
    claude: true,
    codex: false,
  })
  run(executable, ['install', '--provider', 'codex'], { cwd: projectDirectory, env: environment })
  const bothIndependent = assertHookState(profileDirectory, codexDirectory, {
    claude: true,
    codex: true,
  })
  run(executable, ['uninstall', '--provider', 'claude'], { cwd: projectDirectory, env: environment })
  const codexOnly = assertHookState(profileDirectory, codexDirectory, {
    claude: false,
    codex: true,
  })
  return { claudeOnly, bothIndependent, codexOnly, passed: true }
}

const removeRemainingProviderHooks = (
  executable,
  projectDirectory,
  environment,
  profileDirectory,
  codexDirectory,
) => {
  run(executable, ['uninstall', '--provider', 'codex'], {
    cwd: projectDirectory,
    env: environment,
  })
  assertHookState(profileDirectory, codexDirectory, { claude: false, codex: false })
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

const waitForHttp = async (url, expectedPattern, exited) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (exited()) throw new Error(`installed runtime exited before serving ${url}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      const body = await response.text()
      if (response.ok && expectedPattern.test(body)) return body
    } catch {
      // The retained runtime has not accepted the handed-off port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`installed runtime did not serve ${url}`)
}

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

const stopDaemonAndWait = async (daemon) => {
  if (!daemon.pid || daemon.exitCode !== null || daemon.signalCode !== null) return
  const exited = new Promise((resolveExit) => daemon.once('exit', resolveExit))
  invariant(daemon.kill('SIGTERM'), `could not send SIGTERM to installed daemon ${daemon.pid}`)
  const result = await Promise.race([
    exited.then(() => 'exited'),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 10_000)),
  ])
  invariant(result === 'exited', `installed daemon ${daemon.pid} did not exit after SIGTERM`)
  invariant(!processIsAlive(daemon.pid), `installed daemon ${daemon.pid} was not reaped after exit`)
}

const exerciseInstalledRuntimeOnce = async (
  executable,
  projectDirectory,
  environment,
  onReady,
) => {
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
    const health = await waitForHttp(
      `http://127.0.0.1:${port}/health`,
      /"ok"\s*:\s*true/,
      exited,
    )
    const web = await waitForHttp(
      `http://127.0.0.1:${port}/`,
      /<html|<!doctype html/i,
      exited,
    )
    const callbackEvidence = onReady?.(runtimeEnvironment)
    return {
      doctor_contract: true,
      daemon_health: JSON.parse(health).ok === true,
      web_index_served: /<html|<!doctype html/i.test(web),
      callback_evidence: callbackEvidence ?? null,
      port_handoff_attempts: 1,
      graceful_shutdown: true,
    }
  } catch (error) {
    const diagnostics = [daemonError.trim(), daemonOutput.trim()].filter(Boolean).join(' | ')
    const wrapped = new Error(
      `${error instanceof Error ? error.message : String(error)}` +
      `${diagnostics ? `: ${diagnostics}` : ''}` +
      ` (exit=${daemon.exitCode ?? 'running'}, signal=${daemon.signalCode ?? 'none'})`,
    )
    wrapped.cause = diagnostics
    throw wrapped
  } finally {
    await stopDaemonAndWait(daemon)
  }
}

const exerciseInstalledRuntime = async (executable, projectDirectory, environment, onReady) => {
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

  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const evidence = await exerciseInstalledRuntimeOnce(
        executable,
        projectDirectory,
        environment,
        onReady,
      )
      evidence.port_handoff_attempts = attempt
      return evidence
    } catch (error) {
      lastError = error
      if (!String(error?.cause ?? '').includes('EADDRINUSE') || attempt === 3) throw error
    }
  }
  throw lastError
}

const captureDatabaseEvidence = (databasePath) => {
  invariant(existsSync(databasePath), 'Orchestra database is missing')
  const database = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const schema = database.prepare(`
      SELECT type, name, COALESCE(sql, '') AS sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all()
    const boards = database.prepare('SELECT id, name FROM boards ORDER BY id').all()
    const cards = database.prepare(
      'SELECT id, title, column_name AS column_name FROM cards ORDER BY id',
    ).all()
    const agents = database.prepare('SELECT id, name, status FROM agents ORDER BY id').all()
    return {
      user_version: Number(database.pragma('user_version', { simple: true })),
      schema_object_count: schema.length,
      schema_sha256: sha256(JSON.stringify(schema)),
      boards,
      cards,
      agents,
      active_card_count: cards.filter((card) => card.column_name !== 'done').length,
      integrity_check: database.pragma('integrity_check', { simple: true }),
    }
  } finally {
    database.close()
  }
}

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`

const canonicalSqlValue = (value) => {
  if (Buffer.isBuffer(value)) return { type: 'blob', hex: value.toString('hex') }
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() }
  return value
}

const canonicalPrimaryKey = (row, columns) => JSON.stringify(
  columns.map((column) => canonicalSqlValue(row[column])),
)

const foreignKeySignature = (foreignKey) => JSON.stringify({
  referenced_table: foreignKey.referenced_table,
  from_columns: foreignKey.from_columns,
  to_columns: foreignKey.to_columns,
})

const multiset = (values) => {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

export const captureDatabasePreservation = (databasePath) => {
  invariant(existsSync(databasePath), 'Orchestra database is missing')
  const database = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const tableNames = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name)
    const tables = tableNames.map((name) => {
      const columns = database.prepare(`
        SELECT cid, name, type, "notnull" AS not_null, dflt_value, pk
        FROM pragma_table_info(?)
        ORDER BY cid
      `).all(name)
      const columnDescriptors = columns.map((column) => ({
        name: column.name,
        type: column.type,
        not_null: Number(column.not_null),
        default_value: column.dflt_value,
        primary_key_position: Number(column.pk),
      }))
      const primaryKeyColumns = columns
        .filter((column) => Number(column.pk) > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk))
        .map((column) => column.name)
      const table = quoteIdentifier(name)
      const rowCount = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
      let primaryKeys = []
      if (primaryKeyColumns.length > 0) {
        const selected = primaryKeyColumns.map(quoteIdentifier).join(', ')
        const ordered = primaryKeyColumns.map(quoteIdentifier).join(', ')
        primaryKeys = database.prepare(
          `SELECT ${selected} FROM ${table} ORDER BY ${ordered}`,
        ).all().map((row) => canonicalPrimaryKey(row, primaryKeyColumns))
      }
      const foreignKeyRows = database.prepare(`
        SELECT id, seq, "table" AS referenced_table, "from" AS from_column,
          "to" AS to_column
        FROM pragma_foreign_key_list(?)
        ORDER BY id, seq
      `).all(name)
      const groupedForeignKeys = new Map()
      for (const row of foreignKeyRows) {
        const foreignKey = groupedForeignKeys.get(row.id) ?? {
          referenced_table: row.referenced_table,
          from_columns: [],
          to_columns: [],
        }
        foreignKey.from_columns.push(row.from_column)
        foreignKey.to_columns.push(row.to_column)
        groupedForeignKeys.set(row.id, foreignKey)
      }
      const foreignKeys = [...groupedForeignKeys.values()].map((foreignKey) => {
        const relationships = database.prepare(`SELECT * FROM ${table}`).all().map((row) =>
          JSON.stringify({
            child_primary_key: primaryKeyColumns.map((column) => canonicalSqlValue(row[column])),
            referenced_values: foreignKey.from_columns.map(
              (column) => canonicalSqlValue(row[column]),
            ),
          })).sort()
        return { ...foreignKey, relationships }
      }).sort((left, right) => foreignKeySignature(left).localeCompare(foreignKeySignature(right)))
      const noPrimaryKeyRowHashes = primaryKeyColumns.length === 0
        ? database.prepare(`SELECT * FROM ${table}`).all().map((row) => sha256(JSON.stringify(
            columnDescriptors.map((column) => canonicalSqlValue(row[column.name])),
          ))).sort()
        : []
      return {
        name,
        columns: columnDescriptors,
        row_count: rowCount,
        primary_key_columns: primaryKeyColumns,
        primary_keys: primaryKeys,
        foreign_keys: foreignKeys,
        no_primary_key_row_hashes: noPrimaryKeyRowHashes,
      }
    })
    return { tables }
  } finally {
    database.close()
  }
}

const preservationSummary = (snapshot) => ({
  table_count: snapshot.tables.length,
  row_count: snapshot.tables.reduce((total, table) => total + table.row_count, 0),
  primary_key_count: snapshot.tables.reduce(
    (total, table) => total + table.primary_keys.length,
    0,
  ),
  foreign_key_relationship_count: snapshot.tables.reduce(
    (total, table) => total + table.foreign_keys.reduce(
      (tableTotal, foreignKey) => tableTotal + foreignKey.relationships.length,
      0,
    ),
    0,
  ),
  no_primary_key_row_hash_count: snapshot.tables.reduce(
    (total, table) => total + table.no_primary_key_row_hashes.length,
    0,
  ),
  snapshot_sha256: sha256(JSON.stringify(snapshot)),
})

export const verifyDatabasePreservation = (databasePath, baseline, label) => {
  const observed = captureDatabasePreservation(databasePath)
  const observedTables = new Map(observed.tables.map((table) => [table.name, table]))
  for (const expectedTable of baseline.tables) {
    const observedTable = observedTables.get(expectedTable.name)
    invariant(observedTable, `${label} dropped Orchestra table ${expectedTable.name}`)
    invariant(
      JSON.stringify(observedTable.primary_key_columns) ===
        JSON.stringify(expectedTable.primary_key_columns),
      `${label} changed the primary key of Orchestra table ${expectedTable.name}`,
    )
    const observedColumns = new Map(observedTable.columns.map((column) => [column.name, column]))
    for (const expectedColumn of expectedTable.columns) {
      invariant(
        JSON.stringify(observedColumns.get(expectedColumn.name)) === JSON.stringify(expectedColumn),
        `${label} removed or changed Orchestra column ${expectedTable.name}.${expectedColumn.name}`,
      )
    }
    invariant(
      observedTable.row_count >= expectedTable.row_count,
      `${label} removed rows from Orchestra table ${expectedTable.name}`,
    )
    const observedKeys = new Set(observedTable.primary_keys)
    for (const key of expectedTable.primary_keys) {
      invariant(
        rotatingPrimaryKeyTables.has(expectedTable.name) || observedKeys.has(key),
        `${label} removed or replaced a primary-key identity in Orchestra table ${expectedTable.name}`,
      )
    }
    const observedForeignKeys = new Map(
      observedTable.foreign_keys.map((foreignKey) => [foreignKeySignature(foreignKey), foreignKey]),
    )
    for (const expectedForeignKey of expectedTable.foreign_keys) {
      const signature = foreignKeySignature(expectedForeignKey)
      const observedForeignKey = observedForeignKeys.get(signature)
      invariant(
        observedForeignKey,
        `${label} removed a foreign-key relationship from Orchestra table ${expectedTable.name}`,
      )
      const observedRelationships = multiset(observedForeignKey.relationships)
      for (const [relationship, expectedCount] of multiset(expectedForeignKey.relationships)) {
        invariant(
          (observedRelationships.get(relationship) ?? 0) >= expectedCount,
          `${label} changed a foreign-key relationship in Orchestra table ${expectedTable.name}`,
        )
      }
    }
    const observedUnkeyedRows = multiset(observedTable.no_primary_key_row_hashes)
    for (const [rowHash, expectedCount] of multiset(expectedTable.no_primary_key_row_hashes)) {
      invariant(
        (observedUnkeyedRows.get(rowHash) ?? 0) >= expectedCount,
        `${label} changed a row without a primary key in Orchestra table ${expectedTable.name}`,
      )
    }
  }
  return {
    ...preservationSummary(observed),
    baseline_snapshot_sha256: preservationSummary(baseline).snapshot_sha256,
    all_prior_tables_present: true,
    all_protected_prior_primary_keys_present: true,
    all_prior_foreign_key_relationships_present: true,
    all_prior_columns_present: true,
    all_prior_unkeyed_rows_present: true,
    rotating_primary_key_tables: [...rotatingPrimaryKeyTables],
    row_counts_non_decreasing: true,
    passed: true,
  }
}

const assertPreservedDomainData = (evidence, expected) => {
  invariant(evidence.integrity_check === 'ok', 'Orchestra database integrity check failed')
  invariant(evidence.schema_object_count > 0, 'Orchestra database schema is empty')
  invariant(
    evidence.boards.some((board) => board.name === expected.boardName),
    'preserved Orchestra board is missing',
  )
  invariant(
    evidence.cards.some((card) =>
      card.title === expected.cardTitle && card.column_name === 'in_progress'),
    'preserved active Orchestra card is missing',
  )
  invariant(
    evidence.agents.some((agent) => agent.name === expected.agentName),
    'preserved Orchestra agent is missing',
  )
  invariant(evidence.active_card_count > 0, 'preserved Orchestra active work is missing')
}

const assertExactCoreRowsPreserved = (evidence, baseline, label) => {
  for (const collection of ['boards', 'cards', 'agents']) {
    const observedRows = new Set(evidence[collection].map((row) => JSON.stringify(row)))
    for (const row of baseline[collection]) {
      invariant(
        observedRows.has(JSON.stringify(row)),
        `${label} changed or replaced a retained Orchestra ${collection} row`,
      )
    }
  }
}

const exercisePackagedBackup = (
  consumerDirectory,
  stateDirectory,
  lifecycleRoot,
  environment,
  expected,
) => {
  const backupScript = join(
    consumerDirectory,
    'node_modules',
    packageName,
    'scripts',
    'backup-orchestra-state.sh',
  )
  const scriptStat = lstatSync(backupScript)
  invariant(
    scriptStat.isFile() && !scriptStat.isSymbolicLink(),
    'installed package backup script is not one regular file',
  )
  const backupDirectory = join(lifecycleRoot, 'backup')
  mkdirSync(backupDirectory, { mode: 0o700 })
  const backupPath = join(backupDirectory, 'orchestra.backup.db')
  const backupRun = run('bash', [backupScript, backupPath], { env: environment })
  const checksumPath = `${backupPath}.sha256`
  const backupStat = lstatSync(backupPath)
  const checksumStat = lstatSync(checksumPath)
  invariant(
    backupStat.isFile() && !backupStat.isSymbolicLink() &&
    checksumStat.isFile() && !checksumStat.isSymbolicLink(),
    'packaged backup did not create regular database and checksum files',
  )
  invariant(
    (backupStat.mode & 0o777) === 0o600 && (checksumStat.mode & 0o777) === 0o600,
    'packaged backup database and checksum modes are not 600',
  )
  const backupSha256 = sha256(readFileSync(backupPath))
  invariant(
    readFileSync(checksumPath, 'utf8') === `${backupSha256}  ${backupPath}\n`,
    'packaged backup checksum does not bind the retained backup path and bytes',
  )
  const evidence = captureDatabaseEvidence(backupPath)
  assertPreservedDomainData(evidence, expected)
  return {
    script_path: `node_modules/${packageName}/scripts/backup-orchestra-state.sh`,
    database_sha256: backupSha256,
    integrity_check: evidence.integrity_check,
    active_work_preserved: evidence.active_card_count > 0,
    output_contract: backupRun.stdout.trim().split(/\r?\n/).sort(),
    passed: true,
  }
}

const snapshotDomainData = (executable, projectDirectory, environment) =>
  JSON.parse(run(executable, ['snapshot', '--full'], {
    cwd: projectDirectory,
    env: environment,
  }).stdout)

const assertSnapshot = (snapshot, expected) => {
  invariant(snapshot.board?.name === expected.boardName, 'runtime snapshot lost the lifecycle board')
  invariant(
    snapshot.cards?.some((card) =>
      card.title === expected.cardTitle && card.column === 'in_progress'),
    'runtime snapshot lost active work',
  )
  invariant(
    snapshot.agents?.some((agent) => agent.name === expected.agentName),
    'runtime snapshot lost the lifecycle agent',
  )
  return {
    board_id: snapshot.board.id,
    card_id: snapshot.cards.find((card) => card.title === expected.cardTitle).id,
    agent_id: snapshot.agents.find((agent) => agent.name === expected.agentName).id,
    active_work: true,
  }
}

const auditInstalledArtifact = (consumerDirectory, runAudit) => {
  if (!runAudit) {
    return {
      executed: false,
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
      resolved_lock_sha256: null,
      threshold: 'moderate',
      passed: false,
    }
  }
  const lockPath = join(consumerDirectory, 'package-lock.json')
  invariant(existsSync(lockPath), 'clean consumer install did not produce a resolved lockfile')
  const auditRun = spawnSync(
    'npm',
    ['audit', '--omit=dev', '--audit-level=moderate', '--json'],
    {
      cwd: consumerDirectory,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  )
  let report
  try {
    report = JSON.parse(auditRun.stdout)
  } catch {
    throw new Error(auditRun.stderr.trim() || 'package artifact audit did not return JSON')
  }
  const vulnerabilities = report.metadata?.vulnerabilities ?? {}
  const audit = {
    executed: true,
    info: Number(vulnerabilities.info ?? 0),
    low: Number(vulnerabilities.low ?? 0),
    moderate: Number(vulnerabilities.moderate ?? 0),
    high: Number(vulnerabilities.high ?? 0),
    critical: Number(vulnerabilities.critical ?? 0),
    total: Number(vulnerabilities.total ?? 0),
    resolved_lock_sha256: sha256(readFileSync(lockPath)),
    threshold: 'moderate',
    passed: auditRun.status === 0,
  }
  invariant(
    audit.moderate === 0 && audit.high === 0 && audit.critical === 0 && auditRun.status === 0,
    `package artifact audit found ${audit.moderate} moderate, ${audit.high} high, and ${audit.critical} critical vulnerabilities`,
  )
  invariant(sha256Pattern.test(audit.resolved_lock_sha256), 'resolved consumer lock digest is invalid')
  return audit
}

export async function runPackageLifecycle({
  artifactPath,
  previousArtifactPath,
  previousEvidenceDirectory,
  previousEvidenceManifestPath,
  previousEvidenceReceiptPath,
  priorTrustRoots,
  reportPath,
  keepTemporary = false,
  runAudit = true,
} = {}) {
  const artifact = artifactIdentity(artifactPath)
  const artifactManifest = artifactPackageManifest(artifact.path)
  invariant(
    !previousArtifactPath ||
      previousEvidenceDirectory ||
      (previousEvidenceManifestPath && previousEvidenceReceiptPath),
    'ORCHESTRA_PREVIOUS_PACKAGE requires machine-verifiable prior exact-commit evidence',
  )
  invariant(
    previousArtifactPath ||
      !(previousEvidenceDirectory || previousEvidenceManifestPath || previousEvidenceReceiptPath),
    'prior evidence cannot be supplied without ORCHESTRA_PREVIOUS_PACKAGE',
  )
  const previous = previousArtifactPath ? artifactIdentity(previousArtifactPath) : artifact
  const previousManifest = artifactPackageManifest(previous.path)
  const previousEvidence = previousArtifactPath
    ? verifyPriorArtifactEvidence({
        artifactPath: previous.path,
        evidenceDirectory: previousEvidenceDirectory,
        manifestPath: previousEvidenceManifestPath,
        receiptPath: previousEvidenceReceiptPath,
        trustRoots: priorTrustRoots,
      })
    : {
        verified: false,
        blocker: 'a distinct prior artifact and machine-verifiable evidence bundle were not supplied',
      }
  const crossVersion =
    previousEvidence.verified === true &&
    previous.path !== artifact.path &&
    previous.sha256 !== artifact.sha256 &&
    previousManifest.version !== artifactManifest.version

  const root = mkdtempSync(join(tmpdir(), 'orchestra-package-lifecycle-'))
  const consumerDirectory = join(root, 'consumer')
  const profileDirectory = join(root, 'profile')
  const codexDirectory = join(root, 'codex-profile')
  const stateDirectory = join(root, 'orchestra-state')
  const projectDirectory = join(root, 'project')
  const databasePath = join(stateDirectory, 'orchestra.db')
  const artifactMarkerPath = join(stateDirectory, 'artifacts', 'lifecycle', 'retained.txt')
  const projectMarkerPath = join(projectDirectory, 'user-project-marker.txt')
  const expected = {
    boardName: basename(projectDirectory),
    cardTitle: 'Preserve active package lifecycle work',
    agentName: 'lifecycle-agent',
  }
  const artifactMarker = 'preserve this Orchestra artifact across upgrade, rollback, and uninstall\n'

  mkdirSync(consumerDirectory, { recursive: true })
  mkdirSync(join(profileDirectory, '.claude'), { recursive: true })
  mkdirSync(codexDirectory, { recursive: true })
  mkdirSync(join(stateDirectory, 'artifacts', 'lifecycle'), { recursive: true })
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
  writeFileSync(artifactMarkerPath, artifactMarker)
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
    const executable = executablePath(consumerDirectory)
    invariant(existsSync(executable), 'clean install did not expose the orchestra executable')
    const priorInstalledVersion = installedVersion(executable, projectDirectory, isolatedEnvironment)
    invariant(
      priorInstalledVersion === previousManifest.version,
      'prior installed version does not match the prior artifact manifest',
    )

    const initialRuntime = await exerciseInstalledRuntime(
      executable,
      projectDirectory,
      isolatedEnvironment,
      (runtimeEnvironment) => {
        run(executable, ['join', '--force', '--name', expected.agentName], {
          cwd: projectDirectory,
          env: runtimeEnvironment,
        })
        run(executable, [
          'card', 'create', expected.cardTitle,
          '--paths', 'docs/beta-release-operations.md',
          '--column', 'in_progress',
          '--agent', expected.agentName,
        ], { cwd: projectDirectory, env: runtimeEnvironment })
        return assertSnapshot(
          snapshotDomainData(executable, projectDirectory, runtimeEnvironment),
          expected,
        )
      },
    )
    const hooks = exerciseProviderHooks(
      executable,
      projectDirectory,
      isolatedEnvironment,
      profileDirectory,
      codexDirectory,
    )
    const beforeUpgrade = captureDatabaseEvidence(databasePath)
    assertPreservedDomainData(beforeUpgrade, expected)
    const preservationBaseline = captureDatabasePreservation(databasePath)

    installArtifact(consumerDirectory, artifact.path)
    const candidateExecutable = executablePath(consumerDirectory)
    const candidateInstalledVersion = installedVersion(
      candidateExecutable,
      projectDirectory,
      isolatedEnvironment,
    )
    invariant(
      candidateInstalledVersion === artifactManifest.version,
      'candidate installed version does not match the candidate artifact manifest',
    )
    const candidateRuntime = await exerciseInstalledRuntime(
      candidateExecutable,
      projectDirectory,
      isolatedEnvironment,
      (runtimeEnvironment) => assertSnapshot(
        snapshotDomainData(candidateExecutable, projectDirectory, runtimeEnvironment),
        expected,
      ),
    )
    const afterUpgrade = captureDatabaseEvidence(databasePath)
    assertPreservedDomainData(afterUpgrade, expected)
    assertExactCoreRowsPreserved(afterUpgrade, beforeUpgrade, 'candidate upgrade')
    const preservationAfterUpgrade = verifyDatabasePreservation(
      databasePath,
      preservationBaseline,
      'candidate upgrade',
    )
    invariant(
      afterUpgrade.user_version >= beforeUpgrade.user_version,
      'candidate upgrade reduced the Orchestra schema version',
    )
    invariant(readFileSync(artifactMarkerPath, 'utf8') === artifactMarker, 'artifact changed during upgrade')
    const packagedBackup = exercisePackagedBackup(
      consumerDirectory,
      stateDirectory,
      root,
      isolatedEnvironment,
      expected,
    )

    let rollback = {
      observed: false,
      passed: false,
      prior_artifact_restored: false,
      prior_runtime_started: false,
      data_preserved: false,
      active_work_preserved: false,
      artifact_preserved: false,
      blocker: 'retained prior artifact with a different digest and version was not supplied',
    }
    let preservationAfterRollback = null
    if (crossVersion) {
      installArtifact(consumerDirectory, previous.path)
      const rollbackExecutable = executablePath(consumerDirectory)
      const rollbackVersion = installedVersion(
        rollbackExecutable,
        projectDirectory,
        isolatedEnvironment,
      )
      invariant(rollbackVersion === previousManifest.version, 'rollback did not restore prior version')
      await exerciseInstalledRuntime(
        rollbackExecutable,
        projectDirectory,
        isolatedEnvironment,
        (runtimeEnvironment) => assertSnapshot(
          snapshotDomainData(rollbackExecutable, projectDirectory, runtimeEnvironment),
          expected,
        ),
      )
      const afterRollback = captureDatabaseEvidence(databasePath)
      assertPreservedDomainData(afterRollback, expected)
      assertExactCoreRowsPreserved(afterRollback, beforeUpgrade, 'application rollback')
      preservationAfterRollback = verifyDatabasePreservation(
        databasePath,
        preservationBaseline,
        'application rollback',
      )
      invariant(
        afterRollback.user_version === afterUpgrade.user_version,
        'application rollback attempted to reverse the forward-only schema',
      )
      invariant(
        readFileSync(artifactMarkerPath, 'utf8') === artifactMarker,
        'artifact changed during rollback',
      )
      rollback = {
        observed: true,
        passed: true,
        prior_artifact_restored: true,
        prior_runtime_started: true,
        data_preserved: true,
        active_work_preserved: true,
        artifact_preserved: true,
        blocker: null,
      }
      installArtifact(consumerDirectory, artifact.path)
      invariant(
        installedVersion(executablePath(consumerDirectory), projectDirectory, isolatedEnvironment) ===
          artifactManifest.version,
        'candidate artifact was not restored after rollback rehearsal',
      )
    }

    const audit = auditInstalledArtifact(consumerDirectory, runAudit)
    const finalExecutable = executablePath(consumerDirectory)
    removeRemainingProviderHooks(
      finalExecutable,
      projectDirectory,
      isolatedEnvironment,
      profileDirectory,
      codexDirectory,
    )
    run(
      'npm',
      ['uninstall', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', packageName],
      { cwd: consumerDirectory },
    )
    invariant(!existsSync(finalExecutable), 'npm uninstall left the orchestra executable installed')
    invariant(
      !existsSync(join(consumerDirectory, 'node_modules', packageName)),
      'npm uninstall left the package installed',
    )
    const afterUninstall = captureDatabaseEvidence(databasePath)
    assertPreservedDomainData(afterUninstall, expected)
    assertExactCoreRowsPreserved(afterUninstall, beforeUpgrade, 'package uninstall')
    const preservationAfterUninstall = verifyDatabasePreservation(
      databasePath,
      preservationBaseline,
      'package uninstall',
    )
    invariant(
      readFileSync(artifactMarkerPath, 'utf8') === artifactMarker,
      'Orchestra artifact was deleted or changed during uninstall',
    )
    invariant(
      readFileSync(projectMarkerPath, 'utf8') === 'preserve this project file\n',
      'project data was deleted or changed during uninstall',
    )

    const upgrade = {
      observed: crossVersion,
      passed: crossVersion,
      mode: crossVersion ? 'prior-artifact-upgrade' : 'same-artifact-idempotency',
      prior_version: previousManifest.version,
      candidate_version: artifactManifest.version,
      prior_sha256: previous.sha256,
      candidate_sha256: artifact.sha256,
      digests_differ: previous.sha256 !== artifact.sha256,
      versions_differ: previousManifest.version !== artifactManifest.version,
      candidate_installed_version: candidateInstalledVersion,
      blocker: crossVersion
        ? null
        : 'cross-version upgrade requires a retained prior artifact with a different digest and version',
    }
    const releasePassed = crossVersion && rollback.passed && audit.passed
    const report = {
      schema_version: 2,
      package_name: packageName,
      artifact: {
        filename: artifact.filename,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        version: artifactManifest.version,
      },
      previous_artifact: {
        filename: previous.filename,
        sha256: previous.sha256,
        version: previousManifest.version,
        evidence: previousEvidence,
      },
      idempotency_reinstall: {
        observed: !crossVersion,
        passed: !crossVersion,
        explicitly_not_upgrade_evidence: true,
      },
      upgrade,
      rollback,
      installed_version: priorInstalledVersion,
      upgraded_version: candidateInstalledVersion,
      package_install_scripts_absent: true,
      dependency_install_scripts_allowed: true,
      provider_hooks: hooks,
      provider_hooks_reversible: true,
      data_preservation: {
        actual_orchestra_database: true,
        packaged_backup: packagedBackup,
        schema_before: beforeUpgrade,
        schema_after_upgrade: afterUpgrade,
        schema_after_uninstall: afterUninstall,
        database_continuity: {
          baseline: preservationSummary(preservationBaseline),
          after_upgrade: preservationAfterUpgrade,
          after_rollback: preservationAfterRollback,
          after_uninstall: preservationAfterUninstall,
        },
        active_work_preserved: true,
        artifact_preserved: true,
        project_preserved: true,
      },
      state_preserved_after_upgrade: true,
      state_preserved_after_uninstall: true,
      project_preserved_after_uninstall: true,
      runtime: {
        initial: initialRuntime,
        candidate: candidateRuntime,
        doctor_contract: true,
        daemon_health: true,
        web_index_served: true,
        graceful_shutdown: true,
      },
      package_removed: true,
      audit,
      local_rehearsal_passed: true,
      release_gate: {
        status: releasePassed ? 'passed' : 'incomplete',
        prior_evidence_verified: previousEvidence.verified === true,
        upgrade_passed: upgrade.passed,
        rollback_passed: rollback.passed,
        blocker: releasePassed
          ? null
          : previousEvidence.blocker ?? upgrade.blocker ?? rollback.blocker ??
            (audit.passed ? null : 'clean-consumer moderate+ audit evidence is missing'),
      },
      passed: releasePassed,
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
    const report = await runPackageLifecycle({
      artifactPath: process.argv[2],
      previousArtifactPath: process.argv[3],
      previousEvidenceDirectory:
        process.env.ORCHESTRA_PREVIOUS_PACKAGE_EVIDENCE?.trim() || undefined,
      reportPath: process.env.ORCHESTRA_PACKAGE_LIFECYCLE_REPORT,
      keepTemporary: process.env.ORCHESTRA_KEEP_LIFECYCLE_TEMP === '1',
    })
    console.log(
      `package lifecycle local rehearsal passed for ${report.artifact.filename}; ` +
      `upgrade=${report.upgrade.observed ? 'observed' : 'open'}; ` +
      `rollback=${report.rollback.observed ? 'observed' : 'open'} ` +
      `(${report.artifact.sha256})`,
    )
    if (!report.passed) {
      console.error(`release prerequisite incomplete: ${report.release_gate.blocker}`)
      process.exitCode = 2
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
