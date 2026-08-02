import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { OpenWorkView } from '../web/src/OpenWorkView.js'
import type {
  ContractEnvelope,
  OpenWorkClient,
  OpenWorkResponse,
  TaskContract,
} from '../web/src/openWorkApi.js'

const taskContract: TaskContract = {
  card_id: 88,
  objective: 'Ship <script>alert("unsafe")</script> only after exact verification.',
  deliverables: [{
    id: 'surface',
    text: 'Open Work operator surface',
    required: true,
    metadata: {},
  }],
  acceptance_criteria: [{
    id: 'responsive',
    text: 'Desktop and phone layouts remain usable.',
    required: true,
    deliverable_ids: ['surface'],
    metadata: {},
  }],
  dependencies: [77],
  base_ref: 'main',
  verify_commands: ['npm test -- open-work'],
  non_goals: [],
  risks: ['Stale operator state'],
  budget_tokens: 20_000,
  budget_cents: 500,
  priority: 20,
  policy_id: null,
  workspace_id: 'workspace-ui',
  version: 3,
  updated_at: '2026-07-29T12:00:00.000Z',
}

const contractEnvelope: ContractEnvelope = {
  contract: taskContract,
  job_market: {
    card_id: 88,
    status: 'open',
    market_version: 4,
    contract: taskContract,
    criteria: [{
      ...taskContract.acceptance_criteria[0],
      description: 'Review the desktop and phone layout.',
      verifier: { kind: 'human', instructions: 'Inspect both declared viewports.' },
      required_artifacts: [{
        kind: 'screenshot',
        name: 'Phone viewport',
        description: 'Narrow viewport acceptance evidence',
      }],
      priority: 20,
      owner: 'operator',
    }],
    dependency_rules: [{
      card_id: 77,
      blocking_reason: 'The shared route must be registered first.',
      completion_condition: 'card_done',
    }],
    constraints: {
      required_capabilities: ['typescript', 'ui'],
      provider_constraints: ['codex'],
      model_constraints: ['gpt-5.4'],
      access_needs: ['workspace_write'],
    },
    budgets: {
      tokens: 20_000,
      cost_cents: 500,
      time_seconds: 7_200,
      retries: 0,
      coordination_tokens: 1_500,
      coordination_messages: 12,
    },
    published_at: '2026-07-29T12:00:00.000Z',
    archived_at: null,
    created_at: '2026-07-29T11:00:00.000Z',
    updated_at: '2026-07-29T12:00:00.000Z',
  },
}

const selectedAgent = {
  profile_id: 'profile-ui',
  name: 'UI Operator',
  provider: 'codex',
  model: 'gpt-5.4',
  access_profile: 'workspace_write' as const,
  workspace_id: 'workspace-ui',
  capabilities: ['typescript', 'ui'],
  eligible: true,
  ineligibility_reasons: [],
  capacity: { active: 1, limit: 2, available: 1 },
}

const openWorkResponse: OpenWorkResponse = {
  items: [{
    card_id: 88,
    board_id: 9,
    title: 'Build <img src=x onerror=alert(1)> Open Work',
    repository: '/work/orchestra',
    status: 'open',
    market_version: 4,
    priority: 20,
    constraints: contractEnvelope.job_market.constraints,
    budgets: contractEnvelope.job_market.budgets,
    dependency_readiness: 'blocked',
    dependencies: [{
      card_id: 77,
      title: 'Register shared route',
      state: 'in_progress',
      blocking_reason: 'The shared route must be registered first.',
      completion_condition: 'card_done',
      readiness: 'blocked',
    }],
    critical_path: [{
      path: [
        {
          card_id: 88,
          title: 'Build Open Work',
          state: 'open',
          blocking_reason: null,
        },
        {
          card_id: 77,
          title: 'Register shared route',
          state: 'in_progress',
          blocking_reason: 'The shared route must be registered first.',
        },
      ],
      terminal: 'incomplete',
    }],
    eligible_agent_count: 1,
    selected_agent: selectedAgent,
  }, {
    card_id: 89,
    board_id: 9,
    title: 'Ready follow-up',
    repository: '/work/orchestra',
    status: 'open',
    market_version: 1,
    priority: 10,
    constraints: {
      required_capabilities: ['typescript'],
      provider_constraints: [],
      model_constraints: [],
      access_needs: ['read_only'],
    },
    budgets: {
      tokens: null,
      cost_cents: null,
      time_seconds: null,
      retries: null,
      coordination_tokens: null,
      coordination_messages: null,
    },
    dependency_readiness: 'ready',
    dependencies: [],
    critical_path: [],
    eligible_agent_count: 0,
    selected_agent: null,
  }],
  graph: {
    nodes: [{
      card_id: 88,
      board_id: 9,
      title: 'Build Open Work',
      state: 'open',
      readiness: 'blocked',
      blocking_reasons: ['The shared route must be registered first.'],
    }, {
      card_id: 77,
      board_id: 9,
      title: 'Register shared route',
      state: 'in_progress',
      readiness: 'blocked',
      blocking_reasons: ['The shared route must be registered first.'],
    }],
    edges: [{
      from_card_id: 88,
      to_card_id: 77,
      blocking_reason: 'The shared route must be registered first.',
      completion_condition: 'card_done',
      readiness: 'blocked',
    }],
  },
}

