import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../scripts/lib/browser-quality.mjs'

type ContrastContract = {
  file: string
  selector: string
  background: string
}

const contracts: ContrastContract[] = [
  { file: 'web/src/organizationCenter.css', selector: '.oc-kicker, .oc-panel > header p', background: '#f6f4ef' },
  { file: 'web/src/settings.css', selector: '.settings-kicker, .agent-default-index', background: '#f7f6f3' },
  { file: 'web/src/settings.css', selector: '.settings-freshness small', background: '#f7f6f3' },
  { file: 'web/src/supportCase.css', selector: '.support-case-panel label small', background: '#f7f6f3' },
  { file: 'web/src/supportCase.css', selector: '.support-case-consent span', background: '#f1eee7' },
  { file: 'web/src/supportCase.css', selector: '.support-case-actions p', background: '#f7f6f3' },
  { file: 'web/src/remoteAccess.css', selector: '.remote-device-list > p', background: '#f7f6f3' },
  { file: 'web/src/remoteAccess.css', selector: '.remote-notification-settings p', background: '#f7f6f3' },
  { file: 'web/src/remoteAccess.css', selector: '.remote-install-guide p, .remote-install-guide small', background: '#f7f6f3' },
]

const cssBlock = (source: string, selector: string): string => {
  const start = source.indexOf(`${selector} {`)
  expect(start, `missing selector ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `unterminated selector ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

const declaredColor = (block: string): string => {
  const color = /(?:^|[;{])\s*color:\s*(#[0-9a-f]{6})\b/iu.exec(block)?.[1]
  expect(color, `missing opaque text color in ${block}`).toBeTruthy()
  return color as string
}

const rgb = (hex: string): string => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
  return `rgb(${channels.join(', ')})`
}

describe('WCAG AA text contrast contracts', () => {
  it.each(contracts)('$selector stays readable on its warm paper surface', ({ file, selector, background }) => {
    const source = readFileSync(file, 'utf8')
    const ratio = contrastRatio(rgb(declaredColor(cssBlock(source, selector))), rgb(background))
    expect(ratio, `${selector} in ${file}`).not.toBeNull()
    expect(ratio as number, `${selector} in ${file}`).toBeGreaterThanOrEqual(4.5)
  })
})
