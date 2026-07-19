import type { AgentDriver, DriverCapabilities } from '../types.js'

export type DriverDescriptor = {
  id: string
  capabilities: DriverCapabilities
}

export class DriverRegistry {
  private readonly drivers = new Map<string, AgentDriver>()

  constructor(drivers: AgentDriver[] = []) {
    for (const driver of drivers) this.register(driver)
  }

  register(driver: AgentDriver): this {
    if (!driver.id.trim()) throw new Error('driver id is required')
    if (this.drivers.has(driver.id)) throw new Error(`driver already registered: ${driver.id}`)
    this.drivers.set(driver.id, driver)
    return this
  }

  get(id: string): AgentDriver | undefined {
    return this.drivers.get(id)
  }

  require(id: string): AgentDriver {
    const driver = this.get(id)
    if (!driver) throw new Error(`unsupported driver: ${id}`)
    return driver
  }

  list(): DriverDescriptor[] {
    return [...this.drivers.values()]
      .map((driver) => ({ id: driver.id, capabilities: driver.capabilities() }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
}
