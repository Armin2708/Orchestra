import fs from 'node:fs/promises'
import path from 'node:path'
import { dataDir } from '../daemon.js'

const ORG_SYNC_STATE_FILES = ['org-cursor.json', 'outbox.json', 'org-state.json'] as const

export async function clearOrgSyncState(home = dataDir()): Promise<void> {
  await Promise.all(ORG_SYNC_STATE_FILES.map((name) => fs.rm(path.join(home, name), { force: true })))
}
