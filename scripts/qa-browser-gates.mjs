#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACCESSIBILITY_GATES,
  AUTHENTICATED_DATA_READY_EXPRESSION,
  AUTHENTICATED_DATA_READY_SELECTOR,
  BROWSER_OVERFLOW_AUDIT_EXPRESSION,
  BROWSER_BUILD_SCHEMA_VERSION,
  BROWSER_QUALITY_SCHEMA_VERSION,
  PERFORMANCE_SURFACES,
  RESPONSIVE_VIEWPORTS,
  assertFinalBuildManifest,
  assertDistinctArtifactPaths,
  canonicalRepositoryName,
  compactJourneyEvidence,
  finalizeBrowserEvidence,
  finalizeValidatedBrowserEvidence,
  navigateFreshInteractionMode,
  performanceSampleForJourney,
  redactEvidence,
  redactText,
  resolveApprovedArtifactPath,
  resolveApprovedEvidencePath,
  validateArtifactIdentity,
  validateBaselineAgainstCaptures,
  validateBuildSourceIdentity,
  validatePerformanceBaseline,
  validateBrowserQualityEvidence,
  verifiableDocumentDigest,
  writeBrowserArtifact,
} from './lib/browser-quality.mjs'
import {
  createLocalOwnerChallengeTracker,
  recordLocalOwnerHttpFailure,
} from './lib/browser-auth-challenges.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const timeoutMs = 20_000
const asynchronousReadinessTimeoutMs = 10_000
const interactionReadinessTimeoutMs = 4_000
const defaultArtifactRoot = join(repositoryRoot, 'artifacts', 'qa', 'browser-quality')

const parseArgs = (argv) => {
  const options = {
    chrome: process.env.ORCHESTRA_QA_CHROME || defaultChrome,
    output: join(defaultArtifactRoot, 'evidence.json'),
    baseline: null,
    artifactManifest: join(defaultArtifactRoot, 'build-manifest.json'),
    writeArtifactManifest: null,
    captureOnly: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === '--capture-only') {
      options.captureOnly = true
      continue
    }
    if (key === '--chrome' && value) options.chrome = resolve(value)
    else if (key === '--output' && value) {
      if (isAbsolute(value)) throw new Error('--output must be repository-relative')
      options.output = resolve(value)
    }
    else if (key === '--baseline' && value) options.baseline = resolve(value)
    else if (key === '--artifact-manifest' && value) {
      if (isAbsolute(value)) throw new Error('--artifact-manifest must be repository-relative')
      options.artifactManifest = resolve(value)
    } else if (key === '--write-artifact-manifest' && value) {
      if (isAbsolute(value)) throw new Error('--write-artifact-manifest must be repository-relative')
      options.writeArtifactManifest = resolve(value)
    }
    else throw new Error(`unknown or incomplete argument: ${key}`)
    index += 1
  }
  options.output = resolveApprovedArtifactPath(repositoryRoot, options.output)
  options.artifactManifest = resolveApprovedArtifactPath(repositoryRoot, options.artifactManifest)
  if (options.writeArtifactManifest) {
    options.writeArtifactManifest = resolveApprovedArtifactPath(repositoryRoot, options.writeArtifactManifest)
  }
  assertDistinctArtifactPaths(options.output, options.writeArtifactManifest ?? options.artifactManifest)
  return options
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const unusedPort = async () => {
  const server = createServer()
  server.unref()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not allocate a loopback port')
  const { port } = address
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  return port
}

const boundedText = (chunks) => Buffer.concat(chunks).toString('utf8').slice(-16_000)

const retainChunk = (chunks, chunk, { maxChunks = 25, maxChunkBytes = 1_024 } = {}) => {
  const bounded = Buffer.from(chunk).subarray(-maxChunkBytes)
  chunks.push(bounded)
  if (chunks.length > maxChunks) chunks.shift()
}

const safeMessage = (value) => redactEvidence(value instanceof Error ? value.message : String(value))

const diagnosticFingerprint = (label, value) => ({
  label,
  sha256: createHash('sha256').update(redactText(String(value))).digest('hex'),
})

const retainEvidenceEntry = (entries, value) => {
  entries.push(redactEvidence(value))
  if (entries.length > 25) entries.shift()
}

const gitHead = async () => new Promise((resolveCommit, reject) => {
  const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  child.stdout.on('data', (chunk) => retainChunk(chunks, chunk))
  child.once('error', reject)
  child.once('close', (code) => code === 0
    ? resolveCommit(boundedText(chunks).trim())
    : reject(new Error('git rev-parse failed')))
})

const collectCommand = (command, args) => new Promise((resolveOutput, reject) => {
  const child = spawn(command, args, { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = [], stderr = []
  child.stdout.on('data', (chunk) => retainChunk(stdout, chunk, { maxChunks: 256, maxChunkBytes: 65_536 }))
  child.stderr.on('data', (chunk) => retainChunk(stderr, chunk, { maxChunks: 32, maxChunkBytes: 16_384 }))
  child.once('error', reject)
  child.once('close', (code) => code === 0
    ? resolveOutput(Buffer.concat(stdout))
    : reject(new Error(`${command} ${args.join(' ')} failed: ${boundedText(stderr)}`)))
})

const trackedSourceState = async () => {
  const status = String(await collectCommand('git', ['status', '--porcelain', '--untracked-files=no'])).trim()
  const listed = await collectCommand('git', ['ls-files', '-z'])
  const files = String(listed).split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
  for (const file of files) hash.update(file).update('\0').update(readFileSync(join(repositoryRoot, file))).update('\0')
  const gitCommonDirectory = String(await collectCommand('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  return {
    repository: canonicalRepositoryName(gitCommonDirectory),
    source_commit: await gitHead(),
    source_tree_sha256: hash.digest('hex'),
    source_status: status ? 'dirty' : 'clean',
    dirty_summary: status || null,
  }
}

const runBuild = async (args) => {
  await new Promise((resolveBuild, reject) => {
    const child = spawn('npm', args, { cwd: repositoryRoot, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolveBuild() : reject(new Error(`npm ${args.join(' ')} failed`)))
  })
}

const directoryDigest = (root) => {
  const hash = createHash('sha256')
  const visit = (path, relative = '') => {
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name)
      const childRelative = relative ? `${relative}/${name}` : name
      const stat = statSync(absolute)
      if (stat.isDirectory()) visit(absolute, childRelative)
      else if (stat.isFile()) {
        hash.update(childRelative).update('\0').update(readFileSync(absolute)).update('\0')
      }
    }
  }
  visit(root)
  return hash.digest('hex')
}

const currentArtifactIdentity = () => ({
  root_dist_sha256: directoryDigest(join(repositoryRoot, 'dist')),
  web_dist_sha256: directoryDigest(join(repositoryRoot, 'web', 'dist')),
})

const writeBuildManifest = async (path) => {
  const source = await trackedSourceState()
  if (source.source_status !== 'clean') throw new Error(`refusing to build from dirty tracked source: ${source.dirty_summary}`)
  const sourceCheckedAt = new Date().toISOString()
  await runBuild(['run', 'build'])
  await runBuild(['--prefix', 'web', 'run', 'build'])
  const artifactsBuiltAt = new Date().toISOString()
  const finalSource = await trackedSourceState()
  const sourceErrors = validateBuildSourceIdentity({
    repository: source.repository,
    source_status: source.source_status,
    source_commit: source.source_commit,
    source_tree_sha256: source.source_tree_sha256,
    source_checked_at: sourceCheckedAt,
    artifacts_built_at: artifactsBuiltAt,
  }, finalSource)
  if (sourceErrors.length) throw new Error(`source changed while building artifacts: ${sourceErrors.join('; ')}`)
  const manifest = {
    schema_version: BROWSER_BUILD_SCHEMA_VERSION,
    repository: source.repository,
    source_commit: source.source_commit,
    source_tree_sha256: source.source_tree_sha256,
    source_status: source.source_status,
    source_checked_at: sourceCheckedAt,
    artifacts_built_at: artifactsBuiltAt,
    untracked_exclusions: [
      'artifacts/qa/browser-quality/**', 'dist/**', 'web/dist/**',
      'node_modules/**', 'web/node_modules/**',
    ],
    artifact_identity: currentArtifactIdentity(),
    generated_by: 'scripts/qa-browser-gates.mjs --write-artifact-manifest',
  }
  manifest.sha256 = verifiableDocumentDigest(manifest)
  writeBrowserArtifact(repositoryRoot, path, manifest)
  return manifest
}

const loadBuildManifest = async (path) => {
  if (!existsSync(path)) throw new Error(`missing build manifest: ${path}`)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (manifest.schema_version !== BROWSER_BUILD_SCHEMA_VERSION) throw new Error('build manifest schema version is invalid')
  if (manifest.sha256 !== verifiableDocumentDigest(manifest)) throw new Error('build manifest digest is invalid')
  const currentSource = await trackedSourceState()
  const sourceErrors = validateBuildSourceIdentity(manifest, currentSource)
  if (sourceErrors.length) throw new Error(`stale build manifest: ${sourceErrors.join('; ')}`)
  const actual = currentArtifactIdentity()
  const artifactErrors = validateArtifactIdentity(manifest, actual)
  if (artifactErrors.length) throw new Error(`stale build artifact: ${artifactErrors.join('; ')}`)
  return manifest
}

const waitForJson = async (url, predicate = () => true) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(800) })
      const body = await response.json()
      if (response.ok && predicate(body)) return body
    } catch (error) { lastError = error }
    await delay(40)
  }
  throw new Error(`timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : 'not ready'}`)
}

