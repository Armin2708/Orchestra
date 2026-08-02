import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AgentHomeDiscussions,
  JobDetailDiscussions,
  ProjectDiscussionCenter,
} from '../web/src/DiscussionCenter.js'
import type { DiscussionClient } from '../web/src/discussionApi.js'

const client = {} as DiscussionClient
const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url))
const { createElement } = requireFromWeb('react') as {
  createElement: (component: unknown, props: Record<string, unknown>) => unknown
}
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string
}

describe('Discussion standalone UI contract', () => {
  it('exports the Agent Home, Job Detail, and project command-center surfaces', () => {
    for (const component of [
      AgentHomeDiscussions,
      JobDetailDiscussions,
      ProjectDiscussionCenter,
    ]) {
      const markup = renderToStaticMarkup(createElement(component, {
        boardId: 1,
        client,
      }))
      expect(markup).toContain('Collaborative intelligence')
      expect(markup).toContain('Search discussions')
      expect(markup).toContain('Unanswered')
      expect(markup).toContain('Needs human')
    }
  })

  it('renders retained post text through React and never enables raw HTML', () => {
    const source = readFileSync(
      new URL('../web/src/DiscussionCenter.tsx', import.meta.url),
      'utf8',
    )
    expect(source).not.toContain('dangerouslySetInnerHTML')
    expect(source).toContain('<p>{post.body}</p>')
    expect(source).toContain('Request knowledge review')
  })
})
