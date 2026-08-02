#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import {
  ACCESSIBILITY_GATES,
  BROWSER_QUALITY_SCHEMA_VERSION,
  PERFORMANCE_SURFACES,
  RESPONSIVE_VIEWPORTS,
  deriveBudgetMs,
  evidenceDigest,
  redactEvidence,
  validateBrowserQualityEvidence,
} from './lib/browser-quality.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const timeoutMs = 20_000

const parseArgs = (argv) => {
  const options = {
    chrome: process.env.ORCHESTRA_QA_CHROME || defaultChrome,
    output: null,
    baseline: null,
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
    else if (key === '--output' && value) options.output = resolve(value)
    else if (key === '--baseline' && value) options.baseline = resolve(value)
    else throw new Error(`unknown or incomplete argument: ${key}`)
    index += 1
  }
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
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  })
  const text = await response.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${String(text).slice(0, 300)}`)
  return parsed
}

const seedScenario = async (baseUrl, orchestraHome) => {
  const board = await jsonRequest(baseUrl, 'POST', '/api/v1/boards/resolve', {
    project_path: repositoryRoot,
  })
  await Promise.all(Array.from({ length: 18 }, (_, index) => jsonRequest(
    baseUrl,
    'POST',
    '/api/v1/agents/register',
    { board_id: board.id, name: `qa-agent-${String(index + 1).padStart(2, '0')}` },
  )))
  const profileResponse = await jsonRequest(
    baseUrl,
    'POST',
    `/api/v1/os/boards/${board.id}/agent-profiles`,
    { name: 'QA Browser Agent', default_provider: 'codex', role: 'quality' },
    { 'idempotency-key': 'qa-browser-profile' },
  )
  const profileId = profileResponse.profile.id
  const home = await jsonRequest(baseUrl, 'GET', `/api/v1/os/agent-profiles/${profileId}/home`)
  const conversationId = home.home.conversations[0].id
  const workspaceId = 'qa-browser-workspace'
  const sessionId = 'qa-browser-session'
  const db = new Database(join(orchestraHome, 'orchestra.db'))
  db.pragma('foreign_keys = ON')
  try {
    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status)
      VALUES (?, ?, 'QA browser workspace', 'shared', ?, 'active')`)
      .run(workspaceId, board.id, repositoryRoot)
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, external_id, model, status, context_json)
      VALUES (?, ?, 'codex', 'qa-browser-thread', 'qa-browser-model', 'idle', '{}')`)
      .run(sessionId, workspaceId)
  } finally { db.close() }
  await jsonRequest(baseUrl, 'POST', `/api/v1/os/sessions/${sessionId}/link`, {
    profile_id: profileId,
    conversation_id: conversationId,
    mode: 'ambient',
    driver_id: 'qa-browser-fixture',
  }, { 'idempotency-key': 'qa-browser-session-link' })
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
      { 'idempotency-key': `qa-browser-event-${index}` },
    )))
  }
  return {
    board_id: board.id,
    profile_id: profileId,
    session_id: sessionId,
    transcript_events: events.length,
    graph_agents: 18,
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
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed')
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

const click = async (client, selector, label) => {
  const clicked = await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`could not click ${label}`)
}

const clickButtonText = async (client, text) => {
  const clicked = await evaluate(client, `(() => {
    const element = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === ${JSON.stringify(text)});
    if (!element) return false;
    element.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`could not click ${text}`)
}

const horizontalOverflow = (client) => evaluate(client, `Math.max(
  0,
  document.documentElement.scrollWidth - document.documentElement.clientWidth,
  document.body?.scrollWidth - document.documentElement.clientWidth,
)`)

