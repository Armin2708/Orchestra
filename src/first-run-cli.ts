import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import {
  applyFirstRunAmbientHooks,
  applyFirstRunPlan,
  buildFirstRunPlan,
  type FirstRunAnswers,
  type FirstRunExecutionMode,
  type FirstRunHookChoice,
  type FirstRunPlan,
  type FirstRunProviderId,
  type FirstRunTelemetryChoice,
} from './first-run-onboarding.js'
import {
  createLifecycleDemoLaunchAuthorizer,
  runLifecycleDemo,
  type LifecycleDemoLaunchGateDeps,
} from './lifecycle-demo.js'
import type { AgentOsApi } from './agent-os-cli.js'

export type FirstRunAsk = (
  question: string,
  defaultValue: string,
) => Promise<string>

export type FirstRunCliDeps = {
  cwd?: () => string
  ask?: FirstRunAsk
  output?: (line: string) => void
  applyPlan?: typeof applyFirstRunPlan
  applyAmbientHooks?: typeof applyFirstRunAmbientHooks
  api?: AgentOsApi
  demoLaunchGate?: LifecycleDemoLaunchGateDeps
}

const oneOf = <T extends string>(
  value: string,
  choices: readonly T[],
  label: string,
): T => {
  if (choices.includes(value as T)) return value as T
  throw new Error(`${label} must be ${choices.join('|')}`)
}

const defaultAsk = async (question: string, defaultValue: string): Promise<string> => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await terminal.question(`${question} [${defaultValue}] `)).trim() || defaultValue
  } finally {
    terminal.close()
  }
}

const displayPlan = (plan: FirstRunPlan): string => [
  `Project: ${plan.project_root}`,
  `Provider: ${plan.provider.display_name} (${plan.provider.release_state})`,
  `Execution: ${plan.provider.mode} / ${plan.provider.billing_mode}`,
  `Hooks: ${plan.hooks.scope} (${plan.hooks.capability_state})`,
  `Telemetry: ${plan.defaults.telemetry}`,
  'Safe defaults: loopback-only, remote write off, no API fallback, isolated worktrees, manual cleanup',
  `Managed launch: ${plan.ready_for_managed_launch ? 'READY' : 'BLOCKED'}`,
  ...plan.blockers.map((blocker) => `- ${blocker.code}: ${blocker.detail}`),
].join('\n')

export const collectFirstRunAnswers = async (
  partial: Partial<FirstRunAnswers>,
  ask: FirstRunAsk,
  cwd: string,
): Promise<FirstRunAnswers> => {
  const selectedProject = partial.project_root
    ?? await ask('Project directory', cwd)
  const projectRoot = path.resolve(cwd, selectedProject)
  const provider = partial.provider_id
    ?? oneOf<FirstRunProviderId>(
      await ask('Provider', 'codex'),
      ['claude', 'codex', 'qwen', 'kimi'],
      'provider',
    )
  const executionMode = partial.execution_mode
    ?? oneOf<FirstRunExecutionMode>(
      await ask('Execution mode', 'native_subscription'),
      ['native_subscription', 'provider_api'],
      'execution mode',
    )
  const hookScope = partial.hook_scope
    ?? oneOf<FirstRunHookChoice>(
      await ask('Install provider hooks', 'off'),
      ['off', 'project', 'global'],
      'hook scope',
    )
  const telemetry = partial.telemetry
    ?? oneOf<FirstRunTelemetryChoice>(
      await ask('External redacted telemetry', 'off'),
      ['off', 'redacted'],
      'telemetry',
    )
  const acknowledgeUsagePricedApi = executionMode === 'provider_api'
    ? partial.acknowledge_usage_priced_api
      ?? (await ask('Type ACCEPT_USAGE_PRICED_API to acknowledge separate billing', 'no'))
        === 'ACCEPT_USAGE_PRICED_API'
    : false
  return {
    project_root: projectRoot,
    provider_id: provider,
    execution_mode: executionMode,
    hook_scope: hookScope,
    telemetry,
    acknowledge_usage_priced_api: acknowledgeUsagePricedApi,
  }
}

