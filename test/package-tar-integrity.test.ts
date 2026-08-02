import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertTarRegularEntries } from '../scripts/tar-artifact-integrity.mjs'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('package tar entry integrity', () => {
  it('accepts regular files and directories', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-tar-regular-'))
    temporaryDirectories.push(directory)
    fs.mkdirSync(path.join(directory, 'package'))
    fs.writeFileSync(path.join(directory, 'package', 'package.json'), '{}\n')
    const archive = path.join(directory, 'regular.tgz')
    execFileSync('tar', ['-czf', archive, '-C', directory, 'package'])

    expect(assertTarRegularEntries(archive)).toMatchObject({
      regular_files_and_directories_only: true,
    })
  })

  it('rejects symlinks and hardlinks before extraction or content reads', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-tar-links-'))
    temporaryDirectories.push(directory)
    const packageDirectory = path.join(directory, 'package')
    fs.mkdirSync(packageDirectory)
    fs.writeFileSync(path.join(packageDirectory, 'target.txt'), 'target\n')
    fs.symlinkSync('target.txt', path.join(packageDirectory, 'linked.txt'))
    const symlinkArchive = path.join(directory, 'symlink.tgz')
    execFileSync('tar', ['-czf', symlinkArchive, '-C', directory, 'package'])
    expect(() => assertTarRegularEntries(symlinkArchive))
      .toThrow('package tarball contains non-regular entry type')

    fs.unlinkSync(path.join(packageDirectory, 'linked.txt'))
    fs.linkSync(
      path.join(packageDirectory, 'target.txt'),
      path.join(packageDirectory, 'hardlinked.txt'),
    )
    const hardlinkArchive = path.join(directory, 'hardlink.tgz')
    execFileSync('tar', ['-czf', hardlinkArchive, '-C', directory, 'package'])
    expect(() => assertTarRegularEntries(hardlinkArchive))
      .toThrow('package tarball contains non-regular entry type')
  })
})
