import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { CardDrawer } from '../web/src/CardDrawer.js'
import type { Card } from '../web/src/api.js'

const stylesheet = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
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

  it('bounds the unassigned provider controls to the mobile drawer content width', () => {
    const mobileDrawerStyles = stylesheet.match(
      /@media \(max-width: 768px\) \{[\s\S]*?\/\* agent console fills the screen/,
    )?.[0]

    expect(stylesheet).toMatch(/\.drawer-owner\s*\{[^}]*min-width:\s*0;/)
    expect(mobileDrawerStyles).toMatch(/\.drawer-owner\s*\{[^}]*flex-wrap:\s*wrap;/)
    expect(mobileDrawerStyles).toMatch(
      /\.drawer-owner > \.provider-launch-card\s*\{[^}]*max-width:\s*100%;[^}]*flex-wrap:\s*wrap;/,
    )
    expect(mobileDrawerStyles).toMatch(
      /\.drawer-owner > \.provider-launch-card > \.provider-launch-override select\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;/,
    )
  })

  it('contains drawer launch options without changing card defaults or the mobile anchor', () => {
    const mobileDrawerStyles = stylesheet.match(
      /@media \(max-width: 768px\) \{[\s\S]*?\/\* agent console fills the screen/,
    )?.[0]
    const drawerPanel = String.raw`\.drawer-owner > \.provider-launch-card > \.provider-launch-config > \.provider-launch-config-panel`

    expect(stylesheet).toMatch(
      new RegExp(`${drawerPanel}\\s*\\{[^}]*right:\\s*0;[^}]*left:\\s*auto;`),
    )
    expect(stylesheet).toMatch(
      /\.drawer-owner > \.provider-launch-card:has\(\.provider-launch-config\),[\s\S]*?flex:\s*1 1 100%;[^}]*max-width:\s*100%;/,
    )
    expect(stylesheet).toMatch(
      /\.drawer-owner > \.provider-launch-card > \.provider-launch-config\s*\{[^}]*margin-left:\s*auto;/,
    )
    expect(mobileDrawerStyles).toMatch(
      new RegExp(`${drawerPanel}\\s*\\{[^}]*right:\\s*auto;[^}]*left:\\s*0;`),
    )
    expect(stylesheet).toContain('.provider-launch-card .provider-launch-config-panel { right: auto; left: 0; }')
  })
})