const jsonRequest = async (baseUrl, method, path, body, headers = {}) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    })
    const text = await response.text()
    let parsed
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
    if (response.ok) return parsed
    const retryAfterSeconds = Number(response.headers.get('retry-after'))
    const idempotencyKey = Object.entries(headers)
      .find(([key]) => key.toLowerCase() === 'idempotency-key')?.[1]
    const mayRetryFixtureMutation = attempt === 0
      && response.status === 429
      && typeof parsed === 'object'
      && parsed !== null
      && parsed.error === 'operational rate limit exceeded'
      && parsed.reason_code === 'limit_exceeded'
      && typeof idempotencyKey === 'string'
      && idempotencyKey.length > 0
      && Number.isFinite(retryAfterSeconds)
      && retryAfterSeconds > 0
      && retryAfterSeconds <= 60
    if (mayRetryFixtureMutation) {
      await delay((retryAfterSeconds * 1_000) + 100)
      continue
    }
    const responseSha256 = createHash('sha256').update(text).digest('hex')
    throw new Error(`${method} ${path} returned ${response.status}; response_sha256=${responseSha256}`)
  }
  throw new Error(`${method} ${path} exhausted bounded operational rate-limit retry`)
}

const seedScenario = async (baseUrl, authHeaders) => {
  const board = await jsonRequest(baseUrl, 'POST', '/api/v1/boards/resolve', {
    project_path: repositoryRoot,
  }, authHeaders)
  await Promise.all(Array.from({ length: 17 }, (_, index) => jsonRequest(
    baseUrl,
    'POST',
    '/api/v1/agents/register',
    { board_id: board.id, name: `qa-agent-${String(index + 1).padStart(2, '0')}` },
    authHeaders,
  )))
  const card = (await jsonRequest(baseUrl, 'POST', '/api/v1/cards', {
    board_id: board.id,
    title: 'QA browser evidence fixture',
    description: 'Public-API-only fixture for browser quality evidence.',
    paths: [],
  }, authHeaders)).card
  const graphCard = (await jsonRequest(baseUrl, 'POST', '/api/v1/cards', {
    board_id: board.id,
    title: 'QA dependency graph fixture',
    description: 'Keeps a real Open Work dependency graph visible while the browser session runs.',
    paths: [],
  }, authHeaders)).card
  const prerequisite = (await jsonRequest(baseUrl, 'POST', '/api/v1/cards', {
    board_id: board.id,
    title: 'QA dependency fixture',
    description: 'Renders a real dependency node and edge for the browser quality journey.',
    paths: [],
    column: 'done',
  }, authHeaders)).card
  const contract = await jsonRequest(baseUrl, 'GET', `/api/v1/os/cards/${graphCard.id}/contract`, undefined, authHeaders)
  await jsonRequest(baseUrl, 'PUT', `/api/v1/os/cards/${graphCard.id}/contract`, {
    dependency_rules: [{
      card_id: prerequisite.id,
      blocking_reason: 'QA dependency remains open for graph rendering.',
      completion_condition: 'card_done',
    }],
    expected_market_version: contract.job_market.market_version,
  }, { ...authHeaders, 'idempotency-key': 'qa-browser-contract-dependency' })
  const workspace = (await jsonRequest(baseUrl, 'POST', `/api/v1/os/boards/${board.id}/workspaces`, {
    name: 'QA browser workspace', kind: 'shared', root_path: repositoryRoot,
  }, { ...authHeaders, 'idempotency-key': 'qa-browser-workspace' })).workspace
  const launch = await jsonRequest(baseUrl, 'POST', `/api/v1/os/boards/${board.id}/jobs`, {
    card_id: card.id,
    workspace_id: workspace.id,
    provider: 'codex',
    model: 'qa-browser-model',
    idempotency_key: 'qa-browser-job',
  }, { ...authHeaders, 'idempotency-key': 'qa-browser-job' })
  const sessionId = launch.session.id
  const events = Array.from({ length: 250 }, (_, index) => ({
    index,
    body: {
      dedupe_key: `qa-browser-event-${index}`,
      kind: index % 5 === 0 ? 'tool' : 'assistant',
      projected_text: index % 50 === 0
        ? `quality benchmark marker ${index}`
        : `bounded transcript event ${index}`,
      metadata: index % 5 === 0 ? { tool: 'quality-harness', status: 'passed' } : {},
    },
  }))
  for (let offset = 0; offset < events.length; offset += 20) {
    await Promise.all(events.slice(offset, offset + 20).map(({ index, body }) => jsonRequest(
      baseUrl,
      'POST',
      `/api/v1/os/sessions/${sessionId}/events`,
      body,
      { ...authHeaders, 'idempotency-key': `qa-browser-event-${index}` },
    )))
  }
  return {
    board_id: board.id,
    profile_id: launch.session.profile_id,
    session_id: sessionId,
    transcript_events: events.length,
    graph_agents: 18,
    fixture_transport: 'authenticated public APIs only',
  }
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
  }

  async connect() {
    if (this.socket.readyState === WebSocket.OPEN) return
    await Promise.race([
      once(this.socket, 'open'),
      delay(timeoutMs).then(() => { throw new Error('timed out connecting to Chrome DevTools') }),
    ])
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
        else pending.resolve(message.result)
        return
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {})
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? []
    listeners.push(listener)
    this.listeners.set(method, listeners)
    return () => {
      const current = this.listeners.get(method) ?? []
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) this.listeners.delete(method)
    }
  }

  send(method, params = {}) {
    const id = this.nextId++
    const promise = new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { method, resolve: resolveCall, reject, timer })
    })
    this.socket.send(JSON.stringify({ id, method, params }))
    return promise
  }

  close() {
    this.socket.close()
  }
}

const evaluate = async (client, expression) => {
  let result
  try {
    result = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
  } catch (error) {
    const expressionLabel = String(expression).replace(/\s+/g, ' ').trim().slice(0, 160)
    const message = safeMessage(error)
    throw new Error(`${message}; evaluate=${expressionLabel}`)
  }
  if (result.exceptionDetails) {
    throw new Error(safeMessage(result.exceptionDetails.exception?.description
      || result.exceptionDetails.text || 'browser evaluation failed'))
  }
  return result.result?.value
}

const waitFor = async (client, expression, label) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return
    await delay(40)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const hitTestPoint = async (client, selector, label) => {
  const document = await client.send('DOM.getDocument', { depth: 1, pierce: true })
  const match = await client.send('DOM.querySelector', { nodeId: document.root.nodeId, selector })
  if (!match.nodeId) throw new Error(`could not find ${label}`)
  await client.send('DOM.scrollIntoViewIfNeeded', { nodeId: match.nodeId })
  await delay(150)
  const { quads = [] } = await client.send('DOM.getContentQuads', { nodeId: match.nodeId })
  const viewport = await evaluate(client, `({ width: innerWidth, height: innerHeight })`)
  const point = quads.map((quad) => ({
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  })).find((candidate) => candidate.x >= 0 && candidate.x <= viewport.width
    && candidate.y >= 0 && candidate.y <= viewport.height)
  if (!point) throw new Error(`could not hit-test ${label}`)
  return point
}

