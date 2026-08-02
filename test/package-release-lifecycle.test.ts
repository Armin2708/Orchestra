import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { runPackageLifecycle } from '../scripts/package-lifecycle-smoke.mjs'
import {
  captureDatabasePreservation,
  verifyDatabasePreservation,
} from '../scripts/package-lifecycle-smoke.mjs'
import { verifyPackagedMarkdownLinks } from '../scripts/package-link-integrity.mjs'
import {
  canonicalJson,
  manifestContractBinding,
} from '../scripts/exact-commit-contract.mjs'

const root = path.resolve(import.meta.dirname, '..')
const exactContract = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts/exact-commit-ci-contract.json'), 'utf8'),
)

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const fixturePackage = (version = '0.1.0-beta.1') => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-lifecycle-fixture-'))
  temporaryDirectories.push(directory)
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'orchestra-board',
    version,
    type: 'module',
    bin: { orchestra: './cli.js' },
  }))
  fs.writeFileSync(path.join(directory, 'cli.js'), `#!/usr/bin/env node
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path'; import { DatabaseSync } from 'node:sqlite';
const args=process.argv.slice(2); const home=process.env.HOME; const codex=process.env.CODEX_HOME; const state=process.env.ORCHESTRA_HOME;
const provider=()=>args[args.indexOf('--provider')+1];
const rw=(file,install,p)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const j=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};j.hooks??={};if(install)j.hooks.Test=[{hooks:[{command:'orchestra hook --provider '+p}]}];else delete j.hooks.Test;fs.writeFileSync(file,JSON.stringify(j))};
const database=()=>{fs.mkdirSync(state,{recursive:true});const db=new DatabaseSync(path.join(state,'orchestra.db'));db.exec(\`CREATE TABLE IF NOT EXISTS boards(id INTEGER PRIMARY KEY,project_path TEXT UNIQUE,name TEXT);CREATE TABLE IF NOT EXISTS agents(id INTEGER PRIMARY KEY,board_id INTEGER,name TEXT,status TEXT DEFAULT 'active');CREATE TABLE IF NOT EXISTS cards(id INTEGER PRIMARY KEY,board_id INTEGER,title TEXT,column_name TEXT,owner_agent_id INTEGER);\`);return db};
const ensureBoard=(db)=>{const project=fs.realpathSync(process.cwd());db.prepare('INSERT OR IGNORE INTO boards(project_path,name) VALUES(?,?)').run(project,path.basename(project));return db.prepare('SELECT * FROM boards WHERE project_path=?').get(project)};
const snapshot=(db)=>{const board=ensureBoard(db);const agents=db.prepare('SELECT * FROM agents WHERE board_id=? ORDER BY id').all(board.id);const cards=db.prepare(\`SELECT c.id,c.title,c.column_name AS column,a.name AS owner FROM cards c LEFT JOIN agents a ON a.id=c.owner_agent_id WHERE c.board_id=? ORDER BY c.id\`).all(board.id);return {board,agents,cards}};
if(args[0]==='--version') console.log('${version}');
else if(args[0]==='doctor') console.log('{"schema_version":1,"validated_toolchains":[]}');
else if(args[0]==='install'){const p=provider();rw(p==='claude'?path.join(home,'.claude','settings.json'):path.join(codex,'hooks.json'),true,p)}
else if(args[0]==='uninstall'){const p=provider();rw(p==='claude'?path.join(home,'.claude','settings.json'):path.join(codex,'hooks.json'),false,p)}
else if(args[0]==='join'){const db=database();const board=ensureBoard(db);const name=args[args.indexOf('--name')+1];db.prepare('INSERT INTO agents(board_id,name) VALUES(?,?)').run(board.id,name);db.close()}
else if(args[0]==='card'){const db=database();const board=ensureBoard(db);const title=args[2];const owner=args[args.indexOf('--agent')+1];const agent=db.prepare('SELECT id FROM agents WHERE board_id=? AND name=?').get(board.id,owner);db.prepare('INSERT INTO cards(board_id,title,column_name,owner_agent_id) VALUES(?,?,?,?)').run(board.id,title,'in_progress',agent.id);db.close()}
else if(args[0]==='snapshot'){const db=database();console.log(JSON.stringify(snapshot(db)));db.close()}
else if(args[0]==='serve'){const db=database();ensureBoard(db);db.close();const s=http.createServer((q,r)=>{r.setHeader('content-type',q.url==='/health'?'application/json':'text/html');r.end(q.url==='/health'?'{"ok":true}':'<!doctype html><html></html>')});s.listen(Number(process.env.ORCHESTRA_PORT),'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)))}
else process.exitCode=1;
`)
  fs.chmodSync(path.join(directory, 'cli.js'), 0o755)
  fs.mkdirSync(path.join(directory, 'scripts'))
  fs.copyFileSync(
    path.join(root, 'scripts', 'backup-orchestra-state.sh'),
    path.join(directory, 'scripts', 'backup-orchestra-state.sh'),
  )
  fs.chmodSync(path.join(directory, 'scripts', 'backup-orchestra-state.sh'), 0o755)
  const output = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--silent', '--json'],
    { cwd: directory, encoding: 'utf8' },
  )
  const report = JSON.parse(output) as Array<{ filename: string }>
  return path.join(directory, report[0].filename)
}