export const registerFirstRunCommands = (
  program: Command,
  deps: FirstRunCliDeps = {},
): void => {
  const output = deps.output ?? console.log
  const cwd = deps.cwd ?? process.cwd
  const ask = deps.ask ?? defaultAsk

  program.command('onboard')
    .description('configure a safe local-first project and inspect provider readiness')
    .option('--project <path>')
    .option('--provider <provider>', 'claude|codex|qwen|kimi')
    .option('--mode <mode>', 'native_subscription|provider_api')
    .option('--hooks <scope>', 'off|project|global')
    .option('--telemetry <choice>', 'off|redacted')
    .option('--accept-usage-priced-api', 'acknowledge separate provider API billing')
    .option('--apply', 'persist onboarding config and install explicitly selected hooks')
    .option('--apply-ambient-hooks', 'install selected terminal hooks without enabling managed launches')
    .option('--json', 'print the plan as JSON')
    .action(async (options: {
      project?: string
      provider?: string
      mode?: string
      hooks?: string
      telemetry?: string
      acceptUsagePricedApi?: boolean
      apply?: boolean
      applyAmbientHooks?: boolean
      json?: boolean
    }) => {
      if (options.apply && options.applyAmbientHooks) {
        throw new Error('--apply and --apply-ambient-hooks are mutually exclusive')
      }
      const partial: Partial<FirstRunAnswers> = {
        project_root: options.project ? path.resolve(cwd(), options.project) : undefined,
        provider_id: options.provider
          ? oneOf<FirstRunProviderId>(options.provider, ['claude', 'codex', 'qwen', 'kimi'], 'provider')
          : undefined,
        execution_mode: options.mode
          ? oneOf<FirstRunExecutionMode>(options.mode, ['native_subscription', 'provider_api'], 'execution mode')
          : undefined,
        hook_scope: options.hooks
          ? oneOf<FirstRunHookChoice>(options.hooks, ['off', 'project', 'global'], 'hook scope')
          : undefined,
        telemetry: options.telemetry
          ? oneOf<FirstRunTelemetryChoice>(options.telemetry, ['off', 'redacted'], 'telemetry')
          : undefined,
        acknowledge_usage_priced_api: options.acceptUsagePricedApi,
      }
      const answers = await collectFirstRunAnswers(partial, ask, cwd())
      const plan = buildFirstRunPlan(answers)
      if (options.applyAmbientHooks) {
        const hooks = (deps.applyAmbientHooks ?? applyFirstRunAmbientHooks)(plan)
        output(options.json
          ? JSON.stringify({ plan, hooks }, null, 2)
          : `${displayPlan(plan)}\nAmbient ${hooks.provider_id} hooks installed (${hooks.scope}). Managed provider launch was not enabled.`)
        return
      }
      if (options.apply) {
        const config = (deps.applyPlan ?? applyFirstRunPlan)(plan)
        output(options.json
          ? JSON.stringify({ plan, config }, null, 2)
          : `${displayPlan(plan)}\nConfiguration saved. Rerun doctor before any managed launch.`)
        return
      }
      output(options.json ? JSON.stringify(plan, null, 2) : displayPlan(plan))
    })

  program.command('lifecycle-demo')
    .description('create a real Board and WorkContract sample; provider launch is opt-in')
    .option('--project <path>')
    .option('--provider <provider>', 'claude|codex', 'codex')
    .option('--launch', 'explicitly create a provider job after publishing the contract')
    .option('--json', 'print the result as JSON')
    .action(async (options: {
      project?: string
      provider: string
      launch?: boolean
      json?: boolean
    }) => {
      if (!deps.api) throw new Error('lifecycle demo API dependency is not registered')
      const projectRoot = path.resolve(cwd(), options.project ?? cwd())
      if (!fs.existsSync(projectRoot)) throw new Error('demo project directory does not exist')
      const provider = oneOf(options.provider, ['claude', 'codex'], 'provider')
      const result = await runLifecycleDemo(deps.api, {
        project_root: projectRoot,
        provider,
        launch: options.launch,
      }, {
        authorizeLaunch: deps.demoLaunchGate
          ? createLifecycleDemoLaunchAuthorizer(deps.demoLaunchGate)
          : undefined,
      })
      output(options.json ? JSON.stringify(result, null, 2) : [
        `Demo state: ${result.state}`,
        `Board: ${result.board_id}`,
        `Card: ${result.card_id}`,
        `Job: ${result.job_id ?? 'not launched'}`,
        `Next: ${result.next_step}`,
      ].join('\n'))
    })
}

// Explicitly exported for integration code and generated API documentation.
export type {
  FirstRunExecutionMode,
  FirstRunHookChoice,
  FirstRunProviderId,
  FirstRunTelemetryChoice,
}
