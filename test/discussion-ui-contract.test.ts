import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentHomeDiscussions,
  JobDetailDiscussions,
  ProjectDiscussionCenter,
} from '../web/src/DiscussionCenter.js'
import { discussionApi, type DiscussionClient } from '../web/src/discussionApi.js'

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

  it('keeps authenticated discussion reads out of browser HTTP caches', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ discussions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await discussionApi.list(7)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/os/boards/7/discussions',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    )
  })
})
