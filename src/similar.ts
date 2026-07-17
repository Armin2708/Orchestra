// lightweight text similarity between cards — no models, no deps
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'with', 'from', 'into',
  'is', 'are', 'be', 'this', 'that', 'it', 'its', 'as', 'by', 'up', 'out', 'new', 'add',
  'fix', 'update', 'make', 'work', 'working', 'task', 'card', 'implement', 'create',
])

export function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((w) => (w.length > 5 ? w.slice(0, 5) : w)) // crude stemming: migrations ~ migrate
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  )
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return shared / Math.min(ta.size, tb.size)
}

export function isSimilar(a: string, b: string): boolean {
  const ta = tokens(a), tb = tokens(b)
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return shared >= 2 && shared / Math.min(ta.size || 1, tb.size || 1) >= 0.4
}
