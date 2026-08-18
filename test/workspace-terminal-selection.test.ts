import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../web/src/WorkspaceTerminal.tsx', import.meta.url), 'utf8')

describe('workspace terminal auto-selection', () => {
  it('never auto-selects an archived or missing workspace', () => {
    // a 'missing' workspace has lost its worktree: every shell spawn 500s, and the
    // stored localStorage selection would pin the dead workspace across reloads
    expect(source).toContain("!['archived', 'missing'].includes(workspace.status)")
    expect(source).not.toContain("workspace.status !== 'archived')")
  })

  it('revalidates the stored selection against the filtered list before reusing it', () => {
    expect(source).toContain('list.some((workspace) => String(workspace.id) === candidate)')
  })
})
