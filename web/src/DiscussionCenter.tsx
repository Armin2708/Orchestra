import React, { type FormEvent, useCallback, useEffect, useState } from 'react'
import {
  discussionApi,
  type DiscussionClient,
  type DiscussionListQuery,
  type DiscussionPostNode,
  type DiscussionSnapshot,
  type DiscussionSummary,
  type DiscussionType,
} from './discussionApi'
import './discussions.css'

type DiscussionSurface = 'agent-home' | 'job-detail' | 'project-command-center'

export function DiscussionCenter({
  boardId,
  surface = 'project-command-center',
  linkType,
  linkTarget,
  profileId,
  client = discussionApi,
}: {
  boardId: number
  surface?: DiscussionSurface
  linkType?: string
  linkTarget?: string
  profileId?: string
  client?: DiscussionClient
}) {
  const [items, setItems] = useState<DiscussionSummary[]>([])
  const [selected, setSelected] = useState<DiscussionSnapshot | null>(null)
  const [query, setQuery] = useState('')
  const [queue, setQueue] = useState<DiscussionListQuery['queue']>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const listed = await client.list(boardId, {
        q: query || undefined,
        queue,
        linkType,
        linkTarget,
      })
      setItems(listed)
      if (selected && !listed.some((item) => item.id === selected.discussion.id)) {
        setSelected(null)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [boardId, client, linkTarget, linkType, query, queue, selected?.discussion.id])

  useEffect(() => { void load() }, [load])

  const open = async (id: string) => {
    setError(null)
    try { setSelected(await client.get(id)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  return <section className={`discussion-center dc-${surface}`} aria-label="Discussions">
    <header className="dc-header">
      <div><p>Collaborative intelligence</p><h2>Discussions</h2></div>
      <button type="button" onClick={() => setCreateOpen((value) => !value)}>New discussion</button>
    </header>
    <form className="dc-search" aria-label="Search discussions"
      onSubmit={(event) => { event.preventDefault(); void load() }}>
      <input aria-label="Search discussions" value={query}
        onChange={(event) => setQuery(event.target.value)} placeholder="Search questions, answers, plans…" />
      <button type="submit">Search</button>
    </form>
    <div className="dc-queues" role="group" aria-label="Discussion queues">
      <button className={!queue ? 'active' : ''} onClick={() => setQueue(undefined)}>All</button>
      <button className={queue === 'unanswered' ? 'active' : ''}
        onClick={() => setQueue('unanswered')}>Unanswered</button>
      <button className={queue === 'needs_human' ? 'active' : ''}
        onClick={() => setQueue('needs_human')}>Needs human</button>
    </div>
    {error && <p className="dc-error" role="alert">{error}</p>}
    {createOpen && <CreateDiscussion boardId={boardId} linkType={linkType}
      linkTarget={linkTarget} client={client} onCreated={async (value) => {
        setCreateOpen(false); setSelected(value); await load()
      }} />}
    <div className="dc-layout">
      <nav className="dc-list" aria-label="Discussion results">
        {loading && <p>Loading discussions…</p>}
        {!loading && !items.length && <p>No discussions match this view.</p>}
        {items.map((item) => <button type="button" key={item.id}
          className={selected?.discussion.id === item.id ? 'active' : ''}
          onClick={() => void open(item.id)}>
          <span>{item.discussion_type.replace('_', ' ')}</span><strong>{item.title}</strong>
          <small>{item.state.replace('_', ' ')}</small>
        </button>)}
      </nav>
      <div className="dc-detail">
        {selected
          ? <DiscussionDetail value={selected} profileId={profileId} client={client}
              onChange={async () => { setSelected(await client.get(selected.discussion.id)); await load() }} />
          : <p className="dc-empty">Select a discussion to inspect its exact thread and provenance.</p>}
      </div>
    </div>
  </section>
}

export const AgentHomeDiscussions = (props: Omit<React.ComponentProps<typeof DiscussionCenter>, 'surface'>) =>
  <DiscussionCenter {...props} surface="agent-home" />
export const JobDetailDiscussions = (props: Omit<React.ComponentProps<typeof DiscussionCenter>, 'surface'>) =>
  <DiscussionCenter {...props} surface="job-detail" />
export const ProjectDiscussionCenter = (props: Omit<React.ComponentProps<typeof DiscussionCenter>, 'surface'>) =>
  <DiscussionCenter {...props} surface="project-command-center" />

function DiscussionDetail({ value, profileId, client, onChange }: {
  value: DiscussionSnapshot
  profileId?: string
  client: DiscussionClient
  onChange: () => Promise<void>
}) {
  const [reply, setReply] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const subscribed = profileId ? value.subscriptions.includes(profileId) : false
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!reply.trim()) return
    setBusy(true)
    try {
      await client.reply(value.discussion.id, {
        parent_post_id: replyTo,
        kind: 'answer',
        body: reply.trim(),
      })
      setReply(''); setReplyTo(null); await onChange()
    } finally { setBusy(false) }
  }
  return <article className="dc-thread">
    <header><span>{value.discussion.discussion_type}</span><h3>{value.discussion.title}</h3>
      <b>{value.discussion.state.replace('_', ' ')}</b></header>
    <div className="dc-tags">{value.tags.map((tag) => <code key={tag}>{tag}</code>)}</div>
    {profileId && <button type="button" className="dc-subscribe" onClick={async () => {
      await client.subscribe(value.discussion.id, profileId, !subscribed); await onChange()
    }}>{subscribed ? 'Unsubscribe' : 'Subscribe'}</button>}
    <div className="dc-tree">{value.tree.map((post) => <Post key={post.id} post={post}
      acceptedId={value.discussion.accepted_post_id} onReply={setReplyTo}
      onAccept={async (id) => { await client.accept(value.discussion.id, id); await onChange() }}
      onPromote={async (id) => { await client.requestPromotion(value.discussion.id, id); await onChange() }} />)}</div>
    <form className="dc-reply" aria-label="Post discussion reply" onSubmit={submit}>
      {replyTo && <p>Replying to <code>{replyTo.slice(0, 10)}</code>
        <button type="button" onClick={() => setReplyTo(null)}>Cancel</button></p>}
      <textarea aria-label="Discussion reply" value={reply}
        onChange={(event) => setReply(event.target.value)}
        placeholder="Write an answer or nested reply" rows={4} maxLength={200000} />
      <button type="submit" disabled={busy || !reply.trim()}>{busy ? 'Posting…' : 'Post answer'}</button>
    </form>
  </article>
}

function Post({ post, acceptedId, onReply, onAccept, onPromote }: {
  post: DiscussionPostNode
  acceptedId: string | null
  onReply: (id: string) => void
  onAccept: (id: string) => Promise<void>
  onPromote: (id: string) => Promise<void>
}) {
  const accepted = acceptedId === post.id
  return <article className={`dc-post${accepted ? ' accepted' : ''}`}>
    <header><span>{post.post_kind}</span><b>{post.author_id}</b>
      {post.provider && <small>{post.provider}</small>}{accepted && <strong>Accepted answer</strong>}</header>
    <p>{post.body}</p>
    <footer><code>{post.content_sha256.slice(0, 12)}</code>
      <button type="button" onClick={() => onReply(post.id)}>Reply</button>
      {post.post_kind === 'answer' && !accepted
        && <button type="button" onClick={() => void onAccept(post.id)}>Accept</button>}
      {accepted && <button type="button" onClick={() => void onPromote(post.id)}>Request knowledge review</button>}
    </footer>
    {post.children.length > 0 && <div className="dc-children">{post.children.map((child) =>
      <Post key={child.id} post={child} acceptedId={acceptedId} onReply={onReply}
        onAccept={onAccept} onPromote={onPromote} />)}</div>}
  </article>
}

function CreateDiscussion({ boardId, linkType, linkTarget, client, onCreated }: {
  boardId: number
  linkType?: string
  linkTarget?: string
  client: DiscussionClient
  onCreated: (value: DiscussionSnapshot) => Promise<void>
}) {
  const [type, setType] = useState<DiscussionType>('question')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  return <form className="dc-create" aria-label="Create discussion" onSubmit={async (event) => {
    event.preventDefault()
    const links = linkType && linkTarget ? [{ type: linkType, target_id: linkTarget }] : []
    await onCreated(await client.create(boardId, {
      type, title: title.trim(), body: body.trim(),
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), links,
    }))
  }}>
    <select aria-label="Discussion type" value={type}
      onChange={(event) => setType(event.target.value as DiscussionType)}>
      {(['question', 'answer', 'plan', 'decision', 'announcement', 'conflict'] as const)
        .map((value) => <option key={value}>{value}</option>)}
    </select>
    <input aria-label="Discussion title" value={title}
      onChange={(event) => setTitle(event.target.value)} placeholder="Discussion title" maxLength={500} />
    <textarea aria-label="Discussion body" value={body}
      onChange={(event) => setBody(event.target.value)} placeholder="Exact question or context"
      rows={4} maxLength={200000} />
    <input aria-label="Discussion tags" value={tags}
      onChange={(event) => setTags(event.target.value)} placeholder="tags, comma-separated" />
    <button disabled={!title.trim() || !body.trim()} type="submit">Create</button>
  </form>
}
