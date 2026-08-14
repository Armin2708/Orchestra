import React from 'react'

// Agents write mail bodies in plain text but with real email conventions:
// blank-line paragraphs, "1)" / "- " lists, `inline code`, **bold**, and URLs.
// This renders that into clean, readable letter markup — no raw HTML, nodes only.

const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/
const UNORDERED = /^\s*[-*•]\s+(.*)$/
const HEADING = /^\s{0,3}(#{1,4})\s+(.*)$/
const FENCE = /^\s*```/
const INLINE = /(`[^`]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s)]+)/g

type Block =
  | { type: 'p'; lines: string[] }
  | { type: 'ol' | 'ul'; items: string[][] }
  | { type: 'pre'; lines: string[] }
  | { type: 'h'; level: number; text: string }

// bold, inline code, and links — split by position so order is preserved and
// code fences win over ** so `**x**` inside backticks stays literal.
function renderInline(text: string, key: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  let last = 0
  let idx = 0
  let match: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[1]) {
      parts.push(<code key={`${key}-${idx}`} className="mail-code">{match[1].slice(1, -1)}</code>)
    } else if (match[2]) {
      parts.push(<strong key={`${key}-${idx}`}>{match[2].slice(2, -2)}</strong>)
    } else if (match[3]) {
      parts.push(
        <a key={`${key}-${idx}`} className="mail-link" href={match[3]} target="_blank" rel="noreferrer">
          {match[3].replace(/^https?:\/\//, '')}
        </a>,
      )
    }
    last = INLINE.lastIndex
    idx++
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length === 1 ? parts[0] : parts
}

function parseBlocks(body: string): Block[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].trim() === '') { i++; continue }

    // fenced code: everything until the closing fence, verbatim
    if (FENCE.test(lines[i])) {
      const code: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) { code.push(lines[i]); i++ }
      if (i < lines.length) i++ // closing fence
      blocks.push({ type: 'pre', lines: code })
      continue
    }

    const heading = HEADING.exec(lines[i])
    if (heading) {
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2] })
      i++
      continue
    }

    const isOrdered = ORDERED.test(lines[i])
    const isUnordered = !isOrdered && UNORDERED.test(lines[i])
    if (isOrdered || isUnordered) {
      const type: 'ol' | 'ul' = isOrdered ? 'ol' : 'ul'
      const itemRe = isOrdered ? ORDERED : UNORDERED
      const items: string[][] = []
      while (i < lines.length) {
        const line = lines[i]
        if (line.trim() === '') {
          // a blank line only ends the list if the next content isn't another item
          let j = i + 1
          while (j < lines.length && lines[j].trim() === '') j++
          if (j < lines.length && itemRe.test(lines[j])) { i = j; continue }
          i++
          break
        }
        // a different list marker starts a fresh block
        const switched = isOrdered ? (UNORDERED.test(line) && !ORDERED.test(line)) : ORDERED.test(line)
        if (switched) break
        const m = itemRe.exec(line)
        if (m) {
          items.push([isOrdered ? m[2] : m[1]])
          i++
        } else if (items.length) {
          // wrapped continuation line belongs to the current item
          items[items.length - 1].push(line.trim())
          i++
        } else break
      }
      blocks.push({ type, items })
      continue
    }

    // paragraph: runs until a blank line or the start of a list/fence/heading
    const para: string[] = []
    while (i < lines.length) {
      const line = lines[i]
      if (line.trim() === '') { i++; break }
      if (ORDERED.test(line) || UNORDERED.test(line) || FENCE.test(line) || HEADING.test(line)) break
      para.push(line)
      i++
    }
    blocks.push({ type: 'p', lines: para })
  }
  return blocks
}

// Memoized: the agent drawer renders one of these per rich line over a 500-line
// transcript, and its parent re-renders on every keystroke in the composer. Props are
// two primitives, so the comparison is free next to re-parsing the block structure.
export const MailLetter = React.memo(function MailLetter(
  { text, className = 'mail-letter' }: { text: string; className?: string },
) {
  const blocks = React.useMemo(() => parseBlocks(text), [text])
  return (
    <div className={className}>
      {blocks.map((block, bi) => {
        if (block.type === 'pre') {
          return <pre key={bi} className="mail-pre"><code>{block.lines.join('\n')}</code></pre>
        }
        if (block.type === 'h') {
          return <p key={bi} className={`mail-h mail-h${block.level}`}>{renderInline(block.text, `${bi}`)}</p>
        }
        if (block.type === 'p') {
          return (
            <p key={bi}>
              {block.lines.map((line, li) => (
                <React.Fragment key={li}>
                  {li > 0 && <br />}
                  {renderInline(line, `${bi}-${li}`)}
                </React.Fragment>
              ))}
            </p>
          )
        }
        const List = block.type === 'ol' ? 'ol' : 'ul'
        return (
          <List key={bi} className={`mail-${block.type}`}>
            {block.items.map((item, ii) => (
              <li key={ii}>
                {item.map((line, li) => (
                  <React.Fragment key={li}>
                    {li > 0 && ' '}
                    {renderInline(line, `${bi}-${ii}-${li}`)}
                  </React.Fragment>
                ))}
              </li>
            ))}
          </List>
        )
      })}
    </div>
  )
})
