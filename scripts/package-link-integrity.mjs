import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

const stripNonLinks = (contents) => contents
  .replace(/<!--[^]*?-->/g, '')
  .replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[^]*?\n[ \t]*\2(?=\n|$)/g, '$1')
  .replace(/`[^`\n]*`/g, '')

const normalizeReference = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase()

const targetToken = (rawTarget) => {
  const trimmed = rawTarget.trim()
  if (trimmed.startsWith('<')) {
    const closing = trimmed.indexOf('>')
    if (closing < 0) throw new Error(`packaged Markdown contains an unterminated link: ${rawTarget}`)
    return trimmed.slice(1, closing)
  }
  return trimmed.match(/^\S+/)?.[0] ?? ''
}

const localTarget = (rawTarget) => {
  const target = targetToken(rawTarget)
  if (
    target === '' || target.startsWith('#') || target.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  ) return undefined
  const withoutQuery = target.split('#')[0].split('?')[0]
  if (withoutQuery === '') return undefined
  try {
    return decodeURIComponent(withoutQuery.replaceAll('\\', '/'))
  } catch {
    throw new Error(`packaged Markdown contains an invalid encoded link: ${rawTarget}`)
  }
}

const resolveTarget = (source, target) => {
  const relative = target.startsWith('/')
    ? target.slice(1)
    : path.posix.join(path.posix.dirname(source), target)
  const resolved = path.posix.normalize(relative)
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    throw new Error(`packaged Markdown link escapes the retained artifact: ${source} -> ${target}`)
  }
  return resolved.replace(/^\.\//, '')
}

const assertRegularPackedFile = (root, file, label) => {
  const stat = lstatSync(path.join(root, file))
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not one retained regular file: ${file}`)
  }
}

export function verifyPackagedMarkdownLinks({ root, files }) {
  const packed = new Set([...files].map((file) => file.replaceAll('\\', '/')))
  const markdownFiles = [...packed].filter((file) => file.toLowerCase().endsWith('.md')).sort()
  const broken = []
  const undefinedReferences = []
  let checked = 0

  for (const source of markdownFiles) {
    assertRegularPackedFile(root, source, 'packaged Markdown source')
    const contents = stripNonLinks(readFileSync(path.join(root, source), 'utf8'))
    const definitions = new Map()
    for (const match of contents.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)(?:\s+.*)?$/gm)) {
      definitions.set(normalizeReference(match[1]), match[2])
    }

    const targets = []
    for (const match of contents.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) targets.push(match[1])
    for (const match of contents.matchAll(/<(?:a|img)\b[^>]*?\b(?:href|src)\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
      targets.push(match[2])
    }
    for (const match of contents.matchAll(/!?\[([^\]]+)\]\[([^\]]*)\]/g)) {
      const reference = normalizeReference(match[2] || match[1])
      if (!definitions.has(reference)) undefinedReferences.push(`${source} -> [${reference}]`)
      else targets.push(definitions.get(reference))
    }

    for (const rawTarget of targets) {
      const target = localTarget(rawTarget)
      if (!target) continue
      const resolved = resolveTarget(source, target)
      const included = packed.has(resolved) || [...packed].some((file) => file.startsWith(`${resolved}/`))
      checked += 1
      if (!included) {
        broken.push(`${source} -> ${resolved}`)
      } else if (packed.has(resolved)) {
        assertRegularPackedFile(root, resolved, 'packaged Markdown target')
      }
    }
  }

  if (undefinedReferences.length > 0) {
    throw new Error(`packaged Markdown has undefined references:\n${undefinedReferences.join('\n')}`)
  }
  if (broken.length > 0) {
    throw new Error(`packaged Markdown has missing local targets:\n${broken.join('\n')}`)
  }
  return { markdown_files: markdownFiles.length, local_links_checked: checked, passed: true }
}
