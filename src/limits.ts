// usage-limit deaths are resumable: the conversation is intact on disk, only the rate
// window is spent — so they must classify differently from real failures (paused_limit,
// not gone). Signals cover the SDK's error/result text for spent windows and transient
// API saturation: "Claude usage limit reached", 429s, overloaded_error.
const LIMIT_PATTERNS = [
  /usage limit/i,
  /rate[ _-]?limit/i,
  /limit (reached|exceeded)/i,
  /\b(5|five)[ -]?hour limit\b/i,
  /\bweekly limit\b/i,
  /out of (usage|quota|credits)/i,
  /\b429\b/,
  /overloaded/i,
]

export function isUsageLimitError(text: string | null | undefined): boolean {
  return !!text && LIMIT_PATTERNS.some((p) => p.test(text))
}
