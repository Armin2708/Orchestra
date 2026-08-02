import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Command } from 'commander'
import {
  SUPPORT_CASE_EXPORT_CONSENT,
  writeSupportCaseExport,
} from './support-case-export.js'

const SHA256 = /^[a-f0-9]{64}$/
const CONTENT_DISPOSITION = /^attachment; filename="(orchestra-support-case-[A-Za-z0-9-]+-[a-f0-9]{12}\.json)"$/

export type SupportCaseCliDeps = {
  ensureReady: () => Promise<void>
  baseUrl: () => string
  ownerToken: () => string
  fetchImpl?: typeof fetch
  log?: (value: string) => void
}

const readRequest = (requestFile: string): Record<string, unknown> => {
  const resolved = path.resolve(requestFile)
  const info = fs.lstatSync(resolved)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 64 * 1024) {
    throw new Error('support-case request must be a regular JSON file no larger than 64 KiB')
  }
  const parsed = JSON.parse(fs.readFileSync(fs.realpathSync(resolved), 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Error('support-case request must be one plain JSON object')
  }
  return parsed as Record<string, unknown>
}

export const registerSupportCaseCommand = (
  operations: Command,
  deps: SupportCaseCliDeps,
): void => {
  operations.command('support-case <request-file> <output-directory>')
    .description('create one verified local support-case export for manual review')
    .requiredOption(
      '--consent-review-before-sharing',
      'consent to a local export and confirm it will be reviewed before sharing',
    )
    .action(async (requestFile: string, outputDirectory: string) => {
      const request = {
        ...readRequest(requestFile),
        consent: SUPPORT_CASE_EXPORT_CONSENT,
      }
      await deps.ensureReady()
      const response = await (deps.fetchImpl ?? fetch)(`${deps.baseUrl()}/api/v1/ops/support-case`, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${deps.ownerToken()}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
      })
      if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
        throw new Error('the daemon rejected the support-case export')
      }
      const disposition = response.headers.get('content-disposition') ?? ''
      const filename = CONTENT_DISPOSITION.exec(disposition)?.[1]
      const sha256 = response.headers.get('x-content-sha256') ?? ''
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!filename || !SHA256.test(sha256)
        || bytes.byteLength <= 0
        || bytes.byteLength > 16 * 1024 * 1024
        || createHash('sha256').update(bytes).digest('hex') !== sha256) {
        throw new Error('the daemon returned an invalid support-case export')
      }
      const destination = writeSupportCaseExport(outputDirectory, { filename, bytes, sha256 })
      ;(deps.log ?? console.log)(JSON.stringify({
        path: destination,
        bytes: bytes.byteLength,
        sha256,
        review_before_sharing: true,
        published: false,
      }, null, 2))
    })
}
