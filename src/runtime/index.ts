export * from './types.js'
export * from './memory.js'
export * from './workspaces.js'
export * from './supervisor.js'
export * from './drivers/registry.js'
export * from './drivers/shell.js'
export * from './drivers/claude.js'
export * from './drivers/codex.js'
export * from './drivers/provider-adapter.js'
export * from './drivers/codex-provider-adapter.js'
export * from './drivers/provider-launch-request-broker.js'
export * from './drivers/provider-contract-driver.js'

import { DriverRegistry } from './drivers/registry.js'
import { ShellAgentDriver } from './drivers/shell.js'
import { RuntimeSupervisor, type RuntimeSupervisorOptions } from './supervisor.js'

export type RuntimeLayer = {
  supervisor: RuntimeSupervisor
  drivers: DriverRegistry
  shell: ShellAgentDriver
}

export const createRuntimeLayer = (options: RuntimeSupervisorOptions = {}): RuntimeLayer => {
  const supervisor = new RuntimeSupervisor(options)
  const shell = new ShellAgentDriver(supervisor)
  return { supervisor, shell, drivers: new DriverRegistry([shell]) }
}