const unusedClient = {} as OpenWorkClient
const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url))
const { createElement } = requireFromWeb('react') as {
  createElement: (component: unknown, props: Record<string, unknown>) => unknown
}
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string
}
const viewSource = readFileSync(
  new URL('../web/src/OpenWorkView.tsx', import.meta.url),
  'utf8',
)
const cssSource = readFileSync(
  new URL('../web/src/openWork.css', import.meta.url),
  'utf8',
)

describe('Open Work component contract', () => {
  it('server-renders the queue, dependency, contract, and match affordances safely', () => {
    const markup = renderToStaticMarkup(
      createElement(OpenWorkView, {
        client: unusedClient,
        initialData: openWorkResponse,
        initialSelectedCardId: 88,
        initialContract: contractEnvelope,
      }),
    )

    expect(markup).toContain('<h1 id="open-work-title">Open Work</h1>')
    expect(markup).toContain('Filter declared work')
    expect(markup).toContain('Dependency paths')
    expect(markup).toContain('Start is blocked')
    expect(markup).toContain('The shared route must be registered first.')
    expect(markup).toContain('Contract editor')
    expect(markup).toContain('Save draft')
    expect(markup).toContain('Generate backend preview')
    expect(markup).toContain('Publish contract')
    expect(markup).toContain('Match and start')
    expect(markup).toContain('Find eligible match')
    expect(markup).toContain('No provider or model fallback is applied.')
    expect(markup).toContain('Build &lt;img src=x onerror=alert(1)&gt; Open Work')
    expect(markup).toContain('Ship &lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;')
    expect(markup).not.toContain('<img src=x')
    expect(markup).not.toContain('<script>alert')
  })

  it('keeps unsafe workflow transitions locked in the component source contract', () => {
    expect(viewSource).not.toContain('dangerouslySetInnerHTML')
    expect(viewSource).toContain('disabled={readOnly || busy !== null || !editor.localReady || editor.dirty}')
    expect(viewSource).toContain('if (readOnly) return')
    expect(viewSource).toContain('setPreviewSourceMarketVersion(marketVersion)')
    expect(viewSource).toContain('Save this draft before generating a publish preview.')
    expect(viewSource).toContain('contractVersionIsStale(')
    expect(viewSource).toMatch(
      /catch \(error\) \{\s+const conflict = onConflict\(error\)\s+setMatch\(\{/,
    )
    expect(viewSource).toMatch(
      /catch \(error\) \{\s+const conflict = onConflict\(error\)\s+setDispatch\(/,
    )
    expect(viewSource).not.toContain('onDispatched')
    expect(viewSource).toContain('The realized result stays here until you explicitly refresh the queue.')
    expect(viewSource).toContain('onClick={onQueueRefresh}')
  })

  it('holds save and publish confirmations above the keyed editor remount', () => {
    const detailStart = viewSource.indexOf('function OpenWorkDetail(')
    const editorStart = viewSource.indexOf('function ContractEditor(')
    const detailSource = viewSource.slice(detailStart, editorStart)
    const editorSource = viewSource.slice(editorStart)

    expect(detailSource).toContain('const [actionNotice, setActionNotice]')
    expect(detailSource).toContain('{actionNotice && (')
    expect(detailSource).toContain('role="status"')
    expect(editorSource).toContain('onActionNotice(')
    expect(editorSource).toContain('Draft saved as contract v')
    expect(editorSource).toContain('Contract published at market version')
  })
})

describe('Open Work responsive style contract', () => {
  it('keeps functional text legible and phone controls reachable', () => {
    const pixelFontSizes = [...cssSource.matchAll(/font-size:\s*([0-9.]+)px/g)]
      .map((match) => Number(match[1]))
    expect(Math.min(...pixelFontSizes)).toBeGreaterThanOrEqual(10)

    const buttonBlock = cssSource.match(/\.ow-button\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(buttonBlock.match(/font-size:/g)).toHaveLength(1)
    expect(buttonBlock).toContain('font-size: 11px')

    expect(cssSource).toContain('@media (max-width: 767px)')
    expect(cssSource).toMatch(
      /@media \(max-width: 767px\)[\s\S]*\.ow-workbench,[\s\S]*grid-template-columns: minmax\(0, 1fr\)/,
    )
    expect(cssSource).toMatch(
      /@media \(max-width: 767px\)[\s\S]*\.open-work button \{ min-height: 44px; \}/,
    )
    expect(cssSource).toMatch(
      /@media \(max-width: 767px\)[\s\S]*\.ow-contract-actions \.ow-button,[\s\S]*min-height: 44px/,
    )
    expect(cssSource).toContain('overflow-x: hidden')
    expect(cssSource).toContain(':focus-visible')
    expect(cssSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(cssSource).not.toMatch(/gradient\(/i)
  })
})
