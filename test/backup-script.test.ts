import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const script = path.join(root, 'scripts', 'backup-orchestra-state.sh')

const fixture = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-backup-script-'))
  const home = path.join(base, 'home')
  const state = path.join(home, '.orchestra')
  const destination = path.join(base, 'secure')
  const bin = path.join(base, 'bin')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.mkdirSync(destination, { mode: 0o700 })
  fs.mkdirSync(bin, { mode: 0o700 })
  fs.writeFileSync(path.join(state, 'orchestra.db'), 'sqlite fixture\n', { mode: 0o600 })
  const executable = (name: string, body: string) => {
    const file = path.join(bin, name)
    fs.writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 })
  }
  executable('sqlite3', `
if [ "\${2:-}" = 'PRAGMA integrity_check;' ]; then
  printf '%s\\n' "\${STUB_INTEGRITY:-ok}"
  exit 0
fi
case "\${2:-}" in
  ".backup '"*"'")
    target=\${2#".backup '"}
    target=\${target%"'"}
    cp "$1" "$target"
    ;;
  *) exit 65 ;;
esac`)
  executable('shasum', `
if [ "\${3:-}" = '-c' ]; then
  [ "\${STUB_CHECKSUM_FAIL:-0}" = 0 ]
  exit
fi
[ "\${1:-}" = '-a' ] && [ "\${2:-}" = 256 ]
if [ -n "\${STUB_RACE_CHECKSUM:-}" ]; then printf 'concurrent owner\\n' > "$STUB_RACE_CHECKSUM"; fi
printf '%064d  %s\\n' 0 "$3"`)
  executable('sha256sum', `
if [ "\${1:-}" = '-c' ]; then
  [ "\${STUB_CHECKSUM_FAIL:-0}" = 0 ]
  exit
fi
printf '%064d  %s\\n' 0 "$1"`)
  return { base, home, state, destination, bin }
}

const mode = (file: string) => fs.statSync(file).mode & 0o777

describe('executable offline backup workflow', () => {
  it('runs under Bash and Zsh with macOS and GNU checksum contracts', () => {
    const shells = ['/bin/bash', '/bin/zsh']
    for (const [index, shell] of shells.entries()) {
      if (!fs.existsSync(shell)) continue
      const { home, state, destination, bin } = fixture()
      const backup = path.join(destination, `orchestra-${index}.backup.db`)
      execFileSync(shell, [script, backup], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: home,
          ORCHESTRA_HOME: state,
          ORCHESTRA_CHECKSUM_TOOL: index === 0 ? 'shasum' : 'sha256sum',
        },
      })
      expect(fs.readFileSync(backup, 'utf8')).toBe('sqlite fixture\n')
      expect(fs.existsSync(`${backup}.sha256`)).toBe(true)
      expect(mode(backup)).toBe(0o600)
      expect(mode(`${backup}.sha256`)).toBe(0o600)
    }
  })

  it('uses the absolute HOME default and removes every partial output on failure', () => {
    const success = fixture()
    const defaultBackup = path.join(success.destination, 'default.backup.db')
    execFileSync('/bin/bash', [script, defaultBackup], {
      env: {
        PATH: `${success.bin}:/usr/bin:/bin`,
        HOME: success.home,
        ORCHESTRA_CHECKSUM_TOOL: 'shasum',
      },
    })
    expect(fs.existsSync(defaultBackup)).toBe(true)

    for (const failure of [
      { STUB_INTEGRITY: 'corrupt' },
      { STUB_CHECKSUM_FAIL: '1' },
    ]) {
      const sample = fixture()
      const backup = path.join(sample.destination, 'failed.backup.db')
      const result = spawnSync('/bin/bash', [script, backup], {
        env: {
          PATH: `${sample.bin}:/usr/bin:/bin`,
          HOME: sample.home,
          ORCHESTRA_HOME: sample.state,
          ORCHESTRA_CHECKSUM_TOOL: 'shasum',
          ...failure,
        },
      })
      expect(result.status).not.toBe(0)
      expect(fs.existsSync(backup)).toBe(false)
      expect(fs.existsSync(`${backup}.sha256`)).toBe(false)
      expect(fs.readdirSync(sample.destination)).toEqual([])
    }
  })

  it('rejects relative state roots and insecure destination modes', () => {
    const sample = fixture()
    const backup = path.join(sample.destination, 'blocked.backup.db')
    let result = spawnSync('/bin/bash', [script, backup], {
      env: {
        PATH: `${sample.bin}:/usr/bin:/bin`,
        HOME: sample.home,
        ORCHESTRA_HOME: 'relative/state',
      },
    })
    expect(result.status).not.toBe(0)
    expect(fs.existsSync(backup)).toBe(false)

    fs.chmodSync(sample.destination, 0o755)
    result = spawnSync('/bin/bash', [script, backup], {
      env: {
        PATH: `${sample.bin}:/usr/bin:/bin`,
        HOME: sample.home,
        ORCHESTRA_HOME: sample.state,
      },
    })
    expect(result.status).not.toBe(0)
    expect(fs.existsSync(backup)).toBe(false)
  })

  it('does not delete a concurrently created checksum target', () => {
    const sample = fixture()
    const backup = path.join(sample.destination, 'raced.backup.db')
    const checksum = `${backup}.sha256`
    const result = spawnSync('/bin/bash', [script, backup], {
      env: {
        PATH: `${sample.bin}:/usr/bin:/bin`,
        HOME: sample.home,
        ORCHESTRA_HOME: sample.state,
        ORCHESTRA_CHECKSUM_TOOL: 'shasum',
        STUB_RACE_CHECKSUM: checksum,
      },
    })
    expect(result.status).not.toBe(0)
    expect(fs.existsSync(backup)).toBe(false)
    expect(fs.readFileSync(checksum, 'utf8')).toBe('concurrent owner\n')
  })

  it('is committed as an executable fail-fast script', () => {
    expect(mode(script) & 0o111).not.toBe(0)
    const source = fs.readFileSync(script, 'utf8')
    expect(source).toContain('set -euo pipefail')
    expect(source).toContain('umask 077')
    expect(source).toContain("[ \"$orchestra_integrity\" != ok ]")
  })
})
