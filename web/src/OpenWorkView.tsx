import React, {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { OsIcon } from './OsIcon'
import {
  createDispatchIdempotencyKey,
  defaultOpenWorkFilters,
  openWorkApi,
  OpenWorkApiError,
  type BriefPreview,
  type ContractAccessNeed,
  type ContractDraft,
  type ContractEnvelope,
  type OpenWorkClient,
  type OpenWorkDispatch,
  type OpenWorkFilters,
  type OpenWorkGraph,
  type OpenWorkItem,
  type OpenWorkMatch,
  type OpenWorkResponse,
} from './openWorkApi'
import {
  activeFilterChips,
  capabilityOptions,
  contractDraftFromEnvelope,
  contractEditorStatus,
  contractVersionIsStale,
  createCriterion,
  createDeliverable,
  createDependencyRule,
  firstFieldError,
  formatCents,
  formatDuration,
  formatInteger,
  initialOpenWorkState,
  isMatchStale,
  mapBackendValidation,
  openWorkCounts,
  openWorkReducer,
  prepareContractDraft,
  reconcileRequiredArtifacts,
  repositoryOptions,
  safeRecordValue,
  splitListInput,
} from './openWorkPresentation'
import './openWork.css'

type OpenWorkViewProps = {
  client?: OpenWorkClient
  initialData?: OpenWorkResponse
  initialSelectedCardId?: number
  initialContract?: ContractEnvelope | null
}

type FilterFormState = {
  repository: string
  capabilities: string
  priority: string
  dependencyReadiness: '' | 'ready' | 'blocked'
  maxTokens: string
  maxCostCents: string
  maxTimeSeconds: string
}

type Resource<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: T | null
  error: string | null
  stale: boolean
}

const resource = <T,>(data: T | null = null): Resource<T> => ({
  status: data === null ? 'idle' : 'ready',
  data,
  error: null,
  stale: false,
})

const numberInput = (value: string): number | null =>
  value.trim() === '' ? null : Number(value)

const filterFormFromFilters = (filters: OpenWorkFilters): FilterFormState => ({
  repository: filters.repository,
  capabilities: filters.capabilities.join(', '),
  priority: filters.priority === null ? '' : String(filters.priority),
  dependencyReadiness: filters.dependencyReadiness ?? '',
  maxTokens: filters.maxTokens === null ? '' : String(filters.maxTokens),
  maxCostCents: filters.maxCostCents === null ? '' : String(filters.maxCostCents),
  maxTimeSeconds: filters.maxTimeSeconds === null ? '' : String(filters.maxTimeSeconds),
})

const filtersFromForm = (form: FilterFormState): OpenWorkFilters => ({
  repository: form.repository,
  capabilities: splitListInput(form.capabilities),
  priority: numberInput(form.priority),
  dependencyReadiness: form.dependencyReadiness || null,
  maxTokens: numberInput(form.maxTokens),
  maxCostCents: numberInput(form.maxCostCents),
  maxTimeSeconds: numberInput(form.maxTimeSeconds),
})

const messageFor = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const nullableNumber = (value: string) => value === '' ? null : Number(value)

export function OpenWorkView({
  client = openWorkApi,
  initialData,
  initialSelectedCardId,
  initialContract = null,
}: OpenWorkViewProps) {
  const [remote, dispatchRemote] = useReducer(
    openWorkReducer,
    initialData,
    initialOpenWorkState,
  )
  const [appliedFilters, setAppliedFilters] = useState<OpenWorkFilters>(
    defaultOpenWorkFilters,
  )
  const [filterForm, setFilterForm] = useState<FilterFormState>(() =>
    filterFormFromFilters(defaultOpenWorkFilters()))
  const [selectedCardId, setSelectedCardId] = useState<number | null>(
    initialSelectedCardId ?? initialData?.items[0]?.card_id ?? null,
  )
  const loadSequence = useRef(0)

  const load = useCallback(async (filters: OpenWorkFilters) => {
    const sequence = ++loadSequence.current
    dispatchRemote({ type: 'load' })
    try {
      const response = await client.list(filters)
      if (sequence === loadSequence.current) dispatchRemote({ type: 'loaded', response })
    } catch (error) {
      if (sequence === loadSequence.current) {
        dispatchRemote({ type: 'failed', error: messageFor(error) })
      }
    }
  }, [client])

  useEffect(() => {
    void load(appliedFilters)
  }, [appliedFilters, load])

  useEffect(() => {
    if (selectedCardId !== null && remote.items.some((item) => item.card_id === selectedCardId)) {
      return
    }
    setSelectedCardId(remote.items[0]?.card_id ?? null)
  }, [remote.items, selectedCardId])

  const selectedItem = remote.items.find((item) => item.card_id === selectedCardId) ?? null
  const counts = useMemo(() => openWorkCounts(remote.items), [remote.items])
  const chips = useMemo(() => activeFilterChips(appliedFilters), [appliedFilters])
  const repositories = useMemo(() => repositoryOptions(remote.items), [remote.items])
  const capabilities = useMemo(() => capabilityOptions(remote.items), [remote.items])

  const submitFilters = (event: FormEvent) => {
    event.preventDefault()
    setAppliedFilters(filtersFromForm(filterForm))
  }

  const clearFilters = () => {
    const cleared = defaultOpenWorkFilters()
    setFilterForm(filterFormFromFilters(cleared))
    setAppliedFilters(cleared)
  }

  return (
    <main className="open-work" aria-labelledby="open-work-title">
      <header className="ow-header">
        <div>
          <p className="ow-kicker">Operator queue</p>
          <h1 id="open-work-title">Open Work</h1>
          <p className="ow-intro">
            Inspect dependency-ready contracts, capacity evidence, and the exact agent identity
            before starting one job.
          </p>
        </div>
        <dl className="ow-counts" aria-label="Open Work counts">
          <div><dt>Visible</dt><dd>{counts.total}</dd></div>
          <div className="ready"><dt>Ready</dt><dd>{counts.ready}</dd></div>
          <div className="blocked"><dt>Blocked</dt><dd>{counts.blocked}</dd></div>
          <div><dt>Matched</dt><dd>{counts.matched}</dd></div>
        </dl>
      </header>

      <OpenWorkFilterForm
        form={filterForm}
        repositories={repositories}
        capabilities={capabilities}
        chips={chips}
        resultCount={counts.total}
        loading={remote.phase === 'loading'}
        onChange={setFilterForm}
        onSubmit={submitFilters}
        onClear={clearFilters}
      />

      {remote.stale && remote.error && (
        <div className="ow-state-banner stale" role="status">
          <OsIcon name="attention" />
          <div>
            <strong>Showing the last loaded queue</strong>
            <span>Refresh failed: {remote.error}</span>
          </div>
          <button type="button" onClick={() => void load(appliedFilters)}>
            <OsIcon name="refresh" size={14} /> Retry
          </button>
        </div>
      )}

      {remote.conflict && (
        <div className="ow-state-banner conflict" role="alert">
          <OsIcon name="attention" />
          <div><strong>Open Work changed</strong><span>{remote.conflict}</span></div>
          <button type="button" onClick={() => dispatchRemote({ type: 'clear-conflict' })}>
            Dismiss
          </button>
        </div>
      )}

      {remote.phase === 'loading' && remote.items.length === 0 && <OpenWorkSkeleton />}
      {remote.phase === 'error' && (
        <OpenWorkFailure error={remote.error ?? 'Open Work could not load.'}
          onRetry={() => void load(appliedFilters)} />
      )}
      {remote.phase === 'ready' && remote.items.length === 0 && (
        <OpenWorkEmpty filtered={chips.length > 0} onClear={clearFilters} />
      )}
      {remote.items.length > 0 && (
        <div className="ow-workbench" aria-busy={remote.phase === 'loading'}>
          <OpenWorkList
            items={remote.items}
            selectedCardId={selectedCardId}
            onSelect={setSelectedCardId}
          />
          {selectedItem && (
            <OpenWorkDetail
              key={selectedItem.card_id}
              item={selectedItem}
              graph={remote.graph}
              client={client}
              initialContract={initialContract?.contract.card_id === selectedItem.card_id
                ? initialContract
                : null}
              onRefresh={() => void load(appliedFilters)}
              onConflict={(error) => dispatchRemote({ type: 'conflict', error })}
            />
          )}
        </div>
      )}
    </main>
  )
}

