import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const view = readFileSync(new URL('../web/src/MessagesView.tsx', import.meta.url), 'utf8')
const thread = readFileSync(new URL('../web/src/MessageThread.tsx', import.meta.url), 'utf8')
const body = readFileSync(new URL('../web/src/MessageBody.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../web/src/messages.css', import.meta.url), 'utf8')

describe('email-style inbox UI', () => {
  it('presents the workspace as a two-pane inbox with mailbox tabs', () => {
    expect(view).toContain('className="inbox-list"')
    expect(view).toContain('className="inbox-detail"')
    expect(view).toContain('aria-label="Mailboxes"')
    expect(view).toContain('MAILBOXES.map')
  })

  it('renders rows as mail: sender, subject line, snippet, unread state', () => {
    expect(view).toContain('splitSubject')
    expect(view).toContain('inbox-row-subject')
    expect(view).toContain('inbox-row-snippet')
    expect(view).toContain('inbox-unread-dot')
    expect(view).toContain('isUnread')
  })

  it('marks a thread read on open and when new replies render in it', () => {
    expect(view).toContain('markRead')
    expect(view).toContain('latestForeignId')
    expect(view).toContain('saveReadMap')
  })

  it('docks an inline reply that answers straight back over the bus', () => {
    expect(view).toContain('className="inbox-reply"')
    expect(view).toContain("kind: 'reply'")
    expect(view).toContain('reply_to: thread.id')
    expect(view).toContain('Send answer')
  })

  it('keeps a compose path and a mobile back affordance', () => {
    expect(view).toContain('MessageComposer')
    expect(view).toContain('inbox-back')
    expect(view).toContain('detail-open')
  })

  it('gives conversation entries accessible identities (legacy thread view intact)', () => {
    expect(thread).toContain('aria-labelledby={authorId}')
    expect(thread).toContain('dateTime={thread.created_at}')
    expect(view).toContain('dateTime={message.created_at}')
    expect(view).toContain('dateTime={last.created_at}')
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

  it('collapses to a single pane on mobile and keeps motion preferences', () => {
    expect(css).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.inbox-workspace\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/)
    expect(css).toMatch(/\.inbox-workspace\.detail-open \.inbox-detail \{ display: flex; \}/)
    expect(css).toMatch(/prefers-reduced-motion:[\s\S]*?\.message-thread/)
    expect(css).toMatch(/\.message-workspace,\s*\.inbox-workspace,\s*\.card-conversation\s*\{/)
    expect(css).toContain('.drawer .message-answers::before')
  })
})
