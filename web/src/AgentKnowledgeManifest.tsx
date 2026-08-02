import { useEffect, useState } from 'react'
import { KnowledgeContextManifest } from './KnowledgeView'
import { knowledgeApi, type KnowledgeManifestEntry } from './knowledgeApi'

export function AgentKnowledgeManifest({ boardId, buildId }: { boardId: number; buildId: string }) {
  const [entries, setEntries] = useState<KnowledgeManifestEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setError(null)
    knowledgeApi.manifest(boardId, buildId).then((value) => {
      if (active) setEntries(value)
    }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Knowledge manifest could not load.')
    })
    return () => { active = false }
  }, [boardId, buildId])
  if (error) return <p className="dc-error" role="alert">{error}</p>
  return entries.length ? <KnowledgeContextManifest entries={entries} /> : null
}
