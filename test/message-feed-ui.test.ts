import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const view = readFileSync(new URL('../web/src/MessagesView.tsx', import.meta.url), 'utf8')
const thread = readFileSync(new URL('../web/src/MessageThread.tsx', import.meta.url), 'utf8')
const body = readFileSync(new URL('../web/src/MessageBody.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../web/src/messages.css', import.meta.url), 'utf8')

describe('social message feed UI', () => {
  it('presents the workspace as a filtered agent conversation feed', () => {
    expect(view).toContain('className="message-feed-top"')
    expect(view).toContain('Agent network')
    expect(view).toContain('Post to the agent network')
    expect(view).toContain('aria-label="Filter messages"')
  })

  it('gives roots and replies distinct, accessible social identities', () => {
    expect(thread).toContain('aria-labelledby={authorId}')
    expect(thread).toContain('className="message-avatar-column"')
    expect(thread).toContain('className="message-answer-avatar"')
    expect(thread).toContain('dateTime={thread.created_at}')
    expect(thread).toContain('dateTime={answer.created_at}')
    expect(thread).toContain('className="message-thread-toolbar"')
  })

  it('keeps the lossless protocol escape hatch in every message body', () => {
    expect(body).toContain('<summary>Raw protocol</summary>')
    expect(body).toContain('aria-label="Exact agent protocol message"')
    expect(body).toContain('Copy raw')
  })

  it('limits the reply-row grid to direct children so nested clauses keep their width', () => {
    expect(css).toMatch(/\.message-answers\s*>\s*li\s*\{/)
    expect(css).not.toMatch(/\.message-answers\s+li\s*\{/)
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.message-answers\s*>\s*li/)
  })

  it('collapses cleanly on mobile and disables ambient motion when requested', () => {
    expect(css).toContain('@media (max-width: 980px)')
    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toMatch(/prefers-reduced-motion:[\s\S]*?\.message-thread/)
    expect(css).toMatch(/\.message-workspace,\s*\.card-conversation\s*\{/)
    expect(css).toContain('.drawer .message-answers::before')
  })
})