const pointerClick = async (client, selector, label, mobile = false) => {
  const point = await hitTestPoint(client, selector, label)
  if (mobile) {
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  } else {
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
}

const dispatchKey = async (client, key, { shift = false, meta = false } = {}) => {
  const code = key === 'Tab' ? 'Tab' : key === 'Enter' ? 'Enter' : key === 'Escape' ? 'Escape'
    : key === 'Backspace' ? 'Backspace' : key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key
  const windowsVirtualKeyCode = key === 'Tab' ? 9 : key === 'Enter' ? 13 : key === 'Escape' ? 27
    : key === 'Backspace' ? 8 : key === ' ' ? 32 : key === 'ArrowLeft' ? 37
      : key === 'ArrowUp' ? 38 : key === 'ArrowRight' ? 39 : key === 'ArrowDown' ? 40
        : key.toUpperCase().charCodeAt(0)
  const modifiers = (shift ? 8 : 0) | (meta ? 4 : 0)
  const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : key.length === 1 ? key : ''
  const event = {
    key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers,
    ...(text && !meta ? { text, unmodifiedText: text } : {}),
  }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
}

const activeFocusProbe = (client, targetSelector = null) => evaluate(client, `(() => {
  const element = document.activeElement;
  const target = ${targetSelector ? `document.querySelector(${JSON.stringify(targetSelector)})` : 'null'};
  if (!(element instanceof HTMLElement) || element === document.body || element === document.documentElement) {
    return { key: 'document', interactive: false, target: false, xterm_proxy: false, visible: false, focus_visible: false, outline: 'none' };
  }
  const xtermProxy = element.matches('.xterm-helper-textarea') || Boolean(element.closest('.xterm'));
  const focusSurface = xtermProxy ? element.closest('.xterm') : element;
  const rect = focusSurface.getBoundingClientRect(), style = getComputedStyle(focusSurface);
  const interactive = [...document.querySelectorAll('button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="tab"],[tabindex]:not([tabindex="-1"])')];
  const focusIndex = interactive.indexOf(element);
  return {
    key: xtermProxy ? 'Terminal input' : element.id || (element.getAttribute('role') || element.tagName) + ':' + focusIndex,
    interactive: true,
    target: element === target,
    xterm_proxy: xtermProxy,
    visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
    focus_visible: element.matches(':focus-visible') || focusSurface.matches(':focus-visible') || focusSurface.matches(':focus-within'),
    outline: style.outlineStyle,
  };
})()`)

const escapeXtermFocus = async (client, { shift = false, targetSelector = null } = {}) => {
  const before = await activeFocusProbe(client, targetSelector)
  const documented = await evaluate(client, `(() => {
    const active = document.activeElement;
    const host = active instanceof HTMLElement ? active.closest('.os-xterm') : null;
    const descriptionId = host?.getAttribute('aria-describedby');
    const description = descriptionId ? document.getElementById(descriptionId)?.textContent : '';
    return Boolean(description?.includes('Press Escape, then Tab'));
  })()`)
  await dispatchKey(client, 'Escape')
  const armed = await evaluate(client, `Boolean(document.querySelector('.os-terminal-keyboard-help.is-armed'))`)
  await dispatchKey(client, 'Tab', { shift })
  const after = await activeFocusProbe(client, targetSelector)
  return {
    escape_path: shift ? 'Escape+Shift+Tab' : 'Escape+Tab',
    documented,
    armed,
    advanced: before.key !== after.key || before.xterm_proxy !== after.xterm_proxy,
    from: before.key,
    to: after.key,
    focused: after,
  }
}

const keyboardNavigateTo = async (client, selector, label, maximumTabs = 120) => {
  let tabEvents = 0
  let arrowEvents = 0
  const traversal = []
  const xtermEscapePaths = []
  const rovingTab = await evaluate(client, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'tab' || target.tabIndex >= 0) return null;
    const tablist = target.closest('[role="tablist"]');
    const active = tablist?.querySelector('[role="tab"][tabindex="0"]');
    if (!(active instanceof HTMLElement)) return null;
    if (!active.dataset.qaKeyboardOrigin) active.dataset.qaKeyboardOrigin = 'qa-' + Math.random().toString(16).slice(2);
    return {
      origin_selector: '[data-qa-keyboard-origin="' + active.dataset.qaKeyboardOrigin + '"]',
      tab_count: tablist.querySelectorAll('[role="tab"]').length,
    };
  })()`)
  const navigationSelector = rovingTab?.origin_selector ?? selector
  let previous = await activeFocusProbe(client, navigationSelector)
  for (let index = 0; index < maximumTabs; index += 1) {
    await dispatchKey(client, 'Tab')
    tabEvents += 1
    let focused = await activeFocusProbe(client, navigationSelector)
    traversal.push({ key: focused.key, xterm_proxy: focused.xterm_proxy, visible: focused.visible })
    if (focused.xterm_proxy && previous.xterm_proxy && focused.key === previous.key) {
      const escape = await escapeXtermFocus(client, { targetSelector: navigationSelector })
      tabEvents += 1
      xtermEscapePaths.push({
        escape_path: escape.escape_path,
        documented: escape.documented,
        armed: escape.armed,
        advanced: escape.advanced,
        from: escape.from,
        to: escape.to,
      })
      focused = escape.focused
      traversal.push({
        key: focused.key,
        xterm_proxy: focused.xterm_proxy,
        visible: focused.visible,
        escape_path: escape.escape_path,
      })
      if (!escape.documented || !escape.armed || !escape.advanced) {
        throw new Error(`documented xterm keyboard escape did not advance focus toward ${label}`)
      }
    }
    if (focused.target) {
      if (rovingTab) {
        for (let tabIndex = 0; tabIndex < rovingTab.tab_count; tabIndex += 1) {
          if ((await activeFocusProbe(client, selector)).target) break
          await dispatchKey(client, 'ArrowRight')
          arrowEvents += 1
          const arrowFocused = await activeFocusProbe(client, selector)
          traversal.push({ key: arrowFocused.key, xterm_proxy: arrowFocused.xterm_proxy, visible: arrowFocused.visible })
        }
        if (!(await activeFocusProbe(client, selector)).target) {
          throw new Error(`roving tab navigation could not reach ${label}`)
        }
      }
      return {
        focus_acquisition: 'tab_navigation',
        programmatic_focus: false,
        tab_events: tabEvents,
        arrow_events: arrowEvents,
        traversal: traversal.slice(-24),
        xterm_focus_encounters: traversal.filter((step) => step.xterm_proxy).length,
        xterm_escape_paths: xtermEscapePaths,
      }
    }
    previous = focused
  }
  throw new Error(`could not reach ${label} through keyboard navigation`)
}

const keyboardActivate = async (client, selector, label) => {
  const evidence = await keyboardNavigateTo(client, selector, label)
  await dispatchKey(client, 'Enter')
  return { ...evidence, activation_key: 'Enter' }
}

const domActivate = (client, selector) => evaluate(client, `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!(element instanceof HTMLElement)) return false;
  element.click();
  return true;
})()`)

const authenticateLocalOwner = async (client, operatorToken, label, beforeSubmit = () => {}) => {
  await waitFor(client, `Boolean(document.querySelector('.login-form .login-input'))`, `${label} owner login`)
  const loginFormReadyMs = await evaluate(client, `performance.now()`)
  const focused = await evaluate(client, `(() => {
    const input = document.querySelector('.login-form .login-input');
    if (!(input instanceof HTMLInputElement)) return false;
    input.focus();
    return document.activeElement === input;
  })()`)
  if (!focused) throw new Error(`${label} owner login could not receive focus`)
  await client.send('Input.insertText', { text: operatorToken })
  await waitFor(
    client,
    `document.querySelector('.login-form .login-btn')?.disabled === false`,
    `${label} owner token input`,
  )
  const submitStartedMs = await evaluate(client, `performance.now()`)
  beforeSubmit()
  if (!await domActivate(client, '.login-form .login-btn')) {
    throw new Error(`${label} owner login could not be submitted`)
  }
  await waitFor(
    client,
    `Boolean(document.querySelector('.cc-project-nav')) && !document.querySelector('.login-form')`,
    `${label} authenticated command center`,
  )
  const commandCenterReadyMs = await evaluate(client, `performance.now()`)
  return {
    login_form_ready_ms: loginFormReadyMs,
    login_entry_ms: Math.max(0, submitStartedMs - loginFormReadyMs),
    submit_started_ms: submitStartedMs,
    submit_to_command_center_ms: Math.max(0, commandCenterReadyMs - submitStartedMs),
    command_center_ready_ms: commandCenterReadyMs,
  }
}

const activateMode = async (client, mode, selector, label, mobile) => {
  if (mode === 'pointer') return pointerClick(client, selector, label, mobile)
  if (mode === 'keyboard') return keyboardActivate(client, selector, label)
  if (mode === 'dom_fallback') {
    if (!await domActivate(client, selector)) throw new Error(`DOM fallback could not activate ${label}`)
    return
  }
  throw new Error(`unknown interaction mode: ${mode}`)
}

const selectorForButtonText = (client, value) => evaluate(client, `(() => {
  const element = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === ${JSON.stringify(value)});
  if (!element) return null;
  if (!element.dataset.qaPointerId) element.dataset.qaPointerId = 'qa-' + Math.random().toString(16).slice(2);
  return '[data-qa-pointer-id="' + element.dataset.qaPointerId + '"]';
})()`)

const typeText = async (client, value) => {
  for (const character of value) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: character, text: character, unmodifiedText: character,
    })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character })
  }
}

const overflowAudit = (client) => evaluate(client, BROWSER_OVERFLOW_AUDIT_EXPRESSION)

const accessibleNameAudit = (client) => evaluate(client, `(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
  };
  const label = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) return labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    if (element.id) {
      const explicit = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
      if (explicit?.textContent?.trim()) return explicit.textContent.trim();
    }
    return (element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title')
      || element.closest('label')?.textContent || element.textContent || '').trim();
  };
  const selectors = 'button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="tab"],[tabindex]:not([tabindex="-1"])';
  const checked = [...document.querySelectorAll(selectors)].filter((element) => visible(element) && !element.closest('[aria-hidden="true"]'));
  const violations = checked.filter((element) => !label(element)).map((element) => ({
    tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), id: element.id || null,
  })).slice(0, 25);
  return { passed: violations.length === 0, checked: checked.length, violations };
})()`)

const contrastAudit = (client) => evaluate(client, `(() => {
  const styleCache = new WeakMap(), backgroundCache = new WeakMap();
  const styleFor = (element) => {
    if (!styleCache.has(element)) styleCache.set(element, getComputedStyle(element));
    return styleCache.get(element);
  };
  const parse = (value) => {
    const match = String(value).match(/^rgba?\\(\\s*([\\d.]+)[, ]+([\\d.]+)[, ]+([\\d.]+)(?:\\s*[,/]\\s*([\\d.]+))?\\s*\\)$/i);
    return match ? { r: +match[1], g: +match[2], b: +match[3], a: match[4] === undefined ? 1 : +match[4] } : null;
  };
  const channel = (value) => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; };
  const lum = (color) => .2126 * channel(color.r) + .7152 * channel(color.g) + .0722 * channel(color.b);
  const over = (foreground, background) => {
    const a = foreground.a + background.a * (1 - foreground.a);
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / a,
      g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / a,
      b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / a,
      a,
    };
  };
  const background = (element) => {
    if (backgroundCache.has(element)) return backgroundCache.get(element);
    const ancestry = [];
    for (let current = element; current; current = current.parentElement) ancestry.push(current);
    let resolved = { r: 255, g: 255, b: 255, a: 1 };
    for (const current of ancestry.reverse()) {
      const currentStyle = styleFor(current);
      if (Number(currentStyle.opacity) !== 1 || currentStyle.backgroundImage !== 'none') {
        const unsupported = { supported: false, reason: 'opacity_or_background_image' };
        backgroundCache.set(element, unsupported);
        return unsupported;
      }
      const parsed = parse(currentStyle.backgroundColor);
      if (parsed && parsed.a > 0) resolved = over(parsed, resolved);
    }
    backgroundCache.set(element, resolved);
    return resolved;
  };
  const rows = [], unsupported = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent?.trim();
    const element = walker.currentNode.parentElement;
    if (!text || !element || element.closest('[aria-hidden="true"],.sr-only') || element.matches('script,style')) continue;
    const style = styleFor(element);
    const rect = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.width === 0 || rect.height === 0) continue;
    if (element.closest('button:disabled,input:disabled,select:disabled,textarea:disabled')) continue;
    let foreground = parse(style.color); const bg = background(element);
    if (!foreground || bg.supported === false) {
      unsupported.push({ tag: element.tagName.toLowerCase(), class_name: String(element.className || '').slice(0, 100), reason: bg.reason || 'unparsed_foreground' });
      continue;
    }
    if (foreground.a < 1) foreground = over(foreground, bg);
    const ratio = (Math.max(lum(foreground), lum(bg)) + .05) / (Math.min(lum(foreground), lum(bg)) + .05);
    const large = parseFloat(style.fontSize) >= (Number(style.fontWeight) >= 700 ? 18.66 : 24);
    const required = large ? 3 : 4.5;
    if (ratio + .01 < required) rows.push({
      tag: element.tagName.toLowerCase(), class_name: String(element.className || '').slice(0, 100),
      ancestor_class_name: String(element.parentElement?.className || '').slice(0, 100),
      text_length: text.length, ratio: Math.round(ratio * 100) / 100, required,
      foreground: [foreground.r, foreground.g, foreground.b].map(Math.round),
      background: [bg.r, bg.g, bg.b].map(Math.round),
    });
  }
  return {
    passed: rows.length === 0 && unsupported.length === 0,
    checked: true,
    scope: 'computed text composited over translucent solid ancestor backgrounds and the opaque browser canvas',
    unsupported_count: unsupported.length,
    unsupported: unsupported.slice(0, 25),
    violations: rows.slice(0, 25),
  };
})()`)

const keyboardAudit = async (client) => {
  await evaluate(client, `document.activeElement instanceof HTMLElement && document.activeElement.blur()`)
  const focusOrder = []
  const violations = []
  const xtermEscapePaths = []
  let previous = await activeFocusProbe(client)
  for (let index = 0; index < 8; index += 1) {
    await dispatchKey(client, 'Tab')
    let focused = await activeFocusProbe(client)
    if (focused.xterm_proxy && previous.xterm_proxy && focused.key === previous.key) {
      const escape = await escapeXtermFocus(client)
      xtermEscapePaths.push({
        escape_path: escape.escape_path,
        documented: escape.documented,
        armed: escape.armed,
        advanced: escape.advanced,
        from: escape.from,
        to: escape.to,
      })
      focused = escape.focused
      if (!escape.documented || !escape.armed || !escape.advanced) {
        violations.push({ step: index + 1, reason: 'documented xterm keyboard escape did not advance focus', key: escape.from })
        break
      }
    }
    if (!focused.interactive) {
      violations.push({ step: index + 1, reason: 'focus did not reach an interactive element' })
      previous = focused
      continue
    }
    focusOrder.push(focused.key)
    if (!focused.visible) violations.push({ step: index + 1, reason: 'focused element is outside the viewport', key: focused.key })
    if (!focused.focus_visible && (focused.outline === 'none' || focused.outline === '')) {
      violations.push({ step: index + 1, reason: 'focus indicator is not visible', key: focused.key })
    }
    previous = focused
  }
  if (new Set(focusOrder).size < 5) violations.push({ reason: 'keyboard traversal reached fewer than five unique controls' })
  const reverseOrder = []
  let reversePrevious = await activeFocusProbe(client)
  for (let index = 0; index < 3; index += 1) {
    await dispatchKey(client, 'Tab', { shift: true })
    let focused = await activeFocusProbe(client)
    if (focused.xterm_proxy && reversePrevious.xterm_proxy && focused.key === reversePrevious.key) {
      const escape = await escapeXtermFocus(client, { shift: true })
      xtermEscapePaths.push({
        escape_path: escape.escape_path,
        documented: escape.documented,
        armed: escape.armed,
        advanced: escape.advanced,
        from: escape.from,
        to: escape.to,
      })
      focused = escape.focused
      if (!escape.documented || !escape.armed || !escape.advanced) {
        violations.push({ reason: 'documented reverse xterm keyboard escape did not advance focus', key: escape.from })
        break
      }
    }
    reverseOrder.push(focused.key)
    reversePrevious = focused
  }
  const selectedTab = await evaluate(client, `(() => {
    const tab = document.querySelector('.board-section-tabs [aria-selected="true"], .board-section-tabs .active');
    return tab instanceof HTMLElement && tab.id ? { supported: true, id: tab.id } : { supported: false };
  })()`)
  const activation = { ...selectedTab }
  if (selectedTab.supported) {
    await evaluate(client, `document.activeElement instanceof HTMLElement && document.activeElement.blur()`)
    try {
      activation.keyboard = await keyboardActivate(client, `#${selectedTab.id}`, 'selected board tab')
      activation.remained_selected = await evaluate(client, `document.activeElement?.id === ${JSON.stringify(selectedTab.id)} && (document.activeElement?.getAttribute('aria-selected') === 'true' || document.activeElement?.classList.contains('active'))`)
      if (!activation.remained_selected) violations.push({ reason: 'Enter activation did not preserve selected tab and focus' })
    } catch (error) {
      activation.error = safeMessage(error)
      violations.push({ reason: activation.error })
    }
  }
  return {
    passed: violations.length === 0,
    checked: focusOrder.length + reverseOrder.length,
    focus_order: focusOrder,
    reverse_focus_order: reverseOrder,
    xterm_escape_paths: xtermEscapePaths,
    activation,
    violations,
  }
}

