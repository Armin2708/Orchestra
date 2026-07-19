import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const cockpit = readFileSync(new URL('../web/src/WorkspaceCockpit.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../web/src/agentOs.css', import.meta.url), 'utf8')

describe('workspace guide', () => {
  it('opens from a persistent, accessible rail control', () => {
    expect(cockpit).toContain('aria-label="Learn how workspaces work"')
    expect(cockpit).toContain('aria-haspopup="dialog"')
    expect(cockpit).toContain('aria-controls="workspace-info-dialog"')
    expect(cockpit).toContain('{infoOpen && <WorkspaceInfoDialog onClose={closeInfo} />}')
  })

  it('explains the lifecycle, recovery value, and token boundary in a trapped modal', () => {
    expect(cockpit).toContain('role="dialog" aria-modal="true"')
    expect(cockpit).toContain('useModalFocusTrap(true, dialogRef, onClose, closeRef)')
    for (const phrase of ['Create', 'Run', 'Inspect', 'Resume', 'A workspace is not an agent.', 'ordinary shell processes use no model tokens.']) {
      expect(cockpit).toContain(phrase)
    }
  })

  it('keeps the guide responsive and motion-safe', () => {
    expect(css).toMatch(/\.os-info-dialog\s*\{[\s\S]*?max-height:\s*calc\(100dvh - 32px\)/)
    expect(css).toContain('.os-info-details { grid-template-columns: 1fr; }')
    expect(css).toMatch(/prefers-reduced-motion:[\s\S]*?\.os-info-dialog/)
  })
})
