import { expect, it } from 'vitest'
import { panelForSlashCommand, panelForSlashInput } from '../web/src/agentTerminalControls.js'

it('routes interactive Claude commands to native console panels', () => {
  expect(panelForSlashCommand('model')).toBe('model')
  expect(panelForSlashCommand('/MCP')).toBe('mcp')
  expect(panelForSlashInput('  /plugin  ')).toBe('plugin')
})

it('leaves ordinary and argument-bearing slash commands on the prompt path', () => {
  expect(panelForSlashCommand('compact')).toBeNull()
  expect(panelForSlashInput('/compact keep decisions')).toBeNull()
  expect(panelForSlashInput('model')).toBeNull()
})
