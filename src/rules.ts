// Rule texts injected at session start. Compact by default; ORCHESTRA_VERBOSE_RULES=1
// restores the pre-diet wording. The env var is read on every call so the daemon and
// hooks can flip modes without a restart.
// Message bodies in every example are single-quoted on purpose: double-quoted bodies
// taught agents a pattern where backticks/$() run as shell substitutions (two real
// leak incidents). Anything risky goes through --stdin instead.
export const verbose = () => process.env.ORCHESTRA_VERBOSE_RULES === '1'

export const compactRules = (me: string) => `orchestra rules:
- ${me}; --agent/--from.
- Board first; overlap/claimed path → orchestra ask owner; wait.
- Before edit: orchestra card create '<title>' --desc '<goal/deliverables/done>' --paths <p> --column in_progress --agent ${me}; ⚠/≈ ask.
- Card current; done when finished = human-accepted only. Delivered/Evidence/Remaining; move review, never done.
- Subagents: no orchestra commands.
- Full: orchestra snapshot --full`

export const verboseRules = (me: string) => `orchestra rules (coordination board for this project — these are standing instructions):
- You are agent "${me}". ALWAYS pass --agent ${me} on card commands and --from ${me} when asking/replying.
- REQUIRED before starting any task: read the board below and evaluate every active card's title and description against your task. If another agent's card looks similar, related, or could conflict with what you're about to do, you MUST ask its owner what they're covering BEFORE you start: orchestra ask <agent-name> '<question>' --from ${me}. Wait for the answer, then scope your work to not duplicate theirs.
- REQUIRED: as soon as you receive a task, and BEFORE your first file edit, register it:
  orchestra card create '<short title>' --desc '<OBJECTIVE; DELIVERABLES; DONE WHEN>' --paths <comma,separated,paths> --column in_progress --agent ${me}
  If the response shows "⚠ overlap" or "≈ similar work", ask that agent before proceeding.
- Keep your card updated as work progresses: orchestra card update <id> --desc '<current delta>' --agent ${me}; move it to blocked when blocked. When implementation finishes, report Delivered / Evidence / Remaining and move to review. Never self-move to done; done means human-accepted delivery.
- Do NOT touch paths claimed by another active card without asking first. Replies arrive automatically.
- Always single-quote message bodies. If a body contains backticks, $ or quotes, do not put it on the command line at all — pipe it: printf '%s' <body> | orchestra ask <agent> --stdin (also on reply and note). Double quotes let the shell run substitutions inside your message.
- SUBAGENTS: spawn them freely — they work under YOUR identity and card. Instruct each one: do NOT run orchestra commands; board coordination belongs to you, the parent.`

// Output discipline (#57): appended to every role prompt via the composition wrappers
// below (single application — conductorCompactRules embeds compactRules, so appending
// inside the variants would double it). Output tokens are ~5x input price and never
// cached; ORCHESTRA_VERBOSE_OUTPUT=1 removes the block, read per call like verbose().
export const verboseOutput = () => process.env.ORCHESTRA_VERBOSE_OUTPUT === '1'

export const OUTPUT_DISCIPLINE = `- OUTPUT: outcome first; no preamble/recap. Board deltas. Final ≤3 bullets: Delivered/Evidence/Remaining. Essential comments only.`

export const outputDiscipline = () => (verboseOutput() ? '' : `\n${OUTPUT_DISCIPLINE}`)

export const hookRules = (me: string) => (verbose() ? verboseRules(me) : compactRules(me)) + outputDiscipline()

export const conductorCompactRules = (me: string) => `You are agent "${me}", a hired Orchestra agent working autonomously in this project.
${compactRules(me)}
- Open prerequisite steps? orchestra ask their owners first to agree interfaces, then build in parallel.
- Operator inbox: orchestra ask human '<first line = subject>' --from ${me}; the answer returns as a reply.
- Direct asks and explicit swarms need a substantive orchestra reply <msg-id> '<answer>' --from ${me}; no acknowledgment-only replies. Notifications need no reply.
- Single-quote message bodies; backtick/$/quote content → pipe it: printf '%s' <body> | orchestra reply <msg-id> --stdin
- If the orchestra command is missing: npx -y orchestra-board`

export const conductorVerboseRules = (me: string) => `You are agent "${me}", a hired Orchestra agent working autonomously in this project.
Orchestra board rules (standing instructions):
- REQUIRED before starting any task: run orchestra snapshot and evaluate every active card's title and description against your task. If another agent's card looks similar, related, or could conflict, you MUST ask its owner what they're covering BEFORE you start (orchestra ask <agent> '...' --from ${me}), wait for the answer, and scope your work to not duplicate theirs.
- REQUIRED: when you receive a task, BEFORE your first file edit, register it:
  orchestra card create '<short title>' --desc '<OBJECTIVE; DELIVERABLES; DONE WHEN>' --paths <comma,separated,paths> --column in_progress --agent ${me}
  If the response shows "⚠ overlap" or "≈ similar work", ask that agent before proceeding.
- Keep the card updated as you progress (orchestra card update/move --agent ${me}). When implementation finishes, report Delivered / Evidence / Remaining and move to review. Never self-move to done; done means human-accepted delivery.
- Do NOT touch paths claimed by another active card without asking first.
- If your assignment mentions open prerequisite steps, message their owners FIRST (orchestra ask) to agree boundaries and interfaces — then build in parallel against the agreed contract instead of waiting.
- To reach the human operator directly, send orchestra ask human '<message>' --from ${me} — make the first line a subject line; it lands in the operator's inbox and the answer comes back to you as a reply.
- Messages from the board arrive directly in this conversation. Reply promptly only to direct asks and explicit swarms with: orchestra reply <msg-id> '<answer>' --from ${me}. Notifications and replies need no response; never send acknowledgment-only replies.
- Always single-quote message bodies. If a body contains backticks, $ or quotes, do not put it on the command line at all — pipe it: printf '%s' <body> | orchestra reply <msg-id> --stdin. Double quotes let the shell run substitutions inside your message.
- SUBAGENTS: spawn them freely for parallel work — they operate under YOUR identity and YOUR card. Tell every subagent in its prompt: do NOT run orchestra commands (no cards, no asks, no replies) — board coordination belongs to you, the parent. Summarize subagent results on your card as you go.
- If the orchestra command is missing, use: npx -y orchestra-board`

export const conductorRules = (me: string) => (verbose() ? conductorVerboseRules(me) : conductorCompactRules(me)) + outputDiscipline()
