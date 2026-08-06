// Release gate: a build whose bundled provider CLI cannot enumerate models ships a
// dead model picker. That is exactly how a released model (Opus 5) stayed invisible
// while every test still passed — nothing asserted the catalog was reachable.
//
// The check is deliberately credential-free: `--version` and the model catalog are
// both readable without logging in, so this runs in CI with no secrets.

import { execFileSync } from 'node:child_process'
import { parseExecutableSemver } from './provider-executable-version.js'

export type CatalogSmokeResult = {
  ok: boolean
  executable: string | null
  version: string | null
  modelCount: number
  failures: string[]
}

export type CatalogSmokeDeps = {
  resolveExecutable: () => string | null
  readVersion: (executable: string) => string | null
  readModels: (executable: string) => unknown
}

const defaultReadVersion = (executable: string): string | null => {
  try {
    return execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1 << 16,
    }).trim() || null
  } catch {
    return null
  }
}

/**
 * Assert the bundled provider CLI is present, reports a parseable version, and
 * enumerates at least one model. Pure over its dependencies so the failure paths
 * are testable without a broken CLI on disk.
 */
export function evaluateCatalogSmoke(
  deps: CatalogSmokeDeps,
  normalizeModels: (raw: unknown) => readonly unknown[],
): CatalogSmokeResult {
  const failures: string[] = []
  const executable = deps.resolveExecutable()
  if (!executable) {
    return {
      ok: false,
      executable: null,
      version: null,
      modelCount: 0,
      failures: ['no provider CLI resolved — the bundled executable is missing from this build'],
    }
  }

  const rawVersion = deps.readVersion(executable)
  const version = parseExecutableSemver(rawVersion)?.value ?? null
  if (!version) {
    failures.push(`provider CLI at ${executable} did not report a parseable --version`)
  }

  let modelCount = 0
  try {
    modelCount = normalizeModels(deps.readModels(executable)).length
  } catch (error) {
    failures.push(`model catalog probe threw: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  if (modelCount === 0) {
    failures.push('provider CLI returned an EMPTY model catalog — the hire picker would list no models')
  }

  return { ok: failures.length === 0, executable, version, modelCount, failures }
}

export const catalogSmokeVersionReader = defaultReadVersion