function OpenWorkFilterForm({
  form,
  repositories,
  capabilities,
  chips,
  resultCount,
  loading,
  onChange,
  onSubmit,
  onClear,
}: {
  form: FilterFormState
  repositories: string[]
  capabilities: string[]
  chips: ReturnType<typeof activeFilterChips>
  resultCount: number
  loading: boolean
  onChange: (next: FilterFormState) => void
  onSubmit: (event: FormEvent) => void
  onClear: () => void
}) {
  return (
    <section className="ow-filter-shell" aria-labelledby="ow-filter-title">
      <div className="ow-filter-heading">
        <div>
          <p>Queue lens</p>
          <h2 id="ow-filter-title">Filter declared work</h2>
        </div>
        <span aria-live="polite">{resultCount} result{resultCount === 1 ? '' : 's'}</span>
      </div>
      <form className="ow-filters" onSubmit={onSubmit}>
        <label>
          <span>Repository</span>
          <input
            list="ow-repositories"
            value={form.repository}
            onChange={(event) => onChange({ ...form, repository: event.currentTarget.value })}
            placeholder="All repositories"
          />
          <datalist id="ow-repositories">
            {repositories.map((repository) => <option key={repository} value={repository} />)}
          </datalist>
        </label>
        <label>
          <span>Capabilities</span>
          <input
            list="ow-capabilities"
            value={form.capabilities}
            onChange={(event) => onChange({ ...form, capabilities: event.currentTarget.value })}
            placeholder="typescript, sqlite"
          />
          <datalist id="ow-capabilities">
            {capabilities.map((capability) => <option key={capability} value={capability} />)}
          </datalist>
        </label>
        <label>
          <span>Priority</span>
          <input
            type="number"
            step="1"
            value={form.priority}
            onChange={(event) => onChange({ ...form, priority: event.currentTarget.value })}
            placeholder="Any"
          />
        </label>
        <label>
          <span>Dependency readiness</span>
          <select
            value={form.dependencyReadiness}
            onChange={(event) => onChange({
              ...form,
              dependencyReadiness: event.currentTarget.value as FilterFormState['dependencyReadiness'],
            })}
          >
            <option value="">Ready and blocked</option>
            <option value="ready">Ready only</option>
            <option value="blocked">Blocked only</option>
          </select>
        </label>
        <label>
          <span>Max tokens</span>
          <input
            type="number"
            min="0"
            step="1"
            value={form.maxTokens}
            onChange={(event) => onChange({ ...form, maxTokens: event.currentTarget.value })}
            placeholder="No ceiling"
          />
        </label>
        <label>
          <span>Max cost (cents)</span>
          <input
            type="number"
            min="0"
            step="1"
            value={form.maxCostCents}
            onChange={(event) => onChange({ ...form, maxCostCents: event.currentTarget.value })}
            placeholder="No ceiling"
          />
        </label>
        <label>
          <span>Max time (seconds)</span>
          <input
            type="number"
            min="0"
            step="1"
            value={form.maxTimeSeconds}
            onChange={(event) => onChange({ ...form, maxTimeSeconds: event.currentTarget.value })}
            placeholder="No ceiling"
          />
        </label>
        <div className="ow-filter-actions">
          <button type="submit" className="ow-button primary" disabled={loading}>
            <OsIcon name="search" size={14} /> {loading ? 'Applying' : 'Apply filters'}
          </button>
          <button type="button" className="ow-button" onClick={onClear} disabled={!chips.length}>
            Clear
          </button>
        </div>
      </form>
      <div className="ow-filter-chips" aria-label="Active filters">
        {chips.length
          ? chips.map((chip) => (
              <span key={chip.key}><b>{chip.label}</b>{chip.value}</span>
            ))
          : <span className="empty">No filters applied</span>}
      </div>
    </section>
  )
}

