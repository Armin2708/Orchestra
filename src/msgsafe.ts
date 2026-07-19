// Shell-quoting safety for board message bodies. Two real incidents in one day:
// a backticked field name vanished into command substitution, and a keychain dump
// leaked into every agent context — both from double-quoted bodies composed in bash.
// --stdin sidesteps the shell entirely; the warning catches leak/mangling patterns
// when a body still arrives via argv.

export async function readStdinBody(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  ;(stream as any).setEncoding?.('utf8')
  let data = ''
  for await (const chunk of stream) data += chunk
  // heredocs always end with one newline the author didn't mean to send; a bare
  // `printf '%s'` pipe has none, so stripping exactly one keeps both byte-faithful
  return data.replace(/\n$/, '')
}

// outputs that only ever appear in a message because a substitution ran inside it
const LEAK_SIGNATURES = [
  /find-generic-password|security\s+find-|keychain:\s*"/i, // macOS security(1) dumps
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // key material
  /claudeAiOauth|"accessToken"|"refreshToken"/, // credential JSON
  /\bpassword\s*[:=]\s*"/i,
]

export function substitutionWarning(body: string): string | undefined {
  if (LEAK_SIGNATURES.some((re) => re.test(body)))
    return 'body looks like it contains credential/command output — a shell substitution may have leaked into this message; verify what you just sent, and prefer --stdin'
  if (((body.match(/`/g) ?? []).length) % 2 === 1)
    return 'body has an unmatched backtick — the shell may have substituted or truncated part of it; prefer --stdin'
  if (/\$\((?![^()]*\))/.test(body))
    return 'body has an unclosed $( — the shell may have mangled it; prefer --stdin'
  return undefined
}

// resolve a message body from argv or --stdin; warn (never block) on leak smells
export async function messageBody(arg: string | undefined, useStdin: boolean): Promise<string> {
  if (useStdin && arg !== undefined) {
    console.error('⚠ --stdin set — ignoring the body argument and reading the pipe')
  }
  const body = useStdin ? await readStdinBody() : arg
  if (body === undefined || body === '') {
    console.error("missing message body — pass it single-quoted, or pipe it: printf '%s' <body> | orchestra ... --stdin")
    process.exit(1)
  }
  const warning = substitutionWarning(body)
  if (warning) console.error(`⚠ ${warning}`)
  return body
}
