import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { CardDrawer } from '../web/src/CardDrawer.js'
import type { Card } from '../web/src/api.js'

const requireWeb = createRequire(new URL('../web/package.json', import.meta.url))
const { createElement } = requireWeb('react') as {
  createElement: (component: unknown, props: Record<string, unknown>) => unknown
}
const { renderToStaticMarkup } = requireWeb('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string
}

const unassignedCard: Card = {
  id: 42,
  title: 'Repair the owner controls',
  description: 'Keep launch controls in valid semantic markup.',
  column: 'backlog',
  owner: null,
  paths: [],
  updated_at: '2026-07-25 20:00:00',
}

describe('CardDrawer owner controls', () => {
  it('server-renders the unassigned launch control outside paragraph content', () => {
    const markup = renderToStaticMarkup(createElement(CardDrawer, {
      card: unassignedCard,
      boardId: 1,
      agents: [],
      providers: [],
      onClose: () => {},
      onChange: () => {},
    }))

    expect(markup).toContain('<div class="drawer-owner">')
    expect(markup).toContain('class="provider-launch provider-launch-card"')
    expect(markup).not.toMatch(/<p class="drawer-owner">[\s\S]*class="provider-launch provider-launch-card"/)
  })
})