function OpenWorkList({
  items,
  selectedCardId,
  onSelect,
}: {
  items: OpenWorkItem[]
  selectedCardId: number | null
  onSelect: (cardId: number) => void
}) {
  return (
    <aside className="ow-list-panel" aria-labelledby="ow-list-title">
      <header>
        <div><p>Stable queue order</p><h2 id="ow-list-title">Contracts</h2></div>
        <span>{items.length}</span>
      </header>
      <ol className="ow-list">
        {items.map((item) => {
          const selected = item.card_id === selectedCardId
          return (
            <li key={item.card_id}>
              <button
                type="button"
                className={selected ? 'selected' : ''}
                aria-current={selected ? 'true' : undefined}
                onClick={() => onSelect(item.card_id)}
              >
                <span className={`ow-readiness ${item.dependency_readiness}`}>
                  {item.dependency_readiness}
                </span>
                <strong>{item.title}</strong>
                <code>#{item.card_id} · market v{item.market_version}</code>
                <span className="ow-repository" title={item.repository}>{item.repository}</span>
                <span className="ow-list-facts">
                  <b>Priority {item.priority}</b>
                  <b>{item.eligible_agent_count} eligible</b>
                  {item.selected_agent && <b>{item.selected_agent.name}</b>}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}

function OpenWorkDetail({
  item,
  graph,
  client,
  initialContract,
  onRefresh,
  onConflict,
}: {
  item: OpenWorkItem
  graph: OpenWorkGraph
  client: OpenWorkClient
  initialContract: ContractEnvelope | null
  onRefresh: () => void
  onConflict: (error: string) => void
}) {
  const [contract, setContract] = useState<Resource<ContractEnvelope>>(
    () => resource(initialContract),
  )
  const [conflict, setConflict] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const versionStale = contractVersionIsStale(
    contract.data?.job_market.market_version ?? null,
    item.market_version,
  )

  const loadContract = useCallback(async () => {
    setContract((current) => ({
      status: 'loading',
      data: current.data,
      error: null,
      stale: contractVersionIsStale(
        current.data?.job_market.market_version ?? null,
        item.market_version,
      ),
    }))
    try {
      const loaded = await client.getContract(item.card_id)
      setContract({ status: 'ready', data: loaded, error: null, stale: false })
      setConflict(null)
    } catch (error) {
      setContract((current) => current.data
        ? { ...current, status: 'ready', error: messageFor(error), stale: true }
        : { status: 'error', data: null, error: messageFor(error), stale: false })
    }
  }, [client, item.card_id, item.market_version])

  useEffect(() => {
    void loadContract()
  }, [loadContract])

  const handleConflict = (error: unknown) => {
    if (error instanceof OpenWorkApiError && error.status === 409) {
      const message = `${error.message} Reload the server version, review your edits, then preview and confirm again.`
      setConflict(message)
      setActionNotice(null)
      onConflict(message)
      return true
    }
    return false
  }

  return (
    <article className="ow-detail" aria-labelledby={`ow-detail-${item.card_id}`}>
      <header className="ow-detail-header">
        <div>
          <p>{item.repository}</p>
          <h2 id={`ow-detail-${item.card_id}`}>{item.title}</h2>
          <span>
            Card #{item.card_id} · {item.status} · market version {item.market_version}
          </span>
        </div>
        <div className="ow-detail-actions">
          <span className={`ow-readiness ${item.dependency_readiness}`}>
            {item.dependency_readiness}
          </span>
          <button type="button" className="ow-icon-button" onClick={onRefresh}
            aria-label="Refresh Open Work">
            <OsIcon name="refresh" />
          </button>
        </div>
      </header>

      {conflict && (
        <div className="ow-conflict-remediation" role="alert">
          <OsIcon name="attention" />
          <div>
            <strong>Stale operator state</strong>
            <p>{conflict}</p>
          </div>
          <button type="button" onClick={() => void loadContract()}>
            Discard local edits and reload
          </button>
          <button type="button" onClick={() => setConflict(null)}>Keep editing</button>
        </div>
      )}
      {contract.stale && contract.error && (
        <div className="ow-state-banner stale" role="status">
          <OsIcon name="attention" />
          <div><strong>Contract may be stale</strong><span>{contract.error}</span></div>
          <button type="button" onClick={() => void loadContract()}>Retry</button>
        </div>
      )}
      {versionStale && (
        <div className="ow-state-banner conflict" role="alert">
          <OsIcon name="attention" />
          <div>
            <strong>Contract version changed</strong>
            <span>
              Queue market v{item.market_version} does not match the cached contract.
              Editing and matching stay locked while the server version reloads.
            </span>
          </div>
          <button type="button" onClick={() => void loadContract()}>Reload contract</button>
        </div>
      )}
      {actionNotice && (
        <div className="ow-inline-notice ow-action-confirmation" role="status">
          {actionNotice}
        </div>
      )}

      <DependencyPanel item={item} graph={graph} />

      {contract.status === 'loading' && !contract.data && <ContractSkeleton />}
      {contract.status === 'error' && (
        <OpenWorkFailure error={contract.error ?? 'Contract could not load.'}
          onRetry={() => void loadContract()} compact />
      )}
      {contract.data && !versionStale && (
        <>
          <ContractEditor
            key={`${contract.data.contract.version}:${contract.data.job_market.market_version}`}
            envelope={contract.data}
            client={client}
            onEnvelope={(next) => {
              setContract({ status: 'ready', data: next, error: null, stale: false })
              setConflict(null)
              onRefresh()
            }}
            onConflict={handleConflict}
            onActionNotice={setActionNotice}
          />
          <AssignmentPanel
            item={item}
            marketVersion={contract.data.job_market.market_version}
            client={client}
            onConflict={handleConflict}
            onQueueRefresh={onRefresh}
          />
        </>
      )}
    </article>
  )
}

function DependencyPanel({ item, graph }: { item: OpenWorkItem; graph: OpenWorkGraph }) {
  const relevantIds = new Set([
    item.card_id,
    ...item.dependencies.map((dependency) => dependency.card_id),
    ...item.critical_path.flatMap((path) => path.path.map((node) => node.card_id)),
  ])
  const nodes = graph.nodes.filter((node) => relevantIds.has(node.card_id))
  const edges = graph.edges.filter((edge) =>
    relevantIds.has(edge.from_card_id) && relevantIds.has(edge.to_card_id))

  return (
    <section className="ow-section ow-dependencies" aria-labelledby={`ow-dependencies-${item.card_id}`}>
      <header className="ow-section-heading">
        <div>
          <p>Execution order</p>
          <h3 id={`ow-dependencies-${item.card_id}`}>Dependency paths</h3>
        </div>
        <span>{item.dependencies.length} direct · {item.critical_path.length} critical</span>
      </header>

      {item.dependency_readiness === 'ready' ? (
        <div className="ow-clear-state" role="status">
          <OsIcon name="check" />
          <div><strong>Dependencies are ready</strong><span>No critical-path blocker is active.</span></div>
        </div>
      ) : (
        <div className="ow-blocked-state" role="status">
          <OsIcon name="attention" />
          <div>
            <strong>Start is blocked</strong>
            <span>Resolve every explicit critical path before matching capacity.</span>
          </div>
        </div>
      )}

      <div className="ow-graph" aria-label={`Dependency graph for ${item.title}`}>
        <ol className="ow-graph-nodes" aria-label="Dependency nodes">
          {nodes.map((node) => (
            <li key={node.card_id} className={node.readiness}>
              <span><b>#{node.card_id}</b>{node.state}</span>
              <strong>{node.title}</strong>
              {node.blocking_reasons.map((reason) => <p key={reason}>{reason}</p>)}
            </li>
          ))}
        </ol>
        {edges.length > 0 && (
          <ol className="ow-graph-edges" aria-label="Dependency edges">
            {edges.map((edge) => (
              <li key={`${edge.from_card_id}:${edge.to_card_id}`}>
                <code>#{edge.from_card_id}</code>
                <OsIcon name="chevron" size={13} />
                <code>#{edge.to_card_id}</code>
                <span>{edge.blocking_reason}</span>
                <b>{edge.readiness}</b>
              </li>
            ))}
          </ol>
        )}
      </div>

      {item.critical_path.length > 0 && (
        <div className="ow-critical-paths">
          <h4>Critical-path blockers</h4>
          <ol>
            {item.critical_path.map((critical, index) => (
              <li key={`${critical.path.map((node) => node.card_id).join(':')}:${critical.terminal}`}>
                <span>Path {index + 1} · {critical.terminal}</span>
                <ol>
                  {critical.path.map((node) => (
                    <li key={node.card_id}>
                      <b>#{node.card_id}</b>
                      <strong>{node.title}</strong>
                      <span>{node.state}</span>
                      {node.blocking_reason && <p>{node.blocking_reason}</p>}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

function ContractEditor({
  envelope,
  client,
  onEnvelope,
  onConflict,
  onActionNotice,
}: {
  envelope: ContractEnvelope
  client: OpenWorkClient
  onEnvelope: (next: ContractEnvelope) => void
  onConflict: (error: unknown) => boolean
  onActionNotice: (message: string | null) => void
}) {
  const [draft, setDraft] = useState<ContractDraft>(() => contractDraftFromEnvelope(envelope))
  const [draftRevision, setDraftRevision] = useState(0)
  const [previewRevision, setPreviewRevision] = useState(-1)
  const [previewSourceMarketVersion, setPreviewSourceMarketVersion] =
    useState<number | null>(null)
  const [preview, setPreview] = useState<BriefPreview | null>(null)
  const [busy, setBusy] = useState<'save' | 'preview' | 'publish' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const marketVersion = envelope.job_market.market_version
  const editor = contractEditorStatus(
    draft,
    preview,
    previewSourceMarketVersion,
    marketVersion,
    draftRevision,
    previewRevision,
  )
  const backendErrors = preview ? mapBackendValidation(preview.validation) : {}

  const mutate = (change: (current: ContractDraft) => ContractDraft) => {
    setDraft(change)
    setDraftRevision((current) => current + 1)
    setPreview(null)
    setPreviewRevision(-1)
    setPreviewSourceMarketVersion(null)
    setNotice(null)
    setError(null)
    onActionNotice(null)
  }

  const run = async (action: 'save' | 'preview' | 'publish') => {
    setError(null)
    setNotice(null)
    if (!editor.localReady) {
      setError('Resolve the inline contract errors before continuing.')
      return
    }
    if (action === 'preview' && editor.dirty) {
      setError('Save this draft before generating a publish preview.')
      return
    }
    const prepared = prepareContractDraft(draft)
    setBusy(action)
    try {
      if (action === 'save') {
        const next = await client.updateContract(envelope.contract.card_id, prepared, marketVersion)
        setDraft(contractDraftFromEnvelope(next))
        setDraftRevision(0)
        setPreview(null)
        setPreviewRevision(-1)
        setPreviewSourceMarketVersion(null)
        onActionNotice(
          `Draft saved as contract v${next.contract.version}, market v${next.job_market.market_version}.`,
        )
        onEnvelope(next)
      } else if (action === 'preview') {
        const next = await client.previewBrief(
          envelope.contract.card_id,
          prepared,
          marketVersion,
        )
        setPreview(next)
        setPreviewRevision(draftRevision)
        setPreviewSourceMarketVersion(marketVersion)
        setNotice(next.validation.valid
          ? 'Backend preview is current for this draft.'
          : 'Backend preview returned validation gaps.')
      } else {
        if (!editor.publishReady) {
          setError('Generate a current, valid backend preview before publishing.')
          return
        }
        const next = await client.publishContract(envelope.contract.card_id, marketVersion)
        onActionNotice(`Contract published at market version ${next.job_market.market_version}.`)
        onEnvelope(next)
      }
    } catch (caught) {
      if (!onConflict(caught)) setError(messageFor(caught))
    } finally {
      setBusy(null)
    }
  }

  const fieldError = (field: string) =>
    firstFieldError(editor.localErrors, field) ?? firstFieldError(backendErrors, field)

  return (
    <section className="ow-section ow-contract" aria-labelledby={`ow-contract-${envelope.contract.card_id}`}>
      <header className="ow-section-heading">
        <div>
          <p>Typed request</p>
          <h3 id={`ow-contract-${envelope.contract.card_id}`}>Contract editor</h3>
        </div>
        <span>contract v{envelope.contract.version} · market v{marketVersion}</span>
      </header>

      <div className="ow-editor-readiness" aria-live="polite">
        <span className={editor.localReady ? 'ready' : 'blocked'}>
          {editor.localReady ? 'Local fields ready' : 'Local validation gaps'}
        </span>
        <span className={editor.dirty ? 'blocked' : 'ready'}>
          {editor.dirty ? 'Unsaved edits' : 'Draft saved'}
        </span>
        <span className={editor.previewCurrent ? 'ready' : 'muted'}>
          {editor.previewCurrent ? 'Backend preview current' : 'Preview required'}
        </span>
        <span className={editor.publishReady ? 'ready' : 'muted'}>
          {editor.publishReady ? 'Publish ready' : 'Publish locked'}
        </span>
      </div>

      {error && <div className="ow-inline-error" role="alert">{error}</div>}
      {notice && <div className="ow-inline-notice" role="status">{notice}</div>}

      <form className="ow-contract-form" onSubmit={(event) => {
        event.preventDefault()
        void run('save')
      }}>
        <fieldset>
          <legend>Scope</legend>
          <div className="ow-form-grid two">
            <label className="wide">
              <span>Objective</span>
              <textarea
                rows={4}
                value={draft.objective}
                aria-invalid={Boolean(fieldError('objective'))}
                onChange={(event) => mutate((current) => ({
                  ...current,
                  objective: event.currentTarget.value,
                }))}
              />
              {fieldError('objective') && <small className="error">{fieldError('objective')}</small>}
            </label>
            <label>
              <span>Base reference</span>
              <input
                value={draft.base_ref ?? ''}
                onChange={(event) => mutate((current) => ({
                  ...current,
                  base_ref: event.currentTarget.value || null,
                }))}
                placeholder="HEAD"
              />
            </label>
            <label>
              <span>Priority</span>
              <input
                type="number"
                step="1"
                value={draft.priority}
                aria-invalid={Boolean(fieldError('priority'))}
                onChange={(event) => mutate((current) => ({
                  ...current,
                  priority: Number(event.currentTarget.value),
                }))}
              />
              {fieldError('priority') && <small className="error">{fieldError('priority')}</small>}
            </label>
            <LineListField
              label="Verification commands"
              value={draft.verify_commands}
              onChange={(verify_commands) => mutate((current) => ({ ...current, verify_commands }))}
            />
            <LineListField
              label="Non-goals"
              value={draft.non_goals}
              onChange={(non_goals) => mutate((current) => ({ ...current, non_goals }))}
            />
            <LineListField
              label="Risks"
              value={draft.risks}
              onChange={(risks) => mutate((current) => ({ ...current, risks }))}
            />
          </div>
        </fieldset>

        <fieldset>
          <legend>Deliverables</legend>
          {fieldError('deliverables') && <p className="ow-fieldset-error">{fieldError('deliverables')}</p>}
          <ol className="ow-editor-records">
            {draft.deliverables.map((deliverable, index) => {
              const field = `deliverables.${deliverable.id || index}`
              return (
                <li key={deliverable.id || `deliverable-${index}`}>
                  <header>
                    <code>{deliverable.id || 'ID required'}</code>
                    <label className="ow-check">
                      <input
                        type="checkbox"
                        checked={deliverable.required}
                        onChange={(event) => mutate((current) => ({
                          ...current,
                          deliverables: current.deliverables.map((item) =>
                            item.id === deliverable.id
                              ? { ...item, required: event.currentTarget.checked }
                              : item),
                        }))}
                      />
                      <span>Required</span>
                    </label>
                    <button type="button" className="ow-text-button"
                      disabled={draft.deliverables.length === 1}
                      onClick={() => mutate((current) => ({
                        ...current,
                        deliverables: current.deliverables.filter((item) => item.id !== deliverable.id),
                        acceptance_criteria: current.acceptance_criteria.map((criterion) => ({
                          ...criterion,
                          deliverable_ids: criterion.deliverable_ids.filter((id) => id !== deliverable.id),
                        })),
                      }))}>
                      Remove
                    </button>
                  </header>
                  <label>
                    <span>Deliverable description</span>
                    <textarea
                      rows={2}
                      value={deliverable.text}
                      aria-invalid={Boolean(fieldError(`${field}.text`))}
                      onChange={(event) => mutate((current) => ({
                        ...current,
                        deliverables: current.deliverables.map((item) =>
                          item.id === deliverable.id
                            ? { ...item, text: event.currentTarget.value }
                            : item),
                      }))}
                    />
                    {fieldError(`${field}.text`) && (
                      <small className="error">{fieldError(`${field}.text`)}</small>
                    )}
                  </label>
                </li>
              )
            })}
          </ol>
          <button type="button" className="ow-add-button"
            onClick={() => mutate((current) => ({
              ...current,
              deliverables: [...current.deliverables, createDeliverable(current)],
            }))}>
            <OsIcon name="plus" size={13} /> Add deliverable
          </button>
        </fieldset>

        <fieldset>
          <legend>Acceptance criteria</legend>
          {fieldError('criteria') && <p className="ow-fieldset-error">{fieldError('criteria')}</p>}
          <ol className="ow-editor-records criteria">
            {draft.acceptance_criteria.map((criterion, index) => (
              <CriterionEditor
                key={criterion.id || `criterion-${index}`}
                criterion={criterion}
                index={index}
                deliverables={draft.deliverables}
                errors={editor.localErrors}
                onChange={(next) => mutate((current) => ({
                  ...current,
                  acceptance_criteria: current.acceptance_criteria.map((item) =>
                    item.id === criterion.id ? next : item),
                }))}
                onRemove={() => mutate((current) => ({
                  ...current,
                  acceptance_criteria: current.acceptance_criteria.filter((item) =>
                    item.id !== criterion.id),
                }))}
              />
            ))}
          </ol>
          <button type="button" className="ow-add-button"
            onClick={() => mutate((current) => ({
              ...current,
              acceptance_criteria: [...current.acceptance_criteria, createCriterion(current)],
            }))}>
            <OsIcon name="plus" size={13} /> Add criterion
          </button>
        </fieldset>

        <fieldset>
          <legend>Dependencies</legend>
          {fieldError('dependencies') && <p className="ow-fieldset-error">{fieldError('dependencies')}</p>}
          <ol className="ow-editor-records dependencies">
            {draft.dependency_rules.map((dependency, index) => {
              const field = `dependencies.${dependency.card_id || index}`
              return (
                <li key={`${dependency.card_id || 'new'}:${index}`}>
                  <header>
                    <code>{dependency.card_id > 0 ? `card #${dependency.card_id}` : 'New dependency'}</code>
                    <button type="button" className="ow-text-button"
                      onClick={() => mutate((current) => ({
                        ...current,
                        dependency_rules: current.dependency_rules.filter((_, itemIndex) =>
                          itemIndex !== index),
                      }))}>
                      Remove
                    </button>
                  </header>
                  <div className="ow-form-grid two">
                    <label>
                      <span>Dependency card ID</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={dependency.card_id || ''}
                        aria-invalid={Boolean(fieldError(`${field}.card_id`))}
                        onChange={(event) => mutate((current) => ({
                          ...current,
                          dependency_rules: current.dependency_rules.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, card_id: Number(event.currentTarget.value) }
                              : item),
                        }))}
                      />
                      {fieldError(`${field}.card_id`) && (
                        <small className="error">{fieldError(`${field}.card_id`)}</small>
                      )}
                    </label>
                    <label>
                      <span>Completion condition</span>
                      <input value="card_done" readOnly aria-readonly="true" />
                    </label>
                    <label className="wide">
                      <span>Blocking reason</span>
                      <textarea
                        rows={2}
                        value={dependency.blocking_reason}
                        aria-invalid={Boolean(fieldError(`${field}.blocking_reason`))}
                        onChange={(event) => mutate((current) => ({
                          ...current,
                          dependency_rules: current.dependency_rules.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, blocking_reason: event.currentTarget.value }
                              : item),
                        }))}
                      />
                      {fieldError(`${field}.blocking_reason`) && (
                        <small className="error">{fieldError(`${field}.blocking_reason`)}</small>
                      )}
                    </label>
                  </div>
                </li>
              )
            })}
          </ol>
          <button type="button" className="ow-add-button"
            onClick={() => mutate((current) => ({
              ...current,
              dependency_rules: [...current.dependency_rules, createDependencyRule()],
            }))}>
            <OsIcon name="plus" size={13} /> Add dependency
          </button>
        </fieldset>

        <fieldset>
          <legend>Constraints and budgets</legend>
          <div className="ow-form-grid two">
            <LineListField
              label="Required capabilities"
              value={draft.required_capabilities}
              error={fieldError('constraints')}
              onChange={(required_capabilities) => mutate((current) => ({
                ...current,
                required_capabilities,
              }))}
            />
            <LineListField
              label="Allowed providers"
              value={draft.provider_constraints}
              onChange={(provider_constraints) => mutate((current) => ({
                ...current,
                provider_constraints,
              }))}
            />
            <LineListField
              label="Allowed models"
              value={draft.model_constraints}
              onChange={(model_constraints) => mutate((current) => ({
                ...current,
                model_constraints,
              }))}
            />
            <div className="ow-access-field">
              <span>Access needs</span>
              <div>
                {([
                  ['read_only', 'Read only'],
                  ['workspace_write', 'Workspace write'],
                  ['full_access', 'Full access'],
                ] as Array<[ContractAccessNeed, string]>).map(([value, label]) => (
                  <label className="ow-check" key={value}>
                    <input
                      type="checkbox"
                      checked={draft.access_needs.includes(value)}
                      onChange={(event) => mutate((current) => ({
                        ...current,
                        access_needs: event.currentTarget.checked
                          ? [...new Set([...current.access_needs, value])]
                          : current.access_needs.filter((item) => item !== value),
                      }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="ow-budget-grid">
            <BudgetField label="Token budget" field="budget_tokens" draft={draft} mutate={mutate}
              error={fieldError('budgets.budget_tokens') ?? fieldError('budgets')} />
            <BudgetField label="Cost budget (cents)" field="budget_cents" draft={draft} mutate={mutate}
              error={fieldError('budgets.budget_cents')} />
            <BudgetField label="Time budget (seconds)" field="budget_time_seconds" draft={draft} mutate={mutate}
              error={fieldError('budgets.budget_time_seconds')} />
            <BudgetField label="Retry budget" field="budget_retries" draft={draft} mutate={mutate}
              error={fieldError('budgets.budget_retries')} allowZero />
            <BudgetField label="Coordination tokens" field="budget_coordination_tokens" draft={draft} mutate={mutate}
              error={fieldError('budgets.budget_coordination_tokens')} />
            <BudgetField label="Coordination messages" field="budget_coordination_messages" draft={draft} mutate={mutate}
              error={fieldError('budgets.budget_coordination_messages')} />
          </div>
        </fieldset>

        {backendErrors.warnings?.length > 0 && (
          <div className="ow-validation-summary" role="status">
            <strong>Backend warnings</strong>
            <ul>{backendErrors.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </div>
        )}
        {backendErrors.form?.length > 0 && (
          <div className="ow-validation-summary error" role="alert">
            <strong>Backend validation</strong>
            <ul>{backendErrors.form.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        )}

        <footer className="ow-contract-actions">
          <button type="submit" className="ow-button" disabled={busy !== null || !editor.localReady}>
            {busy === 'save' ? 'Saving' : 'Save draft'}
          </button>
          <button type="button" className="ow-button"
            disabled={busy !== null || !editor.localReady || editor.dirty}
            onClick={() => void run('preview')}>
            <OsIcon name="evidence" size={14} />
            {busy === 'preview' ? 'Generating' : 'Generate backend preview'}
          </button>
          <button type="button" className="ow-button primary"
            disabled={busy !== null || !editor.publishReady}
            onClick={() => void run('publish')}>
            {busy === 'publish' ? 'Publishing' : 'Publish contract'}
          </button>
        </footer>
      </form>

      {preview && (
        <BriefPanel
          title="Backend-generated draft brief"
          brief={preview.agent_brief}
          digest={preview.agent_brief_sha256}
          realized={false}
          stale={!editor.previewCurrent}
        />
      )}
    </section>
  )
}

function CriterionEditor({
  criterion,
  index,
  deliverables,
  errors,
  onChange,
  onRemove,
}: {
  criterion: ContractDraft['acceptance_criteria'][number]
  index: number
  deliverables: ContractDraft['deliverables']
  errors: Record<string, string[]>
  onChange: (next: ContractDraft['acceptance_criteria'][number]) => void
  onRemove: () => void
}) {
  const field = `criteria.${criterion.id || index}`
  const error = (suffix: string) => firstFieldError(errors, `${field}.${suffix}`)
    ?? (suffix === '' ? firstFieldError(errors, field) : null)
  return (
    <li>
      <header>
        <code>{criterion.id || 'ID required'}</code>
        <label className="ow-check">
          <input type="checkbox" checked={criterion.required}
            onChange={(event) => onChange({ ...criterion, required: event.currentTarget.checked })} />
          <span>Required</span>
        </label>
        <button type="button" className="ow-text-button" onClick={onRemove}>Remove</button>
      </header>
      {error('') && <p className="ow-fieldset-error">{error('')}</p>}
      <div className="ow-form-grid two">
        <label className="wide">
          <span>Criterion</span>
          <textarea rows={2} value={criterion.text}
            aria-invalid={Boolean(error('text'))}
            onChange={(event) => onChange({ ...criterion, text: event.currentTarget.value })} />
          {error('text') && <small className="error">{error('text')}</small>}
        </label>
        <label className="wide">
          <span>Verification description</span>
          <textarea rows={2} value={criterion.description}
            aria-invalid={Boolean(error('description'))}
            onChange={(event) => onChange({ ...criterion, description: event.currentTarget.value })} />
          {error('description') && <small className="error">{error('description')}</small>}
        </label>
        <label>
          <span>Verifier</span>
          <select value={criterion.verifier.kind}
            onChange={(event) => onChange({
              ...criterion,
              verifier: { kind: event.currentTarget.value as typeof criterion.verifier.kind },
            })}>
            <option value="command">Command</option>
            <option value="artifact">Artifact</option>
            <option value="human">Human review</option>
            <option value="custom">Custom instructions</option>
          </select>
        </label>
        <label>
          <span>Criterion priority (-1000 to 1000)</span>
          <input type="number" min="-1000" max="1000" step="1" value={criterion.priority}
            aria-invalid={Boolean(error('priority'))}
            onChange={(event) => onChange({ ...criterion, priority: Number(event.currentTarget.value) })} />
          {error('priority') && <small className="error">{error('priority')}</small>}
        </label>
        {criterion.verifier.kind === 'command' && (
          <label className="wide">
            <span>Exact verifier command</span>
            <input value={criterion.verifier.command ?? ''}
              aria-invalid={Boolean(error('verifier'))}
              onChange={(event) => onChange({
                ...criterion,
                verifier: { ...criterion.verifier, command: event.currentTarget.value },
              })} />
            {error('verifier') && <small className="error">{error('verifier')}</small>}
          </label>
        )}
        {criterion.verifier.kind === 'artifact' && (
          <label className="wide">
            <span>Artifact kind</span>
            <input value={criterion.verifier.artifact_kind ?? ''}
              aria-invalid={Boolean(error('verifier'))}
              onChange={(event) => onChange({
                ...criterion,
                verifier: { ...criterion.verifier, artifact_kind: event.currentTarget.value },
              })} />
            {error('verifier') && <small className="error">{error('verifier')}</small>}
          </label>
        )}
        {(criterion.verifier.kind === 'custom' || criterion.verifier.kind === 'human') && (
          <label className="wide">
            <span>Verifier instructions</span>
            <textarea rows={2} value={criterion.verifier.instructions ?? ''}
              onChange={(event) => onChange({
                ...criterion,
                verifier: { ...criterion.verifier, instructions: event.currentTarget.value },
              })} />
          </label>
        )}
        <label>
          <span>Owner</span>
          <input value={criterion.owner ?? ''} placeholder="Unassigned"
            onChange={(event) => onChange({
              ...criterion,
              owner: event.currentTarget.value || null,
            })} />
        </label>
        <label>
          <span>Required artifact kinds</span>
          <input value={criterion.required_artifacts.map((artifact) => artifact.kind).join(', ')}
            onChange={(event) => onChange({
              ...criterion,
              required_artifacts: reconcileRequiredArtifacts(
                criterion.required_artifacts,
                event.currentTarget.value,
              ),
            })} />
        </label>
        <div className="ow-deliverable-links wide">
          <span>Linked deliverables</span>
          <div>
            {deliverables.map((deliverable) => (
              <label className="ow-check" key={deliverable.id}>
                <input type="checkbox"
                  checked={criterion.deliverable_ids.includes(deliverable.id)}
                  onChange={(event) => onChange({
                    ...criterion,
                    deliverable_ids: event.currentTarget.checked
                      ? [...new Set([...criterion.deliverable_ids, deliverable.id])]
                      : criterion.deliverable_ids.filter((id) => id !== deliverable.id),
                  })} />
                <span>{deliverable.id}</span>
              </label>
            ))}
          </div>
          {error('deliverable_ids') && <small className="error">{error('deliverable_ids')}</small>}
        </div>
      </div>
    </li>
  )
}

type BudgetFieldName =
  | 'budget_tokens'
  | 'budget_cents'
  | 'budget_time_seconds'
  | 'budget_retries'
  | 'budget_coordination_tokens'
  | 'budget_coordination_messages'

function BudgetField({
  label,
  field,
  draft,
  mutate,
  error,
  allowZero = false,
}: {
  label: string
  field: BudgetFieldName
  draft: ContractDraft
  mutate: (change: (current: ContractDraft) => ContractDraft) => void
  error: string | null
  allowZero?: boolean
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={allowZero ? 0 : 1}
        step="1"
        value={draft[field] ?? ''}
        aria-invalid={Boolean(error)}
        onChange={(event) => mutate((current) => ({
          ...current,
          [field]: nullableNumber(event.currentTarget.value),
        }))}
      />
      {error && <small className="error">{error}</small>}
    </label>
  )
}

function LineListField({
  label,
  value,
  error = null,
  onChange,
}: {
  label: string
  value: string[]
  error?: string | null
  onChange: (next: string[]) => void
}) {
  return (
    <label>
      <span>{label}</span>
      <textarea
        rows={3}
        value={value.join('\n')}
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.currentTarget.value.split('\n'))}
      />
      <small>One value per line.</small>
      {error && <small className="error">{error}</small>}
    </label>
  )
}

function AssignmentPanel({
  item,
  marketVersion,
  client,
  onConflict,
  onQueueRefresh,
}: {
  item: OpenWorkItem
  marketVersion: number
  client: OpenWorkClient
  onConflict: (error: unknown) => boolean
  onQueueRefresh: () => void
}) {
  const [match, setMatch] = useState<Resource<OpenWorkMatch>>(resource())
  const [dispatch, setDispatch] = useState<Resource<OpenWorkDispatch>>(resource())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null)
  const stale = isMatchStale(match.data?.market_version ?? null, {
    ...item,
    market_version: marketVersion,
  })

  const findMatch = async () => {
    setMatch({ status: 'loading', data: null, error: null, stale: false })
    setDispatch(resource())
    setConfirmOpen(false)
    setConfirmed(false)
    setIdempotencyKey(null)
    try {
      const next = await client.match(item.card_id, marketVersion)
      setMatch({ status: 'ready', data: next, error: null, stale: false })
    } catch (error) {
      const conflict = onConflict(error)
      setMatch({
        status: 'error',
        data: null,
        error: conflict
          ? 'The match was rejected because operator state changed. Reload before matching again.'
          : messageFor(error),
        stale: false,
      })
    }
  }

  const startJob = async () => {
    if (!match.data || !confirmed || stale || !match.data.decision_sha256) return
    const retainedKey = idempotencyKey ?? createDispatchIdempotencyKey(
      item.card_id,
      match.data.decision_sha256,
    )
    if (!idempotencyKey) setIdempotencyKey(retainedKey)
    setDispatch((current) => ({
      status: 'loading',
      data: current.data,
      error: null,
      stale: false,
    }))
    try {
      const result = await client.dispatch(item.card_id, match.data, retainedKey)
      setDispatch({ status: 'ready', data: result, error: null, stale: false })
    } catch (error) {
      const conflict = onConflict(error)
      setDispatch((current) => ({
        status: 'error',
        data: current.data,
        error: conflict
          ? 'The job start was rejected because operator state changed. Reload before retrying.'
          : messageFor(error),
        stale: current.data !== null,
      }))
    }
  }

  const selected = match.data?.selected_agent ?? null
  const dispatchable = Boolean(
    match.data?.eligible
    && selected?.eligible
    && selected.provider
    && selected.model
    && selected.access_profile
    && selected.workspace_id
    && match.data?.decision_sha256,
  )

  return (
    <section className="ow-section ow-assignment" aria-labelledby={`ow-assignment-${item.card_id}`}>
      <header className="ow-section-heading">
        <div>
          <p>Capacity decision</p>
          <h3 id={`ow-assignment-${item.card_id}`}>Match and start</h3>
        </div>
        <span>Explicit operator confirmation</span>
      </header>

      {item.dependency_readiness === 'blocked' && (
        <div className="ow-blocked-state" role="status">
          <OsIcon name="attention" />
          <div>
            <strong>Matching is locked by dependencies</strong>
            <span>Resolve the critical path and refresh Open Work before matching.</span>
          </div>
        </div>
      )}

      <div className="ow-match-actions">
        <button type="button" className="ow-button"
          disabled={item.dependency_readiness === 'blocked' || match.status === 'loading'}
          onClick={() => void findMatch()}>
          <OsIcon name="process" size={14} />
          {match.status === 'loading' ? 'Evaluating capacity' : 'Find eligible match'}
        </button>
        <span>No provider or model fallback is applied.</span>
      </div>

      {match.status === 'error' && (
        <div className="ow-inline-error" role="alert">
          {match.error}
          <button type="button" onClick={() => void findMatch()}>Retry match</button>
        </div>
      )}

      {match.data && (
        <>
          {stale && (
            <div className="ow-state-banner conflict" role="alert">
              <OsIcon name="attention" />
              <div>
                <strong>Match is stale</strong>
                <span>The contract market version changed. Generate a new match.</span>
              </div>
              <button type="button" onClick={() => void findMatch()}>Refresh match</button>
            </div>
          )}

          <div className="ow-match-summary">
            <dl>
              <div><dt>Eligible</dt><dd>{match.data.eligible ? 'yes' : 'no'}</dd></div>
              <div><dt>Eligible profiles</dt><dd>{match.data.eligible_agent_count}</dd></div>
              <div><dt>Global active</dt><dd>{match.data.global_capacity.active}</dd></div>
              <div><dt>Global limit</dt><dd>{match.data.global_capacity.limit}</dd></div>
              <div><dt>Global available</dt><dd>{match.data.global_capacity.available}</dd></div>
              <div><dt>Market version</dt><dd>{match.data.market_version}</dd></div>
            </dl>
            <div>
              <span>Decision digest</span>
              <code>{match.data.decision_sha256 ?? 'No dispatchable decision'}</code>
            </div>
          </div>

          {selected ? (
            <section className="ow-selected-agent" aria-labelledby={`ow-selected-agent-${item.card_id}`}>
              <header>
                <div>
                  <p>Selected by deterministic scheduler</p>
                  <h4 id={`ow-selected-agent-${item.card_id}`}>{selected.name}</h4>
                </div>
                <span className={selected.eligible ? 'eligible' : 'ineligible'}>
                  {selected.eligible ? 'eligible' : 'ineligible'}
                </span>
              </header>
              <dl>
                <div><dt>Profile</dt><dd><code>{selected.profile_id}</code></dd></div>
                <div><dt>Provider</dt><dd>{selected.provider ?? 'Not declared'}</dd></div>
                <div><dt>Model</dt><dd>{selected.model ?? 'Not declared'}</dd></div>
                <div><dt>Access</dt><dd>{selected.access_profile ?? 'Not declared'}</dd></div>
                <div><dt>Workspace</dt><dd><code>{selected.workspace_id ?? 'Not assigned'}</code></dd></div>
                <div>
                  <dt>Capacity</dt>
                  <dd>{selected.capacity.active} active / {selected.capacity.limit} limit
                    · {selected.capacity.available} available</dd>
                </div>
              </dl>
              <div className="ow-capabilities" aria-label="Selected profile capabilities">
                {selected.capabilities.map((capability) => <code key={capability}>{capability}</code>)}
              </div>
            </section>
          ) : (
            <div className="ow-no-match" role="status">
              <strong>No eligible profile was selected</strong>
              <p>Review candidate evidence. Orchestra will not substitute another provider or model.</p>
            </div>
          )}

          <details className="ow-candidates">
            <summary>Candidate evidence ({match.data.candidates.length})</summary>
            <ol>
              {match.data.candidates.map((candidate) => (
                <li key={candidate.profile_id}>
                  <header>
                    <strong>{candidate.name}</strong>
                    <span className={candidate.eligible ? 'eligible' : 'ineligible'}>
                      {candidate.eligible ? 'eligible' : 'ineligible'}
                    </span>
                  </header>
                  <dl>
                    <div><dt>Profile</dt><dd><code>{candidate.profile_id}</code></dd></div>
                    <div><dt>Provider</dt><dd>{candidate.provider ?? 'Not declared'}</dd></div>
                    <div><dt>Model</dt><dd>{candidate.model ?? 'Not declared'}</dd></div>
                    <div><dt>Access</dt><dd>{candidate.access_profile ?? 'Not declared'}</dd></div>
                    <div><dt>Workspace</dt><dd><code>{candidate.workspace_id ?? 'Not assigned'}</code></dd></div>
                    <div><dt>Capacity</dt><dd>{candidate.capacity.active}/{candidate.capacity.limit}
                      · {candidate.capacity.available} available</dd></div>
                  </dl>
                  {candidate.ineligibility_reasons.length > 0 && (
                    <ul>{candidate.ineligibility_reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                  )}
                </li>
              ))}
            </ol>
          </details>

          {dispatchable && !stale && !dispatch.data && (
            <div className="ow-confirmation">
              {!confirmOpen ? (
                <button type="button" className="ow-button primary"
                  onClick={() => setConfirmOpen(true)}>
                  Review exact assignment
                </button>
              ) : (
                <fieldset>
                  <legend>Operator confirmation</legend>
                  <p>
                    Start exactly one job for <strong>{selected!.name}</strong> using
                    {' '}<code>{selected!.provider}</code> / <code>{selected!.model}</code>,
                    {' '}<code>{selected!.access_profile}</code>, workspace
                    {' '}<code>{selected!.workspace_id}</code>.
                  </p>
                  <label className="ow-check confirmation">
                    <input type="checkbox" checked={confirmed}
                      onChange={(event) => setConfirmed(event.currentTarget.checked)} />
                    <span>I confirm this exact assignment and one job start.</span>
                  </label>
                  {idempotencyKey && (
                    <p className="ow-idempotency">
                      Retry key retained: <code>{idempotencyKey}</code>
                    </p>
                  )}
                  <div>
                    <button type="button" className="ow-button"
                      onClick={() => {
                        setConfirmOpen(false)
                        setConfirmed(false)
                      }}>
                      Cancel
                    </button>
                    <button type="button" className="ow-button primary"
                      disabled={!confirmed || dispatch.status === 'loading'}
                      onClick={() => void startJob()}>
                      {dispatch.status === 'loading' ? 'Starting one job' : 'Confirm and start one job'}
                    </button>
                  </div>
                </fieldset>
              )}
            </div>
          )}
        </>
      )}

      {dispatch.status === 'error' && (
        <div className="ow-inline-error" role="alert">
          <strong>Job start failed.</strong> {dispatch.error}
          <button type="button" disabled={!confirmed} onClick={() => void startJob()}>
            Retry with the same key
          </button>
        </div>
      )}

      {dispatch.data && (
        <DispatchResult
          result={dispatch.data}
          idempotencyKey={idempotencyKey}
          onQueueRefresh={onQueueRefresh}
        />
      )}
    </section>
  )
}

function DispatchResult({
  result,
  idempotencyKey,
  onQueueRefresh,
}: {
  result: OpenWorkDispatch
  idempotencyKey: string | null
  onQueueRefresh: () => void
}) {
  const assignmentId = safeRecordValue(result.assignment, 'id')
  const jobId = safeRecordValue(result.job, 'id')
  const jobStatus = safeRecordValue(result.job, 'status')
  return (
    <section className="ow-dispatch-result" aria-labelledby="ow-dispatch-result-title">
      <header>
        <div>
          <p>{result.replayed ? 'Idempotent replay' : 'New dispatch'}</p>
          <h4 id="ow-dispatch-result-title">One durable job result</h4>
        </div>
        <span><OsIcon name="check" size={13} /> Recorded</span>
      </header>
      <dl>
        <div><dt>Assignment</dt><dd><code>{assignmentId}</code></dd></div>
        <div><dt>Job</dt><dd><code>{jobId}</code></dd></div>
        <div><dt>Job status</dt><dd>{jobStatus ?? 'Recorded'}</dd></div>
        <div><dt>Profile</dt><dd><code>{result.match.selected_agent?.profile_id ?? 'Unavailable'}</code></dd></div>
        <div><dt>Replay</dt><dd>{result.replayed ? 'yes' : 'no'}</dd></div>
        <div><dt>Idempotency key</dt><dd><code>{idempotencyKey ?? 'Retained by caller'}</code></dd></div>
      </dl>
      <BriefPanel
        title="Realized dispatch brief"
        brief={result.agent_brief}
        digest={result.agent_brief_sha256}
        realized
        stale={false}
      />
      <div className="ow-dispatch-refresh">
        <p>The realized result stays here until you explicitly refresh the queue.</p>
        <button type="button" className="ow-button" onClick={onQueueRefresh}>
          <OsIcon name="refresh" size={14} /> Refresh Open Work
        </button>
      </div>
    </section>
  )
}

function BriefPanel({
  title,
  brief,
  digest,
  realized,
  stale,
}: {
  title: string
  brief: string
  digest: string
  realized: boolean
  stale: boolean
}) {
  return (
    <section className={`ow-brief ${stale ? 'stale' : ''}`} aria-label={title}>
      <header>
        <div><p>{realized ? 'Backend dispatch output' : 'Read-only draft output'}</p><h4>{title}</h4></div>
        {stale && <span>Outdated by edits</span>}
      </header>
      <p>
        {realized
          ? 'Displayed unchanged from the dispatch response, including realized job and delivery identities.'
          : 'Displayed unchanged from the backend preview. Pending identities are draft placeholders, not a claim about the eventual dispatch brief.'}
      </p>
      <div><span>SHA-256</span><code>{digest}</code></div>
      <pre aria-label={`${title} exact text`}>{brief}</pre>
    </section>
  )
}

function OpenWorkSkeleton() {
  return (
    <div className="ow-skeleton" aria-label="Loading Open Work">
      <aside>{[0, 1, 2, 3].map((row) => <span key={row} style={{ '--row': row } as CSSProperties} />)}</aside>
      <section>
        <span /><span /><div><i /><i /><i /></div><span />
      </section>
    </div>
  )
}

function ContractSkeleton() {
  return (
    <div className="ow-contract-skeleton" aria-label="Loading contract editor">
      <span /><span /><span /><span />
    </div>
  )
}

function OpenWorkFailure({
  error,
  onRetry,
  compact = false,
}: {
  error: string
  onRetry: () => void
  compact?: boolean
}) {
  return (
    <section className={`ow-failure ${compact ? 'compact' : ''}`} role="alert">
      <OsIcon name="attention" size={22} />
      <h2>Open Work could not load</h2>
      <p>{error}</p>
      <button type="button" className="ow-button" onClick={onRetry}>
        <OsIcon name="refresh" size={14} /> Retry
      </button>
    </section>
  )
}

function OpenWorkEmpty({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <section className="ow-empty" role="status">
      <span><OsIcon name={filtered ? 'search' : 'check'} size={21} /></span>
      <h2>{filtered ? 'No contracts match these filters' : 'No open contracts'}</h2>
      <p>{filtered
        ? 'Widen repository, capability, dependency, priority, or budget constraints.'
        : 'Publish a valid contract to make it available to the operator queue.'}</p>
      {filtered && <button type="button" className="ow-button" onClick={onClear}>Clear filters</button>}
    </section>
  )
}