const exactPriorEvidence = (artifactPath: string, version: string) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-prior-evidence-'))
  temporaryDirectories.push(directory)
  const bytes = fs.readFileSync(artifactPath)
  const sha = (algorithm: string, encoding: 'hex' | 'base64' = 'hex') =>
    createHash(algorithm).update(bytes).digest(encoding)
  const inventory = execFileSync('tar', ['-tzf', artifactPath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((entry) => entry.startsWith('package/') && !entry.endsWith('/'))
    .map((entry) => entry.slice('package/'.length))
    .sort()
  const workflowRun = {
    repository: 'Armin2708/Orchestra',
    event: 'push',
    ref: `refs/tags/v${version}`,
    run_id: '71',
    run_attempt: '1',
  }
  const commitSha = '7'.repeat(40)
  const requiredGates = exactContract.required_gates
  const metadata = {
    commit_sha: commitSha,
    package_name: 'orchestra-board',
    package_version: version,
    filename: path.basename(artifactPath),
    bytes: bytes.byteLength,
    sha256: sha('sha256'),
    npm_shasum: sha('sha1'),
    npm_integrity: `sha512-${sha('sha512', 'base64')}`,
    provenance: { source_commit: commitSha, builder: 'npm pack' },
    file_manifest: inventory.map((entry) => ({ path: entry })),
  }
  const manifest = {
    schema_version: 1,
    backlog_item: 'QA-019',
    commit_sha: commitSha,
    result: 'passed',
    workflow_run: workflowRun,
    generated_at: '2026-08-02T00:00:02.000Z',
    contract: manifestContractBinding(exactContract),
    summary: {
      required: requiredGates.length,
      passed: requiredGates.length,
      failed: 0,
      missing: 0,
      unexpected: 0,
      sha_consistent: true,
      package_consistent: true,
      package_upload_evidence_present: true,
    },
    gates: requiredGates.map((gate_id) => ({
      schema_version: 1,
      commit_sha: commitSha,
      gate_id,
      status: 'passed',
      exit_code: 0,
      started_at: '2026-08-02T00:00:00.000Z',
      completed_at: '2026-08-02T00:00:01.000Z',
      invocation: { executable: 'fixture' },
      runner: { node_version: exactContract.node_version },
      details: gate_id === 'package-upload'
        ? { action_outcome: 'success', artifact_id: '71', artifact_digest: '8'.repeat(64) }
        : {},
    })),
    unexpected_gates: [],
    package_artifact: metadata,
  }
  const manifestPath = path.join(directory, 'manifest.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const artifact = { name: 'orchestra-board', version, filename: path.basename(artifactPath),
      bytes: bytes.byteLength, sha256: sha('sha256'), npm_shasum: sha('sha1'),
      npm_integrity: `sha512-${sha('sha512', 'base64')}` }
  const attestation = {
    schema_version: 1,
    repository: 'Armin2708/Orchestra',
    workflow: '.github/workflows/ci.yml',
    event: 'push',
    ref: `refs/tags/v${version}`,
    tag: `v${version}`,
    source_commit: commitSha,
    workflow_run: { run_id: workflowRun.run_id, run_attempt: workflowRun.run_attempt },
    package_upload: { artifact_id: '71', artifact_digest: '8'.repeat(64) },
    evidence_manifest: {
      sha256: createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'),
      contract_schema_version: exactContract.schema_version,
      contract_sha256: manifestContractBinding(exactContract).contract_sha256,
    },
    artifact,
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = `sha256:${createHash('sha256').update(
    publicKey.export({ format: 'der', type: 'spki' }),
  ).digest('hex')}`
  const receipt = {
    schema_version: 2,
    kind: 'maintainer-signature',
    attestation,
    signature: {
      algorithm: 'ed25519',
      key_id: keyId,
      value: sign(null, Buffer.from(canonicalJson(attestation)), privateKey).toString('base64'),
    },
  }
  fs.writeFileSync(
    path.join(directory, 'retained-artifact-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  )
  return {
    directory,
    trustRoots: {
      schema_version: 1,
      repository: 'Armin2708/Orchestra',
      workflow: '.github/workflows/ci.yml',
      event: 'push',
      trusted_signing_keys: [{
        key_id: keyId,
        algorithm: 'ed25519',
        public_key_pem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      }],
    },
  }
}

describe('QA-017 package lifecycle harness', () => {
  it('exercises installed doctor, daemon, web, hooks, idempotency, uninstall, and real DB preservation', async () => {
    const report = await runPackageLifecycle({ artifactPath: fixturePackage(), runAudit: false })
    expect(report).toMatchObject({
      schema_version: 2,
      passed: false,
      local_rehearsal_passed: true,
      release_gate: { status: 'incomplete', prior_evidence_verified: false },
      installed_version: '0.1.0-beta.1',
      upgraded_version: '0.1.0-beta.1',
      package_install_scripts_absent: true,
      dependency_install_scripts_allowed: true,
      provider_hooks_reversible: true,
      provider_hooks: { passed: true },
      idempotency_reinstall: { observed: true, passed: true, explicitly_not_upgrade_evidence: true },
      upgrade: { observed: false, passed: false, mode: 'same-artifact-idempotency' },
      rollback: { observed: false, passed: false },
      data_preservation: {
        actual_orchestra_database: true,
        active_work_preserved: true,
        database_continuity: {
          after_upgrade: { passed: true, all_prior_primary_keys_present: true },
          after_uninstall: { passed: true, all_prior_primary_keys_present: true },
        },
        packaged_backup: {
          script_path: 'node_modules/orchestra-board/scripts/backup-orchestra-state.sh',
          integrity_check: 'ok',
          active_work_preserved: true,
          passed: true,
        },
      },
      state_preserved_after_upgrade: true,
      state_preserved_after_uninstall: true,
      project_preserved_after_uninstall: true,
      package_removed: true,
      runtime: { doctor_contract: true, daemon_health: true, web_index_served: true },
      audit: { executed: false },
    })
  }, 20_000)

  it('requires exact evidence and passes release only after verified cross-version rollback', async () => {
    const previous = fixturePackage('0.1.0-beta.0')
    const candidate = fixturePackage('0.1.0-beta.1')

    await expect(runPackageLifecycle({
      artifactPath: candidate,
      previousArtifactPath: previous,
      runAudit: false,
    })).rejects.toThrow('requires machine-verifiable prior exact-commit evidence')

    const evidence = exactPriorEvidence(previous, '0.1.0-beta.0')
    await expect(runPackageLifecycle({
      artifactPath: candidate,
      previousArtifactPath: previous,
      previousEvidenceDirectory: evidence.directory,
    })).rejects.toThrow('no trusted prior-artifact signing key is configured')

    const report = await runPackageLifecycle({
      artifactPath: candidate,
      previousArtifactPath: previous,
      previousEvidenceDirectory: evidence.directory,
      priorTrustRoots: evidence.trustRoots,
    })
    expect(report).toMatchObject({
      local_rehearsal_passed: true,
      passed: true,
      previous_artifact: { evidence: { verified: true, trust_kind: 'maintainer-signature' } },
      upgrade: { observed: true, passed: true, mode: 'prior-artifact-upgrade' },
      rollback: { observed: true, passed: true },
      release_gate: {
        status: 'passed',
        prior_evidence_verified: true,
        upgrade_passed: true,
        rollback_passed: true,
      },
    })
  }, 30_000)

  it('fails when a recursively packaged Markdown link target is absent', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-package-links-'))
    temporaryDirectories.push(directory)
    fs.mkdirSync(path.join(directory, 'docs'))
    fs.writeFileSync(path.join(directory, 'README.md'), '[Guide](docs/guide.md)\n')
    fs.writeFileSync(path.join(directory, 'docs', 'guide.md'), '[Policy](policy.md)\n')

    expect(() => verifyPackagedMarkdownLinks({
      root: directory,
      files: new Set(['README.md', 'docs/guide.md']),
    })).toThrow('docs/guide.md -> docs/policy.md')

    fs.writeFileSync(path.join(directory, 'docs', 'policy.md'), '# Policy\n')
    expect(verifyPackagedMarkdownLinks({
      root: directory,
      files: new Set(['README.md', 'docs/guide.md', 'docs/policy.md']),
    })).toEqual({ markdown_files: 3, local_links_checked: 2, passed: true })
  })

  it('rejects replaced primary-key identities and dropped tables during preservation checks', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-lifecycle-db-'))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, 'orchestra.db')
    const database = new Database(databasePath)
    database.exec(`
      CREATE TABLE boards(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE retained_notes(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      INSERT INTO boards(id, name) VALUES(1, 'project');
      INSERT INTO retained_notes(id, body) VALUES('note-1', 'preserve');
    `)
    database.close()
    const baseline = captureDatabasePreservation(databasePath)

    const replaced = new Database(databasePath)
    replaced.exec(`
      PRAGMA foreign_keys=OFF;
      UPDATE boards SET id=101 WHERE id=1;
    `)
    replaced.close()
    expect(() => verifyDatabasePreservation(databasePath, baseline, 'candidate upgrade'))
      .toThrow('removed or replaced a primary-key identity in Orchestra table boards')

    const restored = new Database(databasePath)
    restored.exec(`
      UPDATE boards SET id=1 WHERE id=101;
      DROP TABLE retained_notes;
    `)
    restored.close()
    expect(() => verifyDatabasePreservation(databasePath, baseline, 'candidate upgrade'))
      .toThrow('dropped Orchestra table retained_notes')
  })

  it('checks reference, HTML, and root-relative links while ignoring examples', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-package-link-forms-'))
    temporaryDirectories.push(directory)
    fs.mkdirSync(path.join(directory, 'docs'))
    fs.writeFileSync(path.join(directory, 'README.md'), [
      '[Guide][guide]',
      '<a href="/docs/policy.md">Policy</a>',
      '`[example](missing-inline.md)`',
      '```md',
      '[example](missing-fence.md)',
      '```',
      '<!-- [example](missing-comment.md) -->',
      '[guide]: docs/guide.md',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(directory, 'docs', 'guide.md'), '# Guide\n')
    fs.writeFileSync(path.join(directory, 'docs', 'policy.md'), '# Policy\n')

    expect(verifyPackagedMarkdownLinks({
      root: directory,
      files: new Set(['README.md', 'docs/guide.md', 'docs/policy.md']),
    })).toEqual({ markdown_files: 3, local_links_checked: 2, passed: true })

    fs.writeFileSync(path.join(directory, 'README.md'), '[Missing][undefined]\n')
    expect(() => verifyPackagedMarkdownLinks({
      root: directory,
      files: new Set(['README.md', 'docs/guide.md', 'docs/policy.md']),
    })).toThrow('undefined references')
  })

  it('checks shortcut reference definitions instead of silently skipping them', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-package-shortcut-links-'))
    temporaryDirectories.push(directory)
    fs.writeFileSync(path.join(directory, 'README.md'), '[Guide]\n\n[Guide]: missing.md\n')

    expect(() => verifyPackagedMarkdownLinks({
      root: directory,
      files: new Set(['README.md']),
    })).toThrow('README.md -> missing.md')

    fs.writeFileSync(path.join(directory, 'missing.md'), '# Guide\n')
    expect(verifyPackagedMarkdownLinks({
      root: directory,
      files: new Set(['README.md', 'missing.md']),
    })).toEqual({ markdown_files: 2, local_links_checked: 1, passed: true })
  })
})
