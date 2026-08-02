import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { SupportCasePanel } from '../web/src/SupportCasePanel.js'

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url))
const React = requireFromWeb('react') as typeof import('react')
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string
}

describe('support-case UI contract', () => {
  it('renders explicit local-only consent, review, exact commit, and diagnostics language', () => {
    const markup = renderToStaticMarkup(React.createElement(SupportCasePanel))
    expect(markup).toContain('Prepare a bug report')
    expect(markup).toContain('Nothing is uploaded')
    expect(markup).toContain('Manual review required')
    expect(markup).toContain('Exact commit')
    expect(markup).toContain('strictly verified redacted diagnostics bytes')
    expect(markup).toContain('I consent to creating a local export')
    expect(markup).toContain('no report is submitted automatically')
    expect(markup).toContain('Create local export')
  })
})
