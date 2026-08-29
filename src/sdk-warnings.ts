// The SDK warns that `canUseTool` is shadowed whenever a query runs in
// `bypassPermissions` — the default mode for a hired agent. We wire the callback
// unconditionally on purpose (#45): the operator can switch an agent's mode live,
// and setPermissionMode mutates the existing query rather than rebuilding it, so a
// callback omitted at construction would leave a switched-to-asking agent denying
// every tool. The warning is therefore expected rather than a misconfiguration, and
// one line per hired agent buries real warnings in the daemon's startup output.

const SHADOWED = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'

let installed = false

/** Drop the SDK's canUseTool-shadowed warning. Idempotent; every other warning still prints. */
export function silenceCanUseToolShadowWarning(): void {
  if (installed) return
  installed = true
  const emit = process.emitWarning.bind(process)
  // emitWarning(warning, options) and emitWarning(warning, type, code, ctor) both carry the code
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const opts = rest[0]
    const code = opts && typeof opts === 'object' ? (opts as { code?: unknown }).code : rest[1]
    if (code === SHADOWED) return
    return (emit as (...args: unknown[]) => void)(warning, ...rest)
  }) as typeof process.emitWarning
}
