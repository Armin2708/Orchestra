import { expect, it } from 'vitest'
import {
  localConsoleCommand,
  normalizeSlashCommandName,
  panelForSlashCommand,
  panelForSlashInput,
  sessionModelValue,
  uniqueSlashCommands,
} from '../web/src/agentTerminalControls.js'

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

it('reads the provider model identifier used by the live SDK catalog', () => {
  expect(sessionModelValue({ value: 'claude-fable-5', model: 'wrong' })).toBe('claude-fable-5')
  expect(sessionModelValue({ model: 'legacy-model' })).toBe('legacy-model')
  expect(sessionModelValue({ resolvedModel: 'resolved-model' })).toBe('resolved-model')
  expect(sessionModelValue({})).toBe('')
})

it('routes local console commands and their familiar aliases', () => {
  expect(localConsoleCommand('/commands')).toBe('commands')
  expect(localConsoleCommand('/help')).toBe('commands')
  expect(localConsoleCommand('/cost')).toBe('usage')
  expect(localConsoleCommand('/status extra')).toBe('status')
  expect(localConsoleCommand('/compact')).toBeNull()
  expect(localConsoleCommand('status')).toBeNull()
})

it('keeps the first command definition so Orchestra actions override provider name collisions', () => {
  expect(uniqueSlashCommands([
    { name: '/resume', source: 'orchestra' },
    { name: 'resume', source: 'session' },
    { name: 'review', source: 'session' },
  ])).toEqual([
    { name: '/resume', source: 'orchestra' },
    { name: 'review', source: 'session' },
  ])
})
