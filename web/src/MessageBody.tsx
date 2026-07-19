import React, { useMemo, useState } from 'react'
import type { BoardMessage, MessageKind } from './api'
import { presentMessage, type MessagePresentationToken } from './messagePresentation'

type Props = {
  message: Pick<BoardMessage, 'body' | 'kind'> | { body: string; kind?: MessageKind }
  boardId: number
  cardTitles?: ReadonlyMap<number, string>
}

function Token({ token, boardId }: { token: MessagePresentationToken; boardId: number }) {
  if (token.kind === 'text') return <>{token.text}</>
  if (token.kind === 'card') {
    const label = `Card #${token.cardId}`
    return (
      <a className="message-token message-token-card" href={`/?board=${boardId}&card=${token.cardId}`}
        title={token.cardTitle ? `Open ${label}: ${token.cardTitle}` : `Open ${label}`}>
        <span>{label}</span>{token.cardTitle && <small> · {token.cardTitle}</small>}
      </a>
    )
  }
  if (token.kind === 'commit') {
    return <span className="message-token message-token-technical" title={`Commit reference ${token.value}`}>
      <span>commit</span><code>{token.value}</code>
    </span>
  }
  if (token.kind === 'branch') {
    return <span className="message-token message-token-technical" title={`Branch ${token.value}`}>
      <span>branch</span><code>{token.value}</code>
    </span>
  }
  if (token.kind === 'path') {
    return <span className="message-token message-token-technical" title={`Path ${token.value}`}>
      <span>path</span><code>{token.value}</code>
    </span>
  }
  return (
    <span className={`message-token message-token-${token.kind} tone-${token.tone ?? 'neutral'}`}
      title={token.label !== token.text ? `Protocol text: ${token.text}` : undefined}>
      {token.label ?? token.text}
    </span>
  )
}

export function MessageBody({ message, boardId, cardTitles }: Props) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const presentation = useMemo(
    () => presentMessage(message, { cardTitles }),
    [message.body, message.kind, cardTitles],
  )

  const copyRaw = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(presentation.raw)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const renderedClauses = presentation.clauses.map((clause, clauseIndex) => (
    <React.Fragment key={clauseIndex}>
      {clause.map((token, tokenIndex) => <Token key={`${tokenIndex}-${token.text}`} token={token} boardId={boardId} />)}
    </React.Fragment>
  ))

  return (
    <div className={`message-readable tone-${presentation.tone} ${presentation.annotated ? 'annotated' : 'verbatim'}`}>
      <p className="message-readable-heading">{presentation.heading}</p>
      {renderedClauses.length > 1 ? (
        <ul className="message-readable-clauses">
          {renderedClauses.map((clause, index) => <li key={index}>{clause}</li>)}
        </ul>
      ) : (
        <p className="message-readable-clause">{renderedClauses[0]}</p>
      )}
      <details className="message-raw">
        <summary>Raw protocol</summary>
        <div className="message-raw-panel">
          <pre tabIndex={0} aria-label="Exact agent protocol message">{presentation.raw}</pre>
          <button type="button" onClick={copyRaw} aria-live="polite"
            aria-label={copyState === 'copied' ? 'Raw protocol copied' : copyState === 'failed' ? 'Raw protocol copy unavailable' : 'Copy raw protocol message'}
            title={copyState === 'failed' ? 'Select the raw protocol text manually' : undefined}>
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy unavailable' : 'Copy raw'}
          </button>
        </div>
      </details>
    </div>
  )
}
