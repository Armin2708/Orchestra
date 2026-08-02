import { spawnSync } from 'node:child_process'

export function assertTarRegularEntries(tarball) {
  const listed = spawnSync('tar', ['-tvzf', tarball], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (listed.status !== 0) {
    throw new Error(listed.stderr.trim() || 'package tarball type inventory is unreadable')
  }
  const lines = listed.stdout.split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) throw new Error('package tarball type inventory is empty')
  for (const line of lines) {
    const type = line[0]
    if (type !== '-' && type !== 'd') {
      throw new Error(`package tarball contains non-regular entry type ${JSON.stringify(type)}`)
    }
  }
  return { entries: lines.length, regular_files_and_directories_only: true }
}
