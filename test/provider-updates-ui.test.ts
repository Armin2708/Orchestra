import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const view = readFileSync(new URL('../web/src/SettingsView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../web/src/settings.css', import.meta.url), 'utf8')
const api = readFileSync(new URL('../web/src/osApi.ts', import.meta.url), 'utf8')

describe('provider update chip in Settings', () => {
  it('renders a per-provider panel with an update-available chip', () => {
    expect(view).toContain('ProviderUpdatesPanel')
    expect(view).toContain('className="provider-updates-chip"')
    expect(view).toContain('update available')
  })

  it('distinguishes up-to-date from unknown so it never claims currency it cannot prove', () => {
    expect(view).toContain('provider-updates-chip current')
    expect(view).toContain('provider-updates-chip unknown')
    expect(view).toContain('unknown_reason')
  })

  // The gate this card exists for: Orchestra must never upgrade or restart on its own,
  // because upgrading a CLI under a running agent destroys its in-flight work.
  it('offers the update command to copy rather than performing the update', () => {
    expect(view).toContain('update_command')
    expect(view).toMatch(/clipboard/)
    expect(view).toMatch(/never upgrades or restarts anything on its own/)
    expect(view).not.toMatch(/execSync|spawn\(|restartDaemon/)
  })

  it('treats update state as advisory so a registry outage cannot break Settings', () => {
    expect(view).toMatch(/listProviderUpdates\(\)\s*\.then\(setProviderUpdates\)\s*\.catch/)
  })

  it('exposes the typed client call and styles the chip states', () => {
    expect(api).toContain('listProviderUpdates')
    expect(api).toContain('ProviderUpdateState')
    expect(css).toContain('.provider-updates-chip')
    expect(css).toContain('.provider-updates-chip.current')
    expect(css).toContain('.provider-updates-chip.unknown')
  })
})