const modalFocusAudit = async (client, mobile) => {
  const selector = '[aria-label="Create durable agent"]'
  if (!await evaluate(client, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return { supported: false, passed: true }
  let activation
  await evaluate(client, `document.activeElement instanceof HTMLElement && document.activeElement.blur()`)
  try { activation = await keyboardActivate(client, selector, 'Create durable agent') }
  catch (error) { return { supported: true, passed: false, reason: safeMessage(error) } }
  await delay(150)
  if (!await evaluate(client, `Boolean(document.querySelector('.ah-dialog[role="dialog"][aria-modal="true"]'))`)) {
    return { supported: true, passed: false, activation, reason: 'Enter did not open the create-agent modal' }
  }
  const initial = await evaluate(client, `document.querySelector('.ah-dialog')?.contains(document.activeElement) === true`)
  await dispatchKey(client, 'Tab', { shift: true })
  const reverseTrapped = await evaluate(client, `document.querySelector('.ah-dialog')?.contains(document.activeElement) === true`)
  await dispatchKey(client, 'Escape')
  await delay(150)
  const closed = await evaluate(client, `!document.querySelector('.ah-dialog[role="dialog"]')`)
  const restored = await evaluate(client, `document.activeElement?.getAttribute('aria-label') === 'Create durable agent'`)
  return { supported: true, passed: initial && reverseTrapped && closed && restored, activation, initial_focus_inside: initial, reverse_focus_trapped: reverseTrapped, escape_closed: closed, focus_restored: restored }
}

const screenReaderAudit = async (client) => {
  const tree = await client.send('Accessibility.getFullAXTree')
  const interactive = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'tab', 'radio'])
  const nodes = (tree.nodes ?? []).filter((node) => !node.ignored)
  const unnamed = nodes.filter((node) => interactive.has(node.role?.value) && !String(node.name?.value ?? '').trim())
    .map((node) => ({ role: node.role?.value, node_id: node.nodeId })).slice(0, 25)
  const hasDocument = nodes.some((node) => node.role?.value === 'RootWebArea')
  const hasNavigation = nodes.some((node) => ['navigation', 'tablist'].includes(node.role?.value))
  return {
    passed: hasDocument && hasNavigation && unnamed.length === 0,
    checked: nodes.length,
    root_web_area: hasDocument,
    navigation: hasNavigation,
    violations: unnamed,
  }
}

