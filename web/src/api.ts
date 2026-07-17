export const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`/api/v1${p}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export type Card = { id: number; title: string; description: string; column: string; owner: string | null; paths: string[]; updated_at: string }
export type Agent = { id: number; name: string; status: string; last_seen: string }
export type Snapshot = { board: { id: number; name: string }; agents: Agent[]; cards: Card[]; open_questions: any[] }
