import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../web/src/DiscussionCenter.tsx', import.meta.url),
  'utf8',
)

describe('Discussion form accessibility source contract', () => {
  it('gives every Discussion form and control an accessible name', () => {
    for (const name of [
      'Search discussions',
      'Post discussion reply',
      'Create discussion',
      'Discussion reply',
      'Discussion type',
      'Discussion title',
      'Discussion body',
      'Discussion tags',
    ]) {
      expect(source).toContain(`aria-label="${name}"`)
    }
    expect(source.match(/<form\b/gu)).toHaveLength(3)
    expect(source.match(/<form\b[^>]*aria-label=/gu)).toHaveLength(3)
    expect(source).not.toContain('dangerouslySetInnerHTML')
  })
})