const auditSurface = async (client) => ({
  accessible_names: await accessibleNameAudit(client),
  keyboard_focus: await keyboardAudit(client),
  screen_reader_tree: await screenReaderAudit(client),
  text_contrast: await contrastAudit(client),
})

const fileDigest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

const loadBaseline = (path, artifactIdentity) => {
  if (!path) throw new Error('normal browser quality gate requires an explicit --baseline')
  const baseline = JSON.parse(readFileSync(path, 'utf8'))
  const errors = validatePerformanceBaseline(baseline)
  for (const key of Object.keys(artifactIdentity)) {
    if (baseline.source?.artifact_identity?.[key] !== artifactIdentity[key]) {
      errors.push(`baseline artifact identity does not match tested ${key}`)
    }
  }
  const captureDocuments = []
  for (const capture of baseline.capture_artifacts ?? []) {
    let capturePath
    try { capturePath = resolveApprovedEvidencePath(repositoryRoot, capture.path) }
    catch (error) {
      errors.push(`baseline capture path rejected: ${safeMessage(error)}`)
      continue
    }
    if (fileDigest(capturePath) !== capture.file_sha256) errors.push(`baseline capture file digest changed: ${capture.path}`)
    const document = JSON.parse(readFileSync(capturePath, 'utf8'))
    captureDocuments.push(document)
    if (document.sha256 !== capture.sha256 || document.sha256 !== verifiableDocumentDigest(document)) {
      errors.push(`baseline capture evidence digest changed: ${capture.path}`)
    }
    for (const key of Object.keys(artifactIdentity)) {
      if (document.source?.artifact_identity?.[key] !== artifactIdentity[key]) {
        errors.push(`baseline capture artifact identity changed: ${capture.path}`)
      }
    }
  }
  errors.push(...validateBaselineAgainstCaptures(baseline, captureDocuments))
  if (errors.length) throw new Error(`invalid checked baseline: ${errors.join('; ')}`)
  return baseline
}

const budgetFor = (baseline, viewportId, surface) => {
  const baselineMetric = baseline?.viewports?.find((viewport) => viewport.id === viewportId)?.performance?.[surface]
  if (!baseline) return { budget_ms: null, budget_source: 'observation_only' }
  if (!Number.isFinite(baselineMetric?.budget_ms) || baselineMetric.budget_source !== 'checked_observation') {
    throw new Error(`missing checked budget for ${viewportId} ${surface}`)
  }
  return {
    budget_ms: baselineMetric.budget_ms,
    experience_budget_ms: baselineMetric.experience_budget_ms,
    regression_budget_ms: baselineMetric.regression_budget_ms,
    budget_source: 'checked_observation',
  }
}

