import { readFileSync } from 'node:fs'
import path from 'node:path'

const markdownLink = /!?(?:\[[^\]]*\])\(([^)]+)\)/g

const localTarget = (rawTarget) => {
  const withoutTitle = rawTarget.trim().replace(/^<|>$/g, '').split(/\s+["']/)[0]
  if (
    withoutTitle === '' || withoutTitle.startsWith('#') || withoutTitle.startsWith('/') ||
    /^[a-z][a-z0-9+.-]*:/i.test(withoutTitle)
  ) return undefined
  const withoutQuery = withoutTitle.split('#')[0].split('?')[0]
  if (withoutQuery === '') return undefined
  try {
    return decodeURIComponent(withoutQuery.replaceAll('\\', '/'))
  } catch {
    throw new Error(`packaged Markdown contains an invalid encoded link: ${rawTarget}`)
  }
}

export function verifyPackagedMarkdownLinks({ root, files }) {
  const packed = new Set(files)
  const markdownFiles = [...packed].filter((file) => file.toLowerCase().endsWith('.md')).sort()
  const broken = []
  let checked = 0

  for (const source of markdownFiles) {
    const contents = readFileSync(path.join(root, source), 'utf8')
    for (const match of contents.matchAll(markdownLink)) {
      const target = localTarget(match[1])
      if (!target) continue
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), target))
      const included = packed.has(resolved) || [...packed].some((file) => file.startsWith(`${resolved}/`))
      checked += 1
      if (!included) broken.push(`${source} -> ${resolved}`)
    }
  }

  if (broken.length > 0) {
    throw new Error(`packaged Markdown has missing local targets:\n${broken.join('\n')}`)
  }
  return { markdown_files: markdownFiles.length, local_links_checked: checked, passed: true }
}
