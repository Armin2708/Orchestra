import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runPackageLifecycle } from '../scripts/package-lifecycle-smoke.mjs'
import { verifyPackagedMarkdownLinks } from '../scripts/package-link-integrity.mjs'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const fixturePackage = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-lifecycle-fixture-'))
  temporaryDirectories.push(directory)
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'orchestra-board',
    version: '0.1.0-beta.1',
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
if(args[0]==='--version') console.log('0.1.0-beta.1');
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
  const output = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--silent', '--json'],
    { cwd: directory, encoding: 'utf8' },
  )
  const report = JSON.parse(output) as Array<{ filename: string }>
  return path.join(directory, report[0].filename)
}

describe('QA-017 package lifecycle harness', () => {
  it('exercises installed doctor, daemon, web, hooks, idempotency, uninstall, and real DB preservation', async () => {
    const report = await runPackageLifecycle({ artifactPath: fixturePackage(), runAudit: false })
    expect(report).toMatchObject({
      schema_version: 2,
      passed: true,
      installed_version: '0.1.0-beta.1',
      upgraded_version: '0.1.0-beta.1',
      package_install_scripts_absent: true,
      dependency_install_scripts_allowed: true,
      provider_hooks_reversible: true,
      provider_hooks: { passed: true },
      idempotency_reinstall: { observed: true, passed: true, explicitly_not_upgrade_evidence: true },
      upgrade: { observed: false, passed: false, mode: 'same-artifact-idempotency' },
      rollback: { observed: false, passed: false },
      data_preservation: { actual_orchestra_database: true, active_work_preserved: true },
      state_preserved_after_upgrade: true,
      state_preserved_after_uninstall: true,
      project_preserved_after_uninstall: true,
      package_removed: true,
      runtime: { doctor_contract: true, daemon_health: true, web_index_served: true },
      audit: { executed: false },
    })
  }, 20_000)

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
})
