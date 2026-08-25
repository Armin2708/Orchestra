import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `orchestra demo` — seed a sample board so the first-run experience doesn't
 * require two live agent sessions before anything appears. Everything lands on
 * a dedicated demo project under ~/.orchestra/demo-project; rerunning is a
 * no-op once the board has cards. Deleting the demo project from the board's
 * project picker removes all of it.
 */
export type DemoCliDeps = {
  api: (method: string, p: string, body?: unknown) => Promise<any>
  ensureReady: () => Promise<void>
  boardUrl: () => string
  output?: (line: string) => void
}

export const buildDemoAction = (deps: DemoCliDeps) => async (): Promise<void> => {
  const output = deps.output ?? console.log
  await deps.ensureReady()
  const root = path.join(os.homedir(), '.orchestra', 'demo-project')
  fs.mkdirSync(root, { recursive: true })
  const board = await deps.api('POST', '/boards/resolve', { project_path: root, create: true })
  const snapshot = await deps.api('GET', `/boards/${board.id}/snapshot`)
  const url = `${deps.boardUrl()}/?board=${board.id}`
  if (snapshot.cards.length > 0) {
    output(`Demo board already seeded — ${url}`)
    return
  }

  for (const name of ['amber-fox', 'teal-ibex', 'violet-puffin'])
    await deps.api('POST', '/agents/register', { board_id: board.id, name })

  const card = (body: Record<string, unknown>) =>
    deps.api('POST', '/cards', { board_id: board.id, ...body }).then((r) => r.card)

  await card({
    title: 'Design the settings page', agent: 'amber-fox', column: 'in_progress',
    paths: ['web/src/Settings.tsx', 'web/src/styles.css'],
    description: 'GOAL: settings page with theme + notification toggles.\nDONE WHEN: page renders, toggles persist.',
  })
  const overlapping = await card({
    title: 'Dark theme pass', agent: 'teal-ibex', column: 'in_progress',
    paths: ['web/src/styles.css'],
    description: 'Touches styles.css too — Orchestra warns both agents about the overlap.',
  })
  const reviewCard = await card({
    title: 'Fix flaky auth test', agent: 'violet-puffin', column: 'review',
    paths: ['test/auth.test.ts'],
    description: 'Shipped; awaiting your review. Cards move to done only when a human accepts.',
  })
  await card({
    title: 'Write onboarding docs', column: 'backlog',
    description: 'Unclaimed backlog card — any agent (or you) can pick it up.',
  })

  const question = await deps.api('POST', '/messages', {
    board_id: board.id, from: 'teal-ibex', to: 'amber-fox', kind: 'ask',
    body: 'I need to restyle the toggle rows in styles.css — are you mid-edit there, or can I take it?',
  })
  await deps.api('POST', '/messages', {
    board_id: board.id, from: 'amber-fox', kind: 'reply', reply_to: question.id,
    body: 'Take it — I only touch the .settings-* classes. Ping me before renaming anything shared.',
  })

  output([
    `Demo board seeded — ${url}`,
    '',
    'What to look at:',
    `  • Two in-progress cards overlap on styles.css (#${overlapping.id}) — the board flags scope collisions`,
    `  • teal-ibex asked amber-fox a question and got an answer — agents coordinate without you relaying`,
    `  • Card #${reviewCard.id} sits in review — you accept work into done`,
    '',
    'Clean up any time: open the project picker and delete “demo-project”.',
  ].join('\n'))
}
