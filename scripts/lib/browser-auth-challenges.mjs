import { createHash } from 'node:crypto'

export const LOCAL_OWNER_CHALLENGE_PATHS = Object.freeze([
  '/api/v1/boards',
  '/api/v1/events',
  '/api/v1/system',
  '/api/v1/os/open-work',
  '/api/v1/os/devices/self',
])

export const REQUIRED_LOCAL_OWNER_CHALLENGE_PATHS = Object.freeze([
  '/api/v1/boards',
  '/api/v1/events',
  '/api/v1/system',
  '/api/v1/os/devices/self',
])

export const REPEATED_LOCAL_OWNER_CHALLENGE_PATHS = Object.freeze([
  '/api/v1/os/open-work',
])

export const localOwnerChallengeEndpointDigest = (path) => createHash('sha256').update(path).digest('hex')

export const LOCAL_OWNER_CHALLENGE_DIGESTS = Object.freeze(Object.fromEntries(
  LOCAL_OWNER_CHALLENGE_PATHS.map((path) => [path, localOwnerChallengeEndpointDigest(path)]),
))

export const createLocalOwnerChallengeTracker = (baseUrl) => {
  const origin = new URL(baseUrl).origin
  const admittedRequests = new Map()
  const counts = new Map(LOCAL_OWNER_CHALLENGE_PATHS.map((path) => [path, 0]))
  let acceptingRequestStarts = false
  let loginCycles = 0

  return {
    beginLoginCycle() {
      acceptingRequestStarts = true
      loginCycles += 1
    },
    closePreSubmitPhase() {
      acceptingRequestStarts = false
    },
    observeRequest(requestId, rawUrl) {
      if (!acceptingRequestStarts || !requestId) return false
      let url
      try { url = new URL(rawUrl) } catch { return false }
      if (url.origin !== origin || !LOCAL_OWNER_CHALLENGE_PATHS.includes(url.pathname)) return false
      admittedRequests.set(requestId, url.pathname)
      return true
    },
    observeResponse(requestId, status) {
      const path = admittedRequests.get(requestId)
      admittedRequests.delete(requestId)
      if (!path || status !== 401) return { expected: false, path: null }
      counts.set(path, (counts.get(path) ?? 0) + 1)
      return { expected: true, path }
    },
    observeFailure(requestId) {
      admittedRequests.delete(requestId)
    },
    inventory() {
      const endpoints = LOCAL_OWNER_CHALLENGE_PATHS.map((path) => ({
        endpoint_sha256: LOCAL_OWNER_CHALLENGE_DIGESTS[path],
        count: counts.get(path) ?? 0,
      }))
      const totalCount = endpoints.reduce((sum, entry) => sum + entry.count, 0)
      const requiredDigests = new Set(REQUIRED_LOCAL_OWNER_CHALLENGE_PATHS
        .map((path) => LOCAL_OWNER_CHALLENGE_DIGESTS[path]))
      const repeatedDigests = new Set(REPEATED_LOCAL_OWNER_CHALLENGE_PATHS
        .map((path) => LOCAL_OWNER_CHALLENGE_DIGESTS[path]))
      return {
        passed: loginCycles > 0
          && endpoints.every((entry) => Number.isInteger(entry.count)
            && ((requiredDigests.has(entry.endpoint_sha256) && entry.count === loginCycles)
              || (repeatedDigests.has(entry.endpoint_sha256)
                && entry.count >= loginCycles && entry.count <= 2 * loginCycles)))
          && admittedRequests.size === 0,
        login_cycles: loginCycles,
        total_count: totalCount,
        endpoints,
        pending_request_count: admittedRequests.size,
      }
    },
  }
}

export const recordLocalOwnerHttpFailure = ({
  tracker,
  requestId,
  status,
  entry,
  authenticationChallenges,
  failedRequests,
  retain,
}) => {
  const classification = tracker.observeResponse(requestId, status)
  if (classification.expected) {
    retain(authenticationChallenges, { ...entry, label: 'expected_local_owner_challenge' })
  } else {
    retain(failedRequests, entry)
  }
  return classification
}
