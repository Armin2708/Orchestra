import { expect, it } from 'vitest'
import {
  localConsoleCommand,
  modelCatalogSignature,
  modelMatchesResolved,
  normalizeSlashCommandName,
  panelForSlashCommand,
  panelForSlashInput,
  sessionModelValue,
  sessionModelSelection,
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

it('selects provider default exactly once when it aliases an explicit Claude model', () => {
  const models = [
    { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-4-8', isDefault: true },
    { value: 'claude-opus-4-8', displayName: 'Opus 4.8' },
  ]

  const providerDefault = sessionModelSelection(models, {
    requestedModel: null,
    resolvedModel: 'claude-opus-4-8',
  })
  expect(providerDefault).toMatchObject({
    selectedIndex: 0,
    resolvedIndex: 1,
    selectedLabel: 'Provider default',
    resolvedLabel: 'Opus 4.8',
    usesProviderDefault: true,
    pending: false,
  })
  expect(sessionModelSelection(models, {
    requestedModel: 'default',
    resolvedModel: 'claude-opus-4-8',
  })).toMatchObject({ selectedIndex: 0, selectedLabel: 'Provider default', usesProviderDefault: true })

  const explicitOpus = sessionModelSelection(models, {
    requestedModel: 'claude-opus-4-8',
    resolvedModel: 'claude-opus-4-8',
  })
  expect(explicitOpus).toMatchObject({ selectedIndex: 1, usesProviderDefault: false, pending: false })
})

it('keeps a next-turn selection separate from the model currently running', () => {
  const models = [
    { value: 'gpt-5.5', displayName: 'GPT-5.5' },
    { value: 'gpt-5.6', displayName: 'GPT-5.6' },
  ]
  const selection = sessionModelSelection(models, {
    requestedModel: 'gpt-5.6',
    resolvedModel: 'gpt-5.5',
  })

  expect(selection).toMatchObject({
    selectedIndex: 1,
    selectedLabel: 'GPT-5.6',
    resolvedLabel: 'GPT-5.5',
    pending: true,
  })
  expect(modelMatchesResolved(models[0], selection.resolvedModel)).toBe(true)
  expect(modelMatchesResolved(models[1], selection.resolvedModel)).toBe(false)

  expect(sessionModelSelection(models, {
    requestedModel: 'gpt-custom',
    resolvedModel: 'gpt-5.5',
  })).toMatchObject({
    selectedIndex: -1,
    resolvedIndex: 0,
    selectedLabel: 'gpt-custom',
    resolvedLabel: 'GPT-5.5',
    pending: true,
  })
})

it('detects same-length model catalog changes', () => {
  const before = [{ value: 'gpt-5.5', displayName: 'GPT-5.5', supportedEffortLevels: ['low', 'high'] }]
  const after = [{ value: 'gpt-5.6', displayName: 'GPT-5.6', supportedEffortLevels: ['low', 'medium', 'high'] }]
  expect(modelCatalogSignature(before)).not.toBe(modelCatalogSignature(after))
  expect(modelCatalogSignature(after)).toBe(modelCatalogSignature(after.map((model) => ({ ...model }))))
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
