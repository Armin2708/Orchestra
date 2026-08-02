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
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const args=process.argv.slice(2); const home=process.env.HOME; const codex=process.env.CODEX_HOME;
const rw=(file,install)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const j=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};j.hooks??={};if(install)j.hooks.Test=[{hooks:[{command:'orchestra hook fixture'}]}];else delete j.hooks.Test;fs.writeFileSync(file,JSON.stringify(j))};
if(args[0]==='--version') console.log('0.1.0-beta.1');
else if(args[0]==='doctor') console.log('{"schema_version":1,"validated_toolchains":[]}');
else if(args[0]==='install'){rw(path.join(home,'.claude','settings.json'),true);rw(path.join(codex,'hooks.json'),true)}
else if(args[0]==='uninstall'){rw(path.join(home,'.claude','settings.json'),false);rw(path.join(codex,'hooks.json'),false)}
else if(args[0]==='serve'){const s=http.createServer((q,r)=>{r.setHeader('content-type',q.url==='/health'?'application/json':'text/html');r.end(q.url==='/health'?'{"ok":true}':'<!doctype html><html></html>')});s.listen(Number(process.env.ORCHESTRA_PORT),'127.0.0.1')}
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
  it('exercises installed doctor, daemon, web, hooks, upgrade, uninstall, and preservation', () => {
    const report = runPackageLifecycle({ artifactPath: fixturePackage(), runAudit: false })
    expect(report).toMatchObject({
      passed: true,
      installed_version: '0.1.0-beta.1',
      upgraded_version: '0.1.0-beta.1',
      package_install_scripts_absent: true,
      dependency_install_scripts_allowed: true,
      provider_hooks_reversible: true,
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
})
