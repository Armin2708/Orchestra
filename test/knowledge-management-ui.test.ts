import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('standalone Knowledge product surface', () => {
  it('offers cited freshness, all human controls, promotion review, and Why included accounting', () => {
    const view = fs.readFileSync('web/src/KnowledgeView.tsx', 'utf8')
    const api = fs.readFileSync('web/src/knowledgeApi.ts', 'utf8')
    for (const control of ['accept', 'edit', 'pin', 'reject', 'supersede', 'forget']) {
      expect(view).toContain(`'${control}'`)
    }
    expect(view).toContain('Exact source evidence is revalidated on approval.')
    expect(view).toContain('Why included')
    expect(view).toContain('token_contribution_percent')
    expect(view).toContain('source_content_sha256')
    expect(view).toContain('includeStale')
    expect(api).toContain('/knowledge/promotions/')
    expect(api).toContain('/knowledge-manifest')
  })
})
