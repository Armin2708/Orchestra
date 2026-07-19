import { expect, it } from 'vitest'
import { normalizeSlashCommandName, panelForSlashCommand, panelForSlashInput } from '../web/src/agentTerminalControls.js'

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

it('normalizes SDK and Orchestra command names to one leading slash in the UI', () => {
  expect(normalizeSlashCommandName('model')).toBe('model')
  expect(normalizeSlashCommandName('/board')).toBe('board')
  expect(normalizeSlashCommandName('///plugin')).toBe('plugin')
})
