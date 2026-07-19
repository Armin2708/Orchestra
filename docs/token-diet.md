# Token diet — measured A/B results

Orchestra injects context into every agent session (rules, board snapshot, message
deliveries, nudges, stop-block reasons). The token-diet milestone (#34–#38) shrinks
those injections without weakening coordination compliance. This report proves both
halves: **58.6% fewer injected tokens per session, with all 10 compliance gates
unchanged.**

## Methodology

`test/token-diet-ab.test.ts` replays one **identical** multi-turn agent scenario
against a fresh in-memory daemon per arm and captures every byte each hook injects:

> session-start (rules + board dump on a seeded board with 11 active cards / 4
> agents — sized to the live agentboard board at measurement time) → no-card
> registration nudge → scripted card registration → human message delivery →
> overlapping card created by a rival agent → stale-card nudge (>10 min) → card
> update → three ordinary turn-ends with a fresh card (a compliant agent mid-task)
> → stop-block on a stale in_progress card → stop loop-guard → card done → silent
> stop → session-end

Agent names are pinned so both arms are byte-comparable. Tokens are computed as
`ceil(chars / 4)` — the same formula as the telemetry endpoint
(`GET /api/v1/boards/:id/telemetry`, card #34), so these numbers line up with the
live meter. Reproduce with:

```sh
node scripts/ab-token-diet.mjs        # markdown tables
node scripts/ab-token-diet.mjs --json # raw report
```

Before/after numbers come from running the identical harness at the pre-diet
commit (`8e1f9dc`) and at post-diet main (#35 merged, `755c23b`); the same harness
run on one commit with `ORCHESTRA_VERBOSE_RULES=1` vs unset A/Bs the rollback flag.

## Injected tokens per session (identical replayed 4-turn scenario)

| hook event | before (8e1f9dc) | after (main, compact) | reduction |
|---|---|---|---|
| session_start (rules + board dump) | 641 | 341 | 46.8% |
| user_prompt_submit (nudges) | 50 | 38 | 24.0% |
| post_tool_use (messages + nudges) | 87 | 49 | 43.7% |
| stop (block reasons, 4 turn-ends) | 343 | 37 | 89.2% |
| **total** | **1120** | **464** | **58.6%** |

Where it came from:

- **#35 compact rules + snapshot** — session_start drops 641 → 341. Scales with
  board size: the bigger the board, the bigger the saving (the fixture's 11 active
  cards is the live board's size today).
- **#36 nudge discipline** — the stop hook no longer blocks when the in_progress
  card was updated within 10 minutes, so a compliant agent's ordinary turn-ends
  are free (pre-diet: one block per turn-end, 86 tok each). Nudges are one-liners
  and repeat reminders drop the command syntax.
- **#37 done-work awareness** — additive API fields and one CLI line; no injection
  impact, measured at 0.

Real sessions run far more than 4 turns, so the per-session stop savings above are
conservative; long sessions land well past 58.6%.

## Compliance gates (identical scenario, both arms, enforced in CI)

| gate | verbose | compact |
|---|---|---|
| rules contain the card-registration directive | ✓ | ✓ |
| no-card registration nudge fires on first turn | ✓ | ✓ |
| card registration succeeds (in_progress, owned) | ✓ | ✓ |
| human message delivered on next tool use | ✓ | ✓ |
| overlap surfaced when a rival claims the same paths | ✓ | ✓ |
| stale-card nudge fires after 10 min | ✓ | ✓ |
| card update succeeds | ✓ | ✓ |
| stop blocks once on a stale in_progress card | ✓ | ✓ |
| stop never re-blocks on the continuation turn | ✓ | ✓ |
| stop is silent once the card is done | ✓ | ✓ |

10/10 gates pass identically in both modes. The A/B suite runs as part of
`npm test`, so a compliance regression fails CI, not just this report. The same
gates were verified green at the pre-diet commit, so the diet changed token cost,
not behavior.

## Live monitoring

The web system meter (top bar) shows a persistent **injected** stat: cumulative
injected tokens across boards, with a per-agent breakdown in the tooltip. It reads
`GET /api/v1/boards/:id/telemetry` and stays hidden on daemons that predate the
endpoint.

## Rollback

The compact rules + snapshot (#35) can be reverted per-process without a deploy:

```sh
export ORCHESTRA_VERBOSE_RULES=1
```

- Read at render time by `src/hooks.ts` (CLI session injections) and
  `src/conductor.ts` (hired-agent prompts) — restart the affected session/daemon
  to apply.
- `=1` restores the full verbose rules + unscoped board dump; unset (or any other
  value) keeps the compact defaults.
- The flag covers the #35 text only. The #36 stop/nudge cadence (no block on a
  fresh card, one-line reminders) is not flag-gated — reverting that means
  reverting merge `10c07de`.
- The A/B suite (`test/token-diet-ab.test.ts`) runs the verbose arm through this
  exact flag on every test run, so rollback parity is retested continuously.
  Measured on main today: verbose arm 763 tok vs compact 464 tok per session.
- 2026-07-19, #53 (shell-safe messages): every example body in the rule variants is
  single-quoted and the conductor/verbose variants carry a prefer-`--stdin` note —
  token-neutral for the compact arm (still 464 tok/session; quote swaps are
  length-preserving, the note lives outside the budgeted compact text).

## Output discipline (#57)

Output tokens are ~5x the input price and never cache — so after shrinking what
orchestra injects, the next win is shrinking what agents *say*. Every role prompt
(hired, strategist, auditor, verifier, and the CLI hook rules) now ends with a
single discipline block: lead with the outcome, no preamble/recaps/play-by-play,
board messages and card descs carry deltas only, final summaries ≤2 sentences,
comments only where code can't say it.

**Input cost of the block: 224 chars ≈ 56 tok per session** (CI-asserted <60 in
`test/output-discipline.test.ts`, alongside once-per-prompt presence in every
role variant in both rules modes, and rollback). The block is identical in both
rules arms, so all 11 A/B compliance gates (10 original + `output_discipline_present`)
stay green and the #35 diet ratio is measured with the block excluded.

**Output-side saving, measured live** (`npx tsx scripts/ab-output.mjs`, real SDK,
3 scripted turns per arm, 2026-07-19, claude-haiku-4-5-20251001; not run in CI —
CI enforces the deterministic invariants instead):

| turn | undisciplined (tok) | disciplined (tok) | reduction |
|---|---|---|---|
| completion_report | 47 | 34 | 28% |
| status_update | 88 | 57 | 35.6% |
| plan_ack | 194 | 124 | 36.4% |
| **total** | 328 | 214 | **35%** |

Net: the block pays for its 56-tok input cost as soon as a session produces ~160
tok of would-be output (a single turn), and output is where #56's usage split
(`↓ out` in the terminal footer) will show it in production.

Rollback, independent of the rules flag:

```sh
export ORCHESTRA_VERBOSE_OUTPUT=1   # removes the block from every role prompt
```
