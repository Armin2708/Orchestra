// Rule texts injected at session start. Compact by default; ORCHESTRA_VERBOSE_RULES=1
// restores the pre-diet wording. The env var is read on every call so the daemon and
// hooks can flip modes without a restart.
export const verbose = () => process.env.ORCHESTRA_VERBOSE_RULES === '1'

export const compactRules = (me: string) => `orchestra rules:
- You are "${me}"; always pass --agent/--from ${me}.
- Before starting: similar/conflicting card → orchestra ask <agent> "..." --from ${me}; wait for the answer.
- Before your first file edit: orchestra card create "<title>" --desc "<scope>" --paths <p1,p2> --column in_progress --agent ${me}; "⚠ overlap"/"≈ similar" → ask first.
- orchestra card update/move as you go; move to done when finished.
- Never touch paths claimed by another active card without asking.
- Subagents NEVER run orchestra commands — you coordinate.
- Full board: orchestra snapshot --full`

export const verboseRules = (me: string) => `orchestra rules (coordination board for this project — these are standing instructions):
- You are agent "${me}". ALWAYS pass --agent ${me} on card commands and --from ${me} when asking/replying.
- REQUIRED before starting any task: read the board below and evaluate every active card's title and description against your task. If another agent's card looks similar, related, or could conflict with what you're about to do, you MUST ask its owner what they're covering BEFORE you start: orchestra ask <agent-name> "<question>" --from ${me}. Wait for the answer, then scope your work to not duplicate theirs.
- REQUIRED: as soon as you receive a task, and BEFORE your first file edit, register it:
  orchestra card create "<short title>" --desc "<scope>" --paths <comma,separated,paths> --column in_progress --agent ${me}
  If the response shows "⚠ overlap" or "≈ similar work", ask that agent before proceeding.
- Keep your card updated as work progresses: orchestra card update <id> --desc "<what you're doing now>" --agent ${me}; move it (orchestra card move <id> done|review|blocked --agent ${me}) when status changes. Move to done when finished.
- Do NOT touch paths claimed by another active card without asking first. Replies arrive automatically.
- SUBAGENTS: spawn them freely — they work under YOUR identity and card. Instruct each one: do NOT run orchestra commands; board coordination belongs to you, the parent.`

export const hookRules = (me: string) => (verbose() ? verboseRules(me) : compactRules(me))

export const conductorCompactRules = (me: string) => `You are agent "${me}", a hired Orchestra agent working autonomously in this project.
${compactRules(me)}
- Open prerequisite steps? orchestra ask their owners first to agree interfaces, then build in parallel.
- Board messages arrive in this conversation; answer with: orchestra reply <msg-id> "<answer>" --from ${me}, then continue your task.
- If the orchestra command is missing: npx -y orchestra-board`

export const conductorVerboseRules = (me: string) => `You are agent "${me}", a hired Orchestra agent working autonomously in this project.
Orchestra board rules (standing instructions):
- REQUIRED before starting any task: run orchestra snapshot and evaluate every active card's title and description against your task. If another agent's card looks similar, related, or could conflict, you MUST ask its owner what they're covering BEFORE you start (orchestra ask <agent> "..." --from ${me}), wait for the answer, and scope your work to not duplicate theirs.
- REQUIRED: when you receive a task, BEFORE your first file edit, register it:
  orchestra card create "<short title>" --desc "<scope>" --paths <comma,separated,paths> --column in_progress --agent ${me}
  If the response shows "⚠ overlap" or "≈ similar work", ask that agent before proceeding.
- Keep the card updated as you progress (orchestra card update/move --agent ${me}); move it to done when finished.
- Do NOT touch paths claimed by another active card without asking first.
- If your assignment mentions open prerequisite steps, message their owners FIRST (orchestra ask) to agree boundaries and interfaces — then build in parallel against the agreed contract instead of waiting.
- Messages from the board arrive directly in this conversation; answer questions promptly with: orchestra reply <msg-id> "<answer>" --from ${me}, then continue your task.
- SUBAGENTS: spawn them freely for parallel work — they operate under YOUR identity and YOUR card. Tell every subagent in its prompt: do NOT run orchestra commands (no cards, no asks, no replies) — board coordination belongs to you, the parent. Summarize subagent results on your card as you go.
- If the orchestra command is missing, use: npx -y orchestra-board`

export const conductorRules = (me: string) => (verbose() ? conductorVerboseRules(me) : conductorCompactRules(me))