const measureViewport = async ({ client, viewport, baseUrl, baseline, scenario, operatorToken }) => {
  const consoleErrors = []
  const pageErrors = []
  const failedRequests = []
  const authenticationChallenges = []
  const authenticationChallengeTracker = createLocalOwnerChallengeTracker(baseUrl)
  const subscriptions = []
  subscriptions.push(client.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error') {
      retainEvidenceEntry(consoleErrors, diagnosticFingerprint(
        'console_error',
        event.args?.map((arg) => arg.value ?? arg.description ?? '').join(' '),
      ))
    }
  }))
  subscriptions.push(client.on('Runtime.exceptionThrown', (event) => retainEvidenceEntry(pageErrors, diagnosticFingerprint(
    'page_exception',
    event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? 'page exception',
  ))))
  subscriptions.push(client.on('Network.requestWillBeSent', (event) => {
    authenticationChallengeTracker.observeRequest(event.requestId, event.request?.url)
  }))
  subscriptions.push(client.on('Network.responseReceived', (event) => {
    const { response } = event
    if (response?.url?.startsWith(baseUrl) && response.status >= 400) {
      const entry = {
        label: 'http_failure',
        status: response.status,
        endpoint_sha256: createHash('sha256').update(new URL(response.url).pathname).digest('hex'),
      }
      recordLocalOwnerHttpFailure({
        tracker: authenticationChallengeTracker,
        requestId: event.requestId,
        status: response.status,
        entry,
        authenticationChallenges,
        failedRequests,
        retain: retainEvidenceEntry,
      })
    }
  }))
  subscriptions.push(client.on('Network.loadingFailed', (event) => {
    authenticationChallengeTracker.observeFailure(event.requestId)
    if (!event.canceled && !String(event.errorText).includes('ERR_ABORTED')) {
      retainEvidenceEntry(failedRequests, diagnosticFingerprint('network_loading_failed', event.errorText))
    }
  }))

  try {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  })
  await client.send('Emulation.setTouchEmulationEnabled', {
    enabled: viewport.mobile,
    maxTouchPoints: viewport.mobile ? 5 : 1,
  })
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await client.send('Page.bringToFront')
  await client.send('Network.clearBrowserCache')
  authenticationChallengeTracker.beginLoginCycle()
  const initialNavigation = await client.send('Page.navigate', { url: `${baseUrl}/?qa=${viewport.id}` })
  if (initialNavigation?.errorText || !initialNavigation?.loaderId) {
    throw new Error(`${viewport.id} initial navigation did not create a loader`)
  }
  let initialAuthentication
  try {
    initialAuthentication = await authenticateLocalOwner(
      client,
      operatorToken,
      `${viewport.id} initial command center`,
      () => authenticationChallengeTracker.closePreSubmitPhase(),
    )
  } finally { authenticationChallengeTracker.closePreSubmitPhase() }
  const startupNavigation = await evaluate(client, `(() => {
    const entry = performance.getEntriesByType('navigation').at(-1);
    const url = new URL(location.href);
    return {
      total_ms: performance.now(),
      time_origin_ms: performance.timeOrigin,
      navigation_start_ms: entry?.startTime ?? null,
      navigation_type: entry?.type ?? null,
      navigation_path: url.pathname,
      navigation_viewport: url.searchParams.get('qa'),
    };
  })()`)
  const snapshotResourceExpression = `(() => {
    const expectedPath = '/api/v1/boards/${scenario.board_id}/snapshot';
    const entries = performance.getEntriesByType('resource').filter((entry) => {
      try { return new URL(entry.name).pathname === expectedPath; } catch { return false; }
    });
    const entry = entries.at(-1);
    return entry && Number.isFinite(entry.duration) ? entry.duration : null;
  })()`
  await waitFor(client, `${snapshotResourceExpression} !== null`, 'authenticated snapshot resource timing')
  await waitFor(
    client,
    AUTHENTICATED_DATA_READY_EXPRESSION,
    'authenticated command center data readiness',
  )
  const snapshot = await evaluate(client, snapshotResourceExpression)
  const dataReadyMs = await evaluate(client, `performance.now()`)
  const startup = Math.max(0, dataReadyMs - initialAuthentication.submit_started_ms)
  const startupProvenance = {
    loader_sha256: createHash('sha256').update(initialNavigation.loaderId).digest('hex'),
    time_origin_ms: startupNavigation.time_origin_ms,
    navigation_start_ms: startupNavigation.navigation_start_ms,
    navigation_type: startupNavigation.navigation_type,
    navigation_path: startupNavigation.navigation_path,
    navigation_viewport: startupNavigation.navigation_viewport,
    login_form_ready_ms: initialAuthentication.login_form_ready_ms,
    login_entry_ms: initialAuthentication.login_entry_ms,
    submit_to_command_center_ms: initialAuthentication.submit_to_command_center_ms,
    command_center_ready_ms: initialAuthentication.command_center_ready_ms,
    command_center_to_data_ready_ms: Math.max(0, dataReadyMs - initialAuthentication.command_center_ready_ms),
    submit_to_data_ready_ms: startup,
    navigation_to_data_ready_ms: dataReadyMs,
    snapshot_resource_ms: snapshot,
    data_ready_selector: AUTHENTICATED_DATA_READY_SELECTOR,
  }

  const journeys = []
  const overflowSamples = []
  const resetJourney = async (name, mode) => {
    authenticationChallengeTracker.beginLoginCycle()
    try {
      return await navigateFreshInteractionMode({
        client,
        url: `${baseUrl}/?qa=${viewport.id}&journey=${encodeURIComponent(name)}&mode=${mode}`,
        name,
        mode,
        waitForReady: () => authenticateLocalOwner(
          client,
          operatorToken,
          `${name} ${mode} fresh navigation`,
          () => authenticationChallengeTracker.closePreSubmitPhase(),
        ),
      })
    } finally { authenticationChallengeTracker.closePreSubmitPhase() }
  }
  const modeReady = async (expression, readinessTimeoutMs = interactionReadinessTimeoutMs) => {
    const deadline = performance.now() + readinessTimeoutMs
    let consecutiveMatches = 0
    while (performance.now() < deadline) {
      if (await evaluate(client, expression)) {
        consecutiveMatches += 1
        if (consecutiveMatches >= 2) return true
      } else {
        consecutiveMatches = 0
      }
      await delay(40)
    }
    return false
  }
  const assertModeReady = async (expression, label, readinessTimeoutMs = asynchronousReadinessTimeoutMs) => {
    if (!await modeReady(expression, readinessTimeoutMs)) throw new Error(`${label} readiness did not pass`)
  }
  const recordJourney = async (name, action, ready, prepare = async () => {}) => {
    const interactionModes = {}
    for (const mode of ['pointer', 'keyboard', 'dom_fallback']) {
      const reset = await resetJourney(name, mode)
      let setupError = null
      try {
        await prepare(mode)
        if (mode === 'keyboard') {
          await evaluate(client, `document.activeElement instanceof HTMLElement && document.activeElement.blur()`)
        }
      } catch (caught) { setupError = safeMessage(caught) }
      const started = performance.now()
      let error = setupError
      let actionEvidence = null
      if (!setupError) {
        try {
          actionEvidence = await action(mode) ?? null
          if (actionEvidence?.error) error = actionEvidence.error
        } catch (caught) { error = safeMessage(caught) }
      }
      const passed = !error && await modeReady(ready)
      const modeElapsed = performance.now() - started
      interactionModes[mode] = {
        passed,
        readiness_asserted: ready,
        elapsed_ms: modeElapsed,
        error,
        action_evidence: actionEvidence,
        setup_error: setupError,
        input_surface: mode === 'pointer' ? (viewport.mobile ? 'mouse_pointer_on_mobile_viewport' : 'mouse')
          : mode === 'keyboard' ? 'keyboard_tab_navigation' : 'dom',
        counts_toward_pass: mode !== 'dom_fallback',
        performance_eligible: mode === 'pointer',
        diagnostic_only: mode === 'dom_fallback',
        reset,
      }
    }
    const retainsPerformance = ['graph overview', 'durable transcript', 'conversation search'].includes(name)
    const elapsed = retainsPerformance
      ? interactionModes.pointer.passed
        ? performanceSampleForJourney(interactionModes)
        : interactionModes.pointer.elapsed_ms
      : interactionModes.pointer.elapsed_ms
    const overflow = await overflowAudit(client)
    overflowSamples.push(overflow)
    const accessibility = await auditSurface(client)
    journeys.push(compactJourneyEvidence({
      name,
      passed: interactionModes.pointer.passed && interactionModes.keyboard.passed,
      elapsed_ms: elapsed,
      performance_sample_mode: retainsPerformance ? 'pointer' : 'diagnostic_only',
      horizontal_overflow_px: overflow.visible_overflow_px,
      overflow_measurement: overflow,
      interaction_modes: interactionModes,
      accessibility,
    }))
    return elapsed
  }

  const graph = await recordJourney(
    'graph overview',
    (mode) => activateMode(client, mode, '#cc-section-tab-work', 'Work', viewport.mobile),
    `document.querySelector('#command-center-content')?.getAttribute('aria-labelledby') === 'cc-section-tab-work'
      && document.querySelectorAll('.ow-graph-nodes > li').length >= 1`,
    async () => {
      await domActivate(client, '#cc-section-tab-activity')
      await waitFor(client, `document.querySelector('#command-center-content')?.getAttribute('aria-labelledby') === 'cc-section-tab-activity'`, 'graph reset state')
    },
  )
  const dependencyGraphNodesRendered = await evaluate(client, `document.querySelectorAll('.ow-graph-nodes > li').length`)
  const transcript = await recordJourney(
    'durable transcript',
    async (mode) => {
      const keyboardSteps = []
      const initialActivation = await activateMode(client, mode, '#cc-section-tab-agents', 'Agents', viewport.mobile)
      if (mode === 'keyboard') keyboardSteps.push(initialActivation)
      await assertModeReady(`Boolean(document.querySelector('.agent-home .ah-search input'))`, 'Agent Home')
      for (let page = 0; page < 20; page += 1) {
        const state = await evaluate(client, `({ count: document.querySelectorAll('.ah-event').length, more: Boolean(document.querySelector('.ah-load-more:not(:disabled)')) })`)
        if (!state.more) break
        const pageActivation = await activateMode(client, mode, '.ah-load-more:not(:disabled)', 'Load more matching events', viewport.mobile)
        if (mode === 'keyboard') keyboardSteps.push(pageActivation)
        await assertModeReady(`document.querySelectorAll('.ah-event').length > ${state.count} || !document.querySelector('.ah-load-more')`, 'additional transcript page')
      }
      if (mode === 'keyboard') return {
        focus_acquisition: 'tab_navigation',
        programmatic_focus: false,
        activation_key: 'Enter',
        tab_events: keyboardSteps.reduce((sum, step) => sum + step.tab_events, 0),
        traversal: keyboardSteps.flatMap((step) => step.traversal ?? []).slice(-24),
        xterm_focus_encounters: keyboardSteps.reduce((sum, step) => sum + step.xterm_focus_encounters, 0),
      }
    },
    `document.querySelectorAll('.ah-event').length >= 250`,
    async () => {
      await domActivate(client, '#cc-section-tab-work')
      await waitFor(client, `document.querySelector('#command-center-content')?.getAttribute('aria-labelledby') === 'cc-section-tab-work'`, 'transcript reset state')
    },
  )
  const transcriptEventsRendered = await evaluate(client, `document.querySelectorAll('.ah-event').length`)
  const modalFocus = await modalFocusAudit(client, viewport.mobile)
  const search = await recordJourney(
    'conversation search',
    async (mode) => {
      if (mode === 'pointer') {
        await pointerClick(
          client,
          viewport.mobile ? '.ah-search label' : '.ah-search input',
          'conversation search input',
          viewport.mobile,
        )
      } else if (mode === 'keyboard') {
        const inputNavigation = await keyboardNavigateTo(client, '.ah-search input', 'conversation search input')
        await dispatchKey(client, 'a', { meta: true })
        await dispatchKey(client, 'Backspace')
        await typeText(client, 'quality')
        await waitFor(client, `document.querySelector('.ah-search input')?.value === 'quality'`, 'typed search query')
        await delay(50)
        const submitNavigation = await keyboardNavigateTo(client, '.ah-search button[type="submit"]', 'Search submit button')
        await dispatchKey(client, 'Enter')
        const searchReady = await modeReady(`(() => {
          const events = [...document.querySelectorAll('.ah-event')];
          return events.length === 5 && events.every((event) => event.textContent?.includes('quality benchmark marker'));
        })()`, asynchronousReadinessTimeoutMs)
        return {
          focus_acquisition: 'tab_navigation',
          programmatic_focus: false,
          activation_key: 'Enter',
          tab_events: inputNavigation.tab_events + submitNavigation.tab_events,
          traversal: [...inputNavigation.traversal, ...submitNavigation.traversal].slice(-24),
          xterm_focus_encounters: inputNavigation.xterm_focus_encounters + submitNavigation.xterm_focus_encounters,
          error: searchReady ? null : 'five rendered search results readiness did not pass',
        }
      } else {
        const focusedByFallback = await evaluate(client, `(() => {
          const input = document.querySelector('.ah-search input');
          if (!(input instanceof HTMLInputElement)) return false;
          input.focus();
          return document.activeElement === input;
        })()`)
        if (!focusedByFallback) throw new Error('DOM fallback could not focus conversation search input')
      }
      const focused = await evaluate(client, `document.activeElement === document.querySelector('.ah-search input')`)
      if (!focused) throw new Error('conversation search input could not receive focus')
      await typeText(client, 'quality')
      await waitFor(client, `document.querySelector('.ah-search input')?.value === 'quality'`, 'typed search query')
      await delay(50)
      if (mode === 'pointer') await pointerClick(client, '.ah-search button[type="submit"]', 'Search', viewport.mobile)
      else {
        const submitted = await evaluate(client, `(() => {
          const form = document.querySelector('.ah-search');
          if (!(form instanceof HTMLFormElement)) return false;
          form.requestSubmit(); return true;
        })()`)
        if (!submitted) throw new Error('conversation search form could not be submitted')
      }
      await assertModeReady(`(() => {
        const events = [...document.querySelectorAll('.ah-event')];
        return events.length === 5 && events.every((event) => event.textContent?.includes('quality benchmark marker'));
      })()`, 'five rendered search results')
      return mode === 'pointer'
        ? { focus_acquisition: 'pointer' }
        : { focus_acquisition: 'dom_fallback' }
    },
    `(() => {
      const events = [...document.querySelectorAll('.ah-event')];
      return events.length === 5 && events.every((event) => event.textContent?.includes('quality benchmark marker'))
        && document.querySelector('.ah-search button[type="submit"]')?.textContent?.trim() === 'Search';
    })()`,
    async () => {
      await domActivate(client, '#cc-section-tab-work')
      await waitFor(client, `document.querySelector('#command-center-content')?.getAttribute('aria-labelledby') === 'cc-section-tab-work'`, 'search reset away from Agent Home')
      await domActivate(client, '#cc-section-tab-agents')
      await assertModeReady(`Boolean(document.querySelector('.agent-home .ah-search input'))`, 'search reset Agent Home')
      for (let page = 0; page < 20; page += 1) {
        const state = await evaluate(client, `({ count: document.querySelectorAll('.ah-event').length, more: Boolean(document.querySelector('.ah-load-more:not(:disabled)')) })`)
        if (!state.more) break
        await domActivate(client, '.ah-load-more:not(:disabled)')
        await assertModeReady(`document.querySelectorAll('.ah-event').length > ${state.count} || !document.querySelector('.ah-load-more')`, 'search reset transcript page')
      }
    },
  )
  const searchMatchesRendered = await evaluate(client, `document.querySelectorAll('.ah-event').length`)

  for (const section of ['work', 'discussions', 'knowledge', 'outcomes', 'activity']) {
    const resetSection = section === 'work' ? 'activity' : 'work'
    await recordJourney(
      `${section} command center view`,
      (mode) => activateMode(client, mode, `#cc-section-tab-${section}`, section, viewport.mobile),
      `document.querySelector('#command-center-content')?.getAttribute('aria-labelledby') === 'cc-section-tab-${section}'`,
      async () => {
        await domActivate(client, `#cc-section-tab-${resetSection}`)
        await waitFor(client, `document.querySelector('#command-center-content')?.getAttribute('aria-labelledby') === 'cc-section-tab-${resetSection}'`, `${section} reset state`)
      },
    )
  }
  for (const view of ['Organization', 'Roadmap', 'Settings', 'Command center']) {
    await recordJourney(
      `${view} primary view`,
      async (mode) => {
        const selector = await selectorForButtonText(client, view)
        if (!selector) throw new Error(`could not find ${view}`)
        return activateMode(client, mode, selector, view, viewport.mobile)
      },
      view === 'Command center'
        ? `Boolean(document.querySelector('.cc-project-nav'))`
        : `Boolean([...document.querySelectorAll('.view-tabs button')].find((button) => button.textContent?.trim() === ${JSON.stringify(view)})?.classList.contains('active'))`,
      async () => {
        const resetView = view === 'Command center' ? 'Organization' : 'Command center'
        const selector = await selectorForButtonText(client, resetView)
        if (selector) await domActivate(client, selector)
      },
    )
  }
  const accessibility = Object.fromEntries(ACCESSIBILITY_GATES.map((gate) => {
    const results = journeys.map((journey) => journey.accessibility[gate])
    return [gate, {
      passed: results.every((result) => result.passed === true),
      surfaces_checked: results.length,
      failures: results.map((result, index) => result.passed === true ? null : {
        journey: journeys[index].name,
        violations: [...(result.violations ?? []), ...(result.unsupported ?? [])],
      }).filter(Boolean),
    }]
  }))
  accessibility.keyboard_focus.modal_focus = modalFocus
  if (modalFocus.supported && !modalFocus.passed) accessibility.keyboard_focus.passed = false
  const metrics = { startup, snapshot_loading: snapshot, transcript_loading: transcript, graph_view: graph, search }
  const authenticationChallengeInventory = authenticationChallengeTracker.inventory()
  if (!authenticationChallengeInventory.passed) {
    retainEvidenceEntry(failedRequests, {
      label: 'invalid_local_owner_challenge_inventory',
      login_cycles: authenticationChallengeInventory.login_cycles,
      total_count: authenticationChallengeInventory.total_count,
    })
  }
  const qualityLinkedPass = {
    startup: true,
    snapshot_loading: true,
    transcript_loading: journeys.find((journey) => journey.name === 'durable transcript')?.interaction_modes.pointer.passed === true,
    graph_view: journeys.find((journey) => journey.name === 'graph overview')?.interaction_modes.pointer.passed === true,
    search: journeys.find((journey) => journey.name === 'conversation search')?.interaction_modes.pointer.passed === true,
  }
  const performanceEvidence = Object.fromEntries(PERFORMANCE_SURFACES.map((surface) => {
    const observed = surface === 'startup' ? metrics.startup : metrics[surface]
    const measurementMode = surface === 'startup' ? 'authenticated_submit_to_ready'
      : surface === 'snapshot_loading' ? 'authenticated_fetch' : 'pointer'
    return [surface, {
      observed_ms: observed,
      measurement_mode: measurementMode,
      quality_gate_passed: qualityLinkedPass[surface],
      ...(surface === 'startup' ? { provenance: startupProvenance } : {}),
      ...budgetFor(baseline, viewport.id, surface),
    }]
  }))
  overflowSamples.push(await overflowAudit(client))
  const maximumOverflow = Math.max(0, ...overflowSamples.map((sample) => sample.visible_overflow_px))
  const maximumDocumentExtent = Math.max(0, ...overflowSamples.map((sample) => sample.document_extent_overflow_px))
  const overflowOffenders = overflowSamples.flatMap((sample) => sample.offenders)
    .filter((row, index, rows) => rows.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(row)) === index)
    .slice(0, 25)
  const excludedOverflow = overflowSamples.flatMap((sample) => sample.excluded_nonvisual_or_contained)
    .filter((row, index, rows) => rows.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(row)) === index)
    .slice(0, 25)
  return redactEvidence({
    ...viewport,
    browser_surface: 'standalone_chromium_cdp_fallback',
    journeys,
    horizontal_overflow_px: maximumOverflow,
    overflow_measurement: {
      visible_overflow_px: maximumOverflow,
      document_extent_overflow_px: maximumDocumentExtent,
      offenders: overflowOffenders,
      excluded_nonvisual_or_contained: excludedOverflow,
    },
    overflow_offenders: overflowOffenders,
    console_errors: consoleErrors,
    page_errors: pageErrors,
    failed_requests: failedRequests,
    authentication_challenges: authenticationChallenges,
    authentication_challenge_inventory: authenticationChallengeInventory,
    accessibility,
    readiness: {
      dependency_graph_nodes_rendered: dependencyGraphNodesRendered,
      transcript_events_rendered: transcriptEventsRendered,
      search_matches_rendered: searchMatchesRendered,
      expected_search_matches: 5,
      modal_focus: modalFocus,
    },
    performance: performanceEvidence,
  })
  } finally {
    for (const unsubscribe of subscriptions) unsubscribe()
  }
}