const overflowOffenders = (client) => evaluate(client, `(() => {
  const width = document.documentElement.clientWidth;
  return [...document.querySelectorAll('body *')].filter((element) => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0
      && (rect.right > width + .5 || rect.left < -.5);
  }).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(), id: element.id || null,
      class_name: String(element.className || '').slice(0, 120),
      left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width),
    };
  }).slice(0, 25);
})()`)

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
  const parse = (value) => {
    const match = String(value).match(/^rgba?\\(\\s*([\\d.]+)[, ]+([\\d.]+)[, ]+([\\d.]+)(?:\\s*[,/]\\s*([\\d.]+))?\\s*\\)$/i);
    return match ? { r: +match[1], g: +match[2], b: +match[3], a: match[4] === undefined ? 1 : +match[4] } : null;
  };
  const channel = (value) => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; };
  const lum = (color) => .2126 * channel(color.r) + .7152 * channel(color.g) + .0722 * channel(color.b);
  const background = (element) => {
    for (let current = element; current; current = current.parentElement) {
      const parsed = parse(getComputedStyle(current).backgroundColor);
      if (parsed && parsed.a === 1) return parsed;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const rows = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent?.trim();
    const element = walker.currentNode.parentElement;
    if (!text || !element || element.closest('[aria-hidden="true"],.sr-only') || element.matches('script,style')) continue;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.width === 0 || rect.height === 0) continue;
    if (element.closest('button:disabled,input:disabled,select:disabled,textarea:disabled')) continue;
    const foreground = parse(style.color), bg = background(element);
    if (!foreground || foreground.a !== 1) continue;
    const ratio = (Math.max(lum(foreground), lum(bg)) + .05) / (Math.min(lum(foreground), lum(bg)) + .05);
    const large = parseFloat(style.fontSize) >= (Number(style.fontWeight) >= 700 ? 18.66 : 24);
    const required = large ? 3 : 4.5;
    if (ratio + .01 < required) rows.push({
      tag: element.tagName.toLowerCase(), class_name: String(element.className || '').slice(0, 100),
      text: text.slice(0, 80), ratio: Math.round(ratio * 100) / 100, required,
    });
  }
  return { passed: rows.length === 0, checked: true, violations: rows.slice(0, 25) };
})()`)

const keyboardAudit = async (client) => {
  await evaluate(client, `document.activeElement instanceof HTMLElement && document.activeElement.blur()`)
  const focusOrder = []
  const violations = []
  for (let index = 0; index < 12; index += 1) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    const focused = await evaluate(client, `(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement) || element === document.body) return null;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return {
        key: element.id || element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 80) || element.tagName,
        visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
        focus_visible: element.matches(':focus-visible'),
        outline: style.outlineStyle,
      };
    })()`)
    if (!focused) {
      violations.push({ step: index + 1, reason: 'focus did not reach an interactive element' })
      continue
    }
    focusOrder.push(focused.key)
    if (!focused.visible) violations.push({ step: index + 1, reason: 'focused element is outside the viewport', key: focused.key })
    if (!focused.focus_visible && (focused.outline === 'none' || focused.outline === '')) {
      violations.push({ step: index + 1, reason: 'focus indicator is not visible', key: focused.key })
    }
  }
  if (new Set(focusOrder).size < 5) violations.push({ reason: 'keyboard traversal reached fewer than five unique controls' })
  return { passed: violations.length === 0, checked: focusOrder.length, focus_order: focusOrder, violations }
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

const loadBaseline = (path) => path ? JSON.parse(readFileSync(path, 'utf8')) : null

const budgetFor = (baseline, viewportId, surface, observed) => {
  const baselineMetric = baseline?.viewports?.find((viewport) => viewport.id === viewportId)?.performance?.[surface]
  const source = Number(baselineMetric?.observed_ms)
  return {
    budget_ms: deriveBudgetMs(Number.isFinite(source) && source > 0 ? source : Math.max(observed, 0.01)),
    budget_source: Number.isFinite(source) && source > 0 ? 'checked_observation' : 'capture_only',
  }
}

const measureViewport = async ({ client, viewport, baseUrl, baseline }) => {
  const consoleErrors = []
  const pageErrors = []
  const failedRequests = []
  client.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error') consoleErrors.push(event.args?.map((arg) => arg.value ?? arg.description ?? '').join(' '))
  })
  client.on('Runtime.exceptionThrown', (event) => pageErrors.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? 'page exception'))
  client.on('Network.responseReceived', (event) => {
    const { response } = event
    if (response?.url?.startsWith(baseUrl) && response.status >= 400) {
      failedRequests.push({ url: response.url, status: response.status })
    }
  })
  client.on('Network.loadingFailed', (event) => {
    if (!event.canceled && !String(event.errorText).includes('ERR_ABORTED')) failedRequests.push({ error: event.errorText })
  })

  await client.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  })
  await client.send('Network.clearBrowserCache')
  await client.send('Page.navigate', { url: `${baseUrl}/?qa=${viewport.id}` })
  await waitFor(client, `document.readyState === 'complete' && Boolean(document.querySelector('.board-section-tabs'))`, 'initial board')
  const startup = await evaluate(client, `performance.now()`)
  const snapshot = await evaluate(client, `(async () => {
    const boards = await fetch('/api/v1/boards').then((response) => response.json());
    const started = performance.now();
    const response = await fetch('/api/v1/boards/' + boards[0].id + '/snapshot');
    if (!response.ok) throw new Error('snapshot request failed: ' + response.status);
    await response.json();
    return performance.now() - started;
  })()`)

  const journeys = []
  const overflowSamples = []
  const recordJourney = async (name, action, ready) => {
    const started = performance.now()
    await action()
    await waitFor(client, ready, name)
    const elapsed = performance.now() - started
    const overflow = await horizontalOverflow(client)
    overflowSamples.push(overflow)
    journeys.push({ name, passed: true, elapsed_ms: elapsed, horizontal_overflow_px: overflow })
    return elapsed
  }

  const graph = await recordJourney(
    'graph overview',
    () => click(client, '#board-tab-overview', 'Overview'),
    `Boolean(document.querySelector('.network .network-scene'))`,
  )
  const transcript = await recordJourney(
    'durable transcript',
    () => click(client, '#board-tab-agents', 'Agents'),
    `Boolean(document.querySelector('.agent-home .ah-search input'))`,
  )
  const search = await recordJourney(
    'conversation search',
    async () => {
      const prepared = await evaluate(client, `(() => {
        const input = document.querySelector('.ah-search input');
        if (!(input instanceof HTMLInputElement)) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'quality');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const form = input.closest('form');
        if (!form) return false;
        form.requestSubmit();
        return true;
      })()`)
      if (!prepared) throw new Error('conversation search could not be submitted')
    },
    `(() => { const button = document.querySelector('.ah-search button[type="submit"]'); return Boolean(button && button.textContent?.trim() === 'Search'); })()`,
  )

  for (const tab of ['messages', 'workspace', 'timeline', 'shipped']) {
    await recordJourney(
      `${tab} board view`,
      () => click(client, `#board-tab-${tab}`, tab),
      `document.querySelector('#board-section-panel')?.getAttribute('aria-labelledby') === 'board-tab-${tab}'`,
    )
  }
  for (const view of ['Open Work', 'Organization', 'Roadmap', 'Settings', 'Board']) {
    await recordJourney(
      `${view} primary view`,
      () => clickButtonText(client, view),
      view === 'Board'
        ? `Boolean(document.querySelector('.board-section-tabs'))`
        : `Boolean([...document.querySelectorAll('.view-tabs button')].find((button) => button.textContent?.trim() === ${JSON.stringify(view)})?.classList.contains('active'))`,
    )
  }
  await click(client, '#board-tab-agents', 'Agents')
  await waitFor(client, `Boolean(document.querySelector('.agent-home .ah-search input'))`, 'Agent Home for accessibility audit')

  const accessibility = {
    accessible_names: await accessibleNameAudit(client),
    keyboard_focus: await keyboardAudit(client),
    screen_reader_tree: await screenReaderAudit(client),
    text_contrast: await contrastAudit(client),
  }
  const metrics = { startup, snapshot_loading: snapshot, transcript_loading: transcript, graph_view: graph, search }
  const performanceEvidence = Object.fromEntries(PERFORMANCE_SURFACES.map((surface) => {
    const observed = surface === 'startup' ? metrics.startup : metrics[surface]
    return [surface, { observed_ms: observed, ...budgetFor(baseline, viewport.id, surface, observed) }]
  }))
  const maximumOverflow = Math.max(0, ...overflowSamples, await horizontalOverflow(client))
  return redactEvidence({
    ...viewport,
    browser_surface: 'standalone_chromium_cdp_fallback',
    journeys,
    horizontal_overflow_px: maximumOverflow,
    overflow_offenders: maximumOverflow > 0 ? await overflowOffenders(client) : [],
    console_errors: consoleErrors,
    page_errors: pageErrors,
    failed_requests: failedRequests.filter((request) => !String(request.url ?? '').includes('/events')),
    accessibility,
    performance: performanceEvidence,
  })
}

