import picomatch from 'picomatch'

function base(p: string): string {
  const i = p.search(/[*?[{]/)
  return (i === -1 ? p : p.slice(0, i)).replace(/\/+$/, '')
}

function pairIntersects(a: string, b: string): boolean {
  if (picomatch.isMatch(b, a, { dot: true }) || picomatch.isMatch(a, b, { dot: true })) return true
  const ba = base(a), bb = base(b)
  if (ba === '' || bb === '') return true // catch-all like '**'
  return ba === bb || ba.startsWith(bb + '/') || bb.startsWith(ba + '/')
}

export function pathsIntersect(a: string[], b: string[]): boolean {
  return a.some((pa) => b.some((pb) => pairIntersects(pa, pb)))
}
