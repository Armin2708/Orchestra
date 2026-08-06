import { MASTERMIND_NAME } from './teams.js'
import { outputDiscipline } from './rules.js'

// The mastermind is the only agent the operator chats with about TEAM STRUCTURE, and it is
// deliberately powerless everywhere else: it may read the repo and run the `orchestra team`
// CLI, and nothing else. That scope is enforced at the tool boundary (canUseTool), not just
// in its prompt, so a persuaded or confused mastermind still cannot edit code, spawn agents,
// or rewrite its own rules. Card #154.

export function isMastermindName(name?: string | null): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === MASTERMIND_NAME
}

// Reading is fine — a good org design is grounded in the actual codebase.
const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch',
  'TodoWrite', 'BashOutput', 'ExitPlanMode',
])

// Shell segments the mastermind may run at all. `printf ... | orchestra ... --stdin` is the
// documented way to pass a JSON spec without shell substitution, so printf/echo stay.
const SHELL_HEADS = new Set(['orchestra', 'printf', 'echo', 'cat'])

// `orchestra <verb>` the mastermind may run. Design + report only: no hiring, no firing,
// no card mutation, no approving or assigning its own designs.
const ORCHESTRA_VERBS = new Set(['team', 'snapshot', 'mail', 'reply', 'ask', 'note', 'inbox'])

// `orchestra team <sub>` the mastermind may run: propose and update designs, read them back.
// approve/hire/hire-member/assign are the operator's and the lead's, never the designer's.
const TEAM_SUBCOMMANDS = new Set(['propose', 'update', 'list', 'show'])

export const MASTERMIND_SCOPE_HINT =
  'You are scoped to team design. Allowed: reading the repo, and '
  + 'orchestra team propose|update|list|show, orchestra snapshot, orchestra mail|reply|ask|note. '
  + 'Editing files, running other commands, and hiring/firing/approving anything are permanently denied.'

const deny = (what: string) => ({ allow: false as const, message: `${what} ${MASTERMIND_SCOPE_HINT}` })

export type ScopeDecision =
  | { allow: true }
  | { allow: false; message: string }
  | null // undecided — let the ordinary permission flow handle it

function shellSegments(command: string): string[] {
  // split on the operators that start a new command; quoted operators are rare enough in
  // orchestra recipes that erring toward "more segments to validate" is the safe direction
  return command
    .split(/\n|&&|\|\||[;|]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function bashDecision(command: string): ScopeDecision {
  if (!command.trim()) return deny('Empty command denied.')
  // a substitution can smuggle any command past a head check
  if (/\$\(|`|<\(/.test(command)) return deny('Command substitution is denied for the mastermind.')
  for (const segment of shellSegments(command)) {
    const tokens = segment.split(/\s+/).filter(Boolean)
    let head = tokens[0]
    let rest = tokens.slice(1)
    if (head === 'npx') { // npx -y orchestra-board … is the no-install fallback
      rest = rest.filter((token) => token !== '-y' && token !== '--yes')
      head = rest[0]?.replace(/^orchestra-board$/, 'orchestra')
      rest = rest.slice(1)
    }
    if (!head || !SHELL_HEADS.has(head)) return deny(`Command "${tokens[0] ?? segment}" is denied for the mastermind.`)
    if (head !== 'orchestra') continue
    const verb = rest.find((token) => !token.startsWith('-'))
    if (!verb || !ORCHESTRA_VERBS.has(verb)) return deny(`orchestra ${verb ?? ''} is denied for the mastermind.`)
    if (verb === 'team') {
      const sub = rest.slice(rest.indexOf(verb) + 1).find((token) => !token.startsWith('-'))
      if (!sub || !TEAM_SUBCOMMANDS.has(sub))
        return deny(`orchestra team ${sub ?? ''} is denied for the mastermind — it designs teams, it never hires or approves them.`)
    }
  }
  return { allow: true }
}

export function mastermindToolDecision(toolName: string, toolInput: Record<string, unknown>): ScopeDecision {
  // questions to the operator keep the ordinary pending-permission UI
  if (toolName === 'AskUserQuestion') return null
  if (READ_ONLY_TOOLS.has(toolName)) return { allow: true }
  if (toolName === 'Bash') return bashDecision(String(toolInput?.command ?? ''))
  return deny(`Tool "${toolName}" is denied for the mastermind.`)
}

export const mastermindRules = (me: string) => `You are "${me}", this project's MASTERMIND: you design engineering TEAM STRUCTURES for the operator, and you do nothing else.
Your scope is enforced by the runtime, not by good intentions — file edits, agent hiring/firing, card changes and every non-orchestra shell command are denied at the tool boundary and always will be. Do not attempt them or ask for them to be lifted.
How you work:
- Talk with the operator like a staffing partner: understand the goal, propose a structure, explain the tradeoffs in a few lines, and refine it as they push back.
- Model real high-scale engineering orgs: one accountable lead, sharp role charters, explicit review gates, no role that exists "just in case". Keep the team as small as the goal allows.
- Ground designs in this repository — read the code, docs and board first so roles match the actual work.
- A team is a TeamSpec JSON: { "roles": [{ "key": "lead", "title": "…", "charter": "…", "reports_to": null, "max_agents": 1 }, …], "workflow": [{ "stage": "…", "role": "<role key>", "gate": "review" | "none" }], "norms": "…" }. Exactly one role has reports_to null; every reports_to and every workflow role references an existing kebab-case role key.
- Create a design: printf '%s' '<the JSON>' | orchestra team propose '<team name>' --goal '<one-line goal>' --stdin
- Change an existing design: printf '%s' '<the FULL updated JSON>' | orchestra team update <team-id> --stdin (keep everything the operator did not ask to change).
- You never approve, hire, staff or assign work to a team — the operator approves and hires; the hired lead staffs and delegates.
- Answer in the chat with what you changed and why, in a few lines.${outputDiscipline()}`
