import React, { useState } from 'react'
import { api, Idea, Snapshot, agentInk, agentWash, initials, timeAgo } from './api'
import { STATUS } from './Board'

const ORDER = ['backlog', 'in_progress', 'blocked', 'review', 'done']

function ProjectRoadmap({ snap, onChange }: { snap: Snapshot; onChange: () => void }) {
  const [text, setText] = useState('')
  const agents = snap.agents.filter((a) => a.status !== 'gone')

  const add = async () => {
    if (!text.trim()) return
    await api('POST', '/ideas', { board_id: snap.board.id, text: text.trim() })
    setText(''); onChange()
  }
  const promote = async (idea: Idea, agent: string) => {
    await api('POST', `/ideas/${idea.id}/promote`, agent ? { agent } : {})
    onChange()
  }
  const assign = async (cardId: number, agent: string) => {
    if (!agent) return
    await api('POST', `/cards/${cardId}/assign`, { agent })
    onChange()
  }

  const tickets = [...snap.cards].sort((a, b) => ORDER.indexOf(a.column) - ORDER.indexOf(b.column))

  return (
    <section className="rm-project">
      <h2>{snap.board.name}</h2>

      <div className="rm-composer">
        <textarea value={text} rows={2}
          placeholder={'Brainstorm here — first line becomes the ticket title, the rest its scope.\nEnter to save, Shift+Enter for a new line.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add() } }} />
      </div>

      <h3 className="rm-h">Ideas <span className="rm-count">{(snap.ideas ?? []).length}</span></h3>
      <div className="rm-ideas">
        {(snap.ideas ?? []).map((i) => (
          <div key={i.id} className="rm-idea">
            <p className="rm-idea-title">{i.text.split('\n')[0]}</p>
            {i.text.includes('\n') && <p className="rm-idea-desc">{i.text.split('\n').slice(1).join(' ')}</p>}
            <div className="rm-idea-actions">
              <select defaultValue="" onChange={(e) => { if (e.target.value !== '') promote(i, e.target.value === '·' ? '' : e.target.value) }}>
                <option value="" disabled>→ ticket</option>
                <option value="·">unassigned</option>
                {agents.map((a) => <option key={a.id} value={a.name}>assign {a.name}</option>)}
              </select>
              <button className="icon-x" title="Delete idea"
                onClick={async () => { await api('DELETE', `/ideas/${i.id}`); onChange() }}>×</button>
            </div>
          </div>
        ))}
        {(snap.ideas ?? []).length === 0 && <p className="col-empty">No ideas yet — brainstorm above.</p>}
      </div>

      <h3 className="rm-h">Tickets <span className="rm-count">{tickets.length}</span></h3>
      <div className="rm-tickets">
        {tickets.map((c) => {
          const st = STATUS[c.column] ?? STATUS.backlog
          return (
            <div key={c.id} className={`rm-ticket ${c.column === 'done' ? 'is-done' : ''}`}>
              <span className="status-chip" style={{ background: st.bg, color: st.ink }}>{st.label}</span>
              <span className="rm-ticket-title" title={c.description || c.title}>{c.title}</span>
              {c.owner
                ? <span className="owner"><i className="avatar mini" style={{ background: agentWash(c.owner), color: agentInk(c.owner) }}>{initials(c.owner)}</i>{c.owner}</span>
                : <span className="owner unowned">unassigned</span>}
              <time>{timeAgo(c.updated_at)}</time>
              {agents.length > 0 && (
                <select className="assign-select" defaultValue=""
                  onChange={(e) => { assign(c.id, e.target.value); e.target.value = '' }}>
                  <option value="" disabled>assign…</option>
                  {agents.filter((a) => a.name !== c.owner).map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
                </select>
              )}
            </div>
          )
        })}
        {tickets.length === 0 && <p className="col-empty">No tickets yet — promote an idea.</p>}
      </div>
    </section>
  )
}

export function RoadmapView({ snaps, focused = false, onChange }: { snaps: Snapshot[]; focused?: boolean; onChange: () => void }) {
  return (
    <main className={focused ? 'roadmap focused' : 'roadmap'}>
      {snaps.map((s) => <ProjectRoadmap key={s.board.id} snap={s} onChange={onChange} />)}
    </main>
  )
}
