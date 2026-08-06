// Shared "newest executable wins" selection for provider CLI discovery.
//
// Provider CLIs ship new model catalogs; an operator who keeps their own CLI
// current should get those models without waiting for an orchestra release.
// PATH order is arbitrary (nvm shims, homebrew, ~/.local/bin), so first-match
// discovery can pin a stale binary while a newer one sits later on PATH.

export type ExecutableSemver = readonly [major: number, minor: number, patch: number]

const SEMVER_PATTERN = /(?:^|[^0-9])v?(\d+)\.(\d+)(?:\.(\d+))?(?=$|\s|\)|$)/

export const parseExecutableSemver = (
  value: string | null | undefined,
): { value: string; tuple: ExecutableSemver } | null => {
  const match = value?.match(SEMVER_PATTERN)
  if (!match) return null
  const tuple = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] as const
  if (tuple.some((part) => !Number.isSafeInteger(part))) return null
  return { value: tuple.join('.'), tuple }
}

export const compareExecutableSemver = (
  left: ExecutableSemver,
  right: ExecutableSemver,
): number => {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/**
 * Pick the newest of several already-resolved executable paths.
 *
 * `readVersion` is only invoked when there is a real choice to make — a single
 * candidate is returned untouched so the common case costs no extra subprocess.
 * Candidates whose version cannot be parsed never win; if none parse, the first
 * candidate is returned so discovery degrades to today's PATH-order behavior.
 */
export const pickNewestExecutable = (
  candidates: readonly string[],
  readVersion: (resolvedPath: string) => string | null,
): string | null => {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0] ?? null
  let best: { path: string; tuple: ExecutableSemver } | null = null
  for (const candidate of candidates) {
    const parsed = parseExecutableSemver(readVersion(candidate))
    if (!parsed) continue
    if (!best || compareExecutableSemver(parsed.tuple, best.tuple) > 0) {
      best = { path: candidate, tuple: parsed.tuple }
    }
  }
  return best?.path ?? candidates[0] ?? null
}