const stopChild = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'close'), delay(5_000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (process.versions.node !== '22.20.0') throw new Error(`QA browser gates require Node 22.20.0, received ${process.versions.node}`)
  if (!existsSync(options.chrome)) throw new Error(`Chrome executable not found: ${options.chrome}`)
  for (const required of ['dist/cli.js', 'web/dist/index.html']) {
    if (!existsSync(join(repositoryRoot, required))) throw new Error(`missing ${required}; build root and web before this gate`)
  }
  const baseline = loadBaseline(options.baseline)
  const runRoot = mkdtempSync(join(tmpdir(), 'orchestra-browser-quality-'))
  const orchestraHome = join(runRoot, 'orchestra-home')
  const chromeProfile = join(runRoot, 'chrome-profile')
  const daemonPort = await unusedPort()
  const chromePort = await unusedPort()
  const baseUrl = `http://127.0.0.1:${daemonPort}`
  const environment = {
    ...process.env,
    ORCHESTRA_AUTOSHIP: '0',
    ORCHESTRA_AUTOWAKE: '0',
    ORCHESTRA_CODEX_PROVIDER_CONTRACT: '0',
    ORCHESTRA_HOME: orchestraHome,
    ORCHESTRA_NO_AUTH: '1',
    ORCHESTRA_PORT: String(daemonPort),
  }
  const daemonStdout = [], daemonStderr = [], chromeStderr = []
  let daemon, chrome, client
  try {
    daemon = spawn(process.execPath, [join(repositoryRoot, 'dist/cli.js'), 'serve'], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    daemon.stdout.on('data', (chunk) => daemonStdout.push(chunk))
    daemon.stderr.on('data', (chunk) => daemonStderr.push(chunk))
    await waitForJson(`${baseUrl}/health`, (body) => body.ok === true)
    const scenario = await seedScenario(baseUrl, orchestraHome)

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
    chrome.stderr.on('data', (chunk) => chromeStderr.push(chunk))
    await waitForJson(`http://127.0.0.1:${chromePort}/json/version`, (body) => Boolean(body.webSocketDebuggerUrl))
    const page = await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(`${baseUrl}/`)}`, {
      method: 'PUT', signal: AbortSignal.timeout(5_000),
    }).then((response) => response.json())
    client = new CdpClient(page.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([
      client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable'),
      client.send('Log.enable'), client.send('Performance.enable'),
    ])

    const viewports = []
    for (const viewport of RESPONSIVE_VIEWPORTS) {
      viewports.push(await measureViewport({ client, viewport, baseUrl, baseline }))
    }
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
      source: {
        repository: basename(repositoryRoot),
        commit: await new Promise((resolveCommit, reject) => {
          const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] })
          const chunks = []
          child.stdout.on('data', (chunk) => chunks.push(chunk))
          child.once('error', reject)
          child.once('close', (code) => code === 0 ? resolveCommit(boundedText(chunks).trim()) : reject(new Error('git rev-parse failed')))
        }),
        node: process.versions.node,
      },
      scenario,
      methodology: {
        isolation: 'disposable Orchestra home and Chrome profile on loopback with authentication disabled',
        failure_artifacts: 'bounded redacted JSON only; no page HTML, response body, transcript, storage, or screenshot capture',
        budgets: options.baseline ? 'derived from checked observation p95 using max(4x, +100ms)' : 'capture-only budgets derived from this observation',
      },
      viewports,
    })
    evidence.sha256 = evidenceDigest(evidence)
    const errors = validateBrowserQualityEvidence(evidence)
    const output = options.output ?? join(runRoot, 'browser-quality-evidence.json')
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify({ ...evidence, validation_errors: errors }, null, 2)}\n`, { mode: 0o600 })
    console.log(`QA browser evidence: ${output}`)
    console.log(`viewports: ${viewports.map((viewport) => `${viewport.id}=${viewport.journeys.length} journeys`).join(', ')}`)
    console.log(`evidence sha256: ${evidence.sha256}`)
    if (errors.length && !options.captureOnly) {
      throw new Error(`browser quality gates failed: ${errors.join('; ')}`)
    }
    if (errors.length) console.warn(`capture-only observed ${errors.length} failing gate(s)`)
  } catch (error) {
    const diagnostics = redactEvidence({
      error: error instanceof Error ? error.message : String(error),
      daemon_stdout: boundedText(daemonStdout),
      daemon_stderr: boundedText(daemonStderr),
      chrome_stderr: boundedText(chromeStderr),
    })
    console.error(JSON.stringify(diagnostics, null, 2))
    throw error
  } finally {
    client?.close()
    await stopChild(chrome)
    await stopChild(daemon)
    rmSync(runRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