const stopChild = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'close'), delay(5_000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

const sourceEvidence = (manifest, currentSource, bindingStatus) => ({
  repository: manifest?.repository ?? currentSource?.repository ?? null,
  commit: manifest?.source_commit ?? currentSource?.source_commit ?? null,
  source_status: manifest?.source_status ?? currentSource?.source_status ?? 'unavailable',
  source_tree_sha256: manifest?.source_tree_sha256 ?? currentSource?.source_tree_sha256 ?? null,
  node: process.versions.node,
  artifact_identity: manifest?.artifact_identity ?? null,
  build_manifest_sha256: manifest?.sha256 ?? null,
  binding_status: bindingStatus,
})

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const daemonStdout = [], daemonStderr = [], chromeStderr = []
  let daemon, chrome, client, operatorToken = ''
  let buildManifest = null
  let runRoot = null
  let activeViewport = null
  let completeEvidenceWritten = false
  const completedViewports = []
  try {
    if (process.versions.node !== '22.20.0') {
      throw new Error(`QA browser gates require Node 22.20.0, received ${process.versions.node}`)
    }
    if (options.writeArtifactManifest) {
      const manifest = await writeBuildManifest(options.writeArtifactManifest)
      console.log(`QA build manifest: ${options.writeArtifactManifest}`)
      console.log(`manifest sha256: ${manifest.sha256}`)
      return
    }
    buildManifest = await loadBuildManifest(options.artifactManifest)
    for (const required of ['dist/cli.js', 'web/dist/index.html']) {
      if (!existsSync(join(repositoryRoot, required))) throw new Error(`missing ${required}; build root and web before this gate`)
    }
    if (!existsSync(options.chrome)) throw new Error(`Chrome executable not found: ${options.chrome}`)
    const baseline = options.captureOnly ? null : loadBaseline(options.baseline, buildManifest.artifact_identity)
    runRoot = mkdtempSync(join(tmpdir(), 'orchestra-browser-quality-'))
    const orchestraHome = join(runRoot, 'orchestra-home')
    const chromeProfile = join(runRoot, 'chrome-profile')
    const fakeCodex = join(runRoot, 'fake-codex')
    const fakeCodexState = join(runRoot, 'fake-codex-state.json')
    copyFileSync(join(repositoryRoot, 'test', 'fixtures', 'fake-codex-app-server.mjs'), fakeCodex)
    chmodSync(fakeCodex, 0o755)
    const daemonPort = await unusedPort()
    const chromePort = await unusedPort()
    const baseUrl = `http://127.0.0.1:${daemonPort}`
    const environment = {
      ...process.env,
      ORCHESTRA_AUTOSHIP: '0',
      ORCHESTRA_AUTOWAKE: '0',
      ORCHESTRA_CODEX_PROVIDER_CONTRACT: '0',
      ORCHESTRA_CANONICAL_LAUNCH: '1',
      ORCHESTRA_CODEX_COMMAND: fakeCodex,
      ORCHESTRA_CODEX_FORWARD_ENV: 'FAKE_CODEX_STATE',
      ORCHESTRA_HOME: orchestraHome,
      ORCHESTRA_MAX_LAUNCHED: '1',
      ORCHESTRA_PORT: String(daemonPort),
      FAKE_CODEX_STATE: fakeCodexState,
    }
    daemon = spawn(process.execPath, [join(repositoryRoot, 'dist/cli.js'), 'serve'], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    daemon.stdout.on('data', (chunk) => retainChunk(daemonStdout, chunk))
    daemon.stderr.on('data', (chunk) => retainChunk(daemonStderr, chunk))
    await waitForJson(`${baseUrl}/health`, (body) => body.ok === true)
    const tokenPath = join(orchestraHome, 'token')
    const tokenDeadline = Date.now() + timeoutMs
    while (!existsSync(tokenPath) && Date.now() < tokenDeadline) await delay(40)
    if (!existsSync(tokenPath)) throw new Error('operator token was not created')
    operatorToken = readFileSync(tokenPath, 'utf8').trim()
    if (!operatorToken) throw new Error('operator token is empty')
    const authHeaders = { authorization: `Bearer ${operatorToken}` }
    const scenario = await seedScenario(baseUrl, authHeaders)

    chrome = spawn(options.chrome, [
      '--headless=new',
      `--remote-debugging-port=${chromePort}`,
      `--user-data-dir=${chromeProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--metrics-recording-only',
      '--safebrowsing-disable-auto-update',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    chrome.stderr.on('data', (chunk) => retainChunk(chromeStderr, chunk))
    await waitForJson(`http://127.0.0.1:${chromePort}/json/version`, (body) => Boolean(body.webSocketDebuggerUrl))
    const page = await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent('about:blank')}`, {
      method: 'PUT', signal: AbortSignal.timeout(5_000),
    }).then((response) => response.json())
    client = new CdpClient(page.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([
      client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable'),
      client.send('Log.enable'), client.send('Performance.enable'), client.send('DOM.enable'),
    ])
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        localStorage.setItem('orchestra-command-center-onboarding', 'complete');
        localStorage.setItem('orchestra-view', 'board');
      `,
    })

    const requestedViewport = process.env.ORCHESTRA_QA_VIEWPORT
    const viewportMatrix = requestedViewport
      ? RESPONSIVE_VIEWPORTS.filter((viewport) => viewport.id === requestedViewport)
      : RESPONSIVE_VIEWPORTS
    if (requestedViewport && viewportMatrix.length !== 1) throw new Error(`unknown QA viewport: ${requestedViewport}`)
    const viewports = completedViewports
    for (const viewport of viewportMatrix) {
      activeViewport = viewport.id
      viewports.push(await measureViewport({ client, viewport, baseUrl, baseline, scenario, operatorToken }))
    }
    activeViewport = null
    const finalManifest = await loadBuildManifest(options.artifactManifest)
    assertFinalBuildManifest(buildManifest, finalManifest)
    buildManifest = finalManifest
    const evidence = redactEvidence({
      schema_version: BROWSER_QUALITY_SCHEMA_VERSION,
      captured_at: new Date().toISOString(),
      backlog_items: ['QA-013', 'QA-014', 'QA-015'],
      evidence_boundary: {
        in_app_browser_available: false,
        in_app_browser_inventory: [],
        surface: 'standalone_chromium_cdp_fallback',
        qa_013_closure_permitted: false,
      },
      source: sourceEvidence(buildManifest, null, 'passed_preflight_and_final'),
      scenario,
      methodology: {
        isolation: 'disposable Orchestra home and Chrome profile; every pointer, keyboard, and DOM fallback mode starts with a unique same-artifact Page.navigate loader and authenticates through the real loopback login without browser token persistence',
        fixture_transport: 'board, agents, card, workspace, canonical job/session, profile, conversation, and events created through authenticated public APIs',
        failure_artifacts: 'bounded redacted JSON only; no page HTML, response body, transcript, storage, or screenshot capture',
        interaction_readiness: `two consecutive 40ms observations; ${interactionReadinessTimeoutMs}ms interaction bound and ${asynchronousReadinessTimeoutMs}ms asynchronous render bound`,
        performance_quality_link: 'pointer-only timing is retained separately from pointer quality; a fast failed attempt never becomes a quality pass',
        budgets: options.captureOnly
          ? 'observation-only: no budget is derived from this run'
          : 'explicit beta experience ceilings bounded by a checked three-run regression baseline',
      },
      viewports,
    })
    const finalEvidence = finalizeValidatedBrowserEvidence(
      evidence,
      (document) => validateBrowserQualityEvidence(document, { requireBudgets: !options.captureOnly }),
    )
    const errors = finalEvidence.validation_errors
    const output = options.output
    writeBrowserArtifact(repositoryRoot, output, finalEvidence)
    completeEvidenceWritten = true
    console.log(`QA browser evidence: ${output}`)
    console.log(`viewports: ${viewports.map((viewport) => `${viewport.id}=${viewport.journeys.length} journeys`).join(', ')}`)
    console.log(`evidence sha256: ${finalEvidence.sha256}`)
    if (errors.length && !options.captureOnly) {
      throw new Error(`browser quality gates failed: ${errors.join('; ')}`)
    }
    if (errors.length) console.warn(`capture-only observed ${errors.length} failing gate(s)`)
  } catch (error) {
    const stripRunToken = (value) => operatorToken ? String(value).split(operatorToken).join('[REDACTED]') : value
    let currentSource = null
    let finalManifest = null
    let manifestError = null
    try { currentSource = await trackedSourceState() } catch (sourceError) {
      manifestError = `source identity unavailable: ${safeMessage(sourceError)}`
    }
    if (!options.writeArtifactManifest) {
      try { finalManifest = await loadBuildManifest(options.artifactManifest) } catch (caught) {
        manifestError = safeMessage(caught)
      }
    }
    const diagnostics = redactEvidence({
      error: safeMessage(error),
      manifest_error: manifestError,
      daemon_stdout: diagnosticFingerprint('daemon_stdout', stripRunToken(boundedText(daemonStdout))),
      daemon_stderr: diagnosticFingerprint('daemon_stderr', stripRunToken(boundedText(daemonStderr))),
      chrome_stderr: diagnosticFingerprint('chrome_stderr', stripRunToken(boundedText(chromeStderr))),
    })
    const failureEvidence = redactEvidence({
      schema_version: BROWSER_QUALITY_SCHEMA_VERSION,
      captured_at: new Date().toISOString(),
      incomplete: true,
      backlog_items: ['QA-013', 'QA-014', 'QA-015'],
      evidence_boundary: {
        in_app_browser_available: false,
        surface: 'standalone_chromium_cdp_fallback',
        qa_013_closure_permitted: false,
      },
      source: sourceEvidence(
        finalManifest,
        currentSource,
        finalManifest ? 'passed_at_failure' : 'failed_or_unavailable',
      ),
      active_viewport: activeViewport,
      completed_viewports: completedViewports,
      diagnostics,
    })
    const fatalEvidence = finalizeBrowserEvidence(failureEvidence, [safeMessage(error)], 'fatal')
    if (!completeEvidenceWritten) writeBrowserArtifact(repositoryRoot, options.output, fatalEvidence)
    console.error(JSON.stringify(diagnostics, null, 2))
    throw error
  } finally {
    client?.close()
    await stopChild(chrome)
    await stopChild(daemon)
    if (runRoot) rmSync(runRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(safeMessage(error))
  process.exitCode = 1
})
