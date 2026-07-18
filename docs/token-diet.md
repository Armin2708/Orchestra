# Token diet — measured A/B results

Orchestra injects context into every agent session (rules, board snapshot, message
deliveries, nudges, stop-block reasons). The token-diet milestone (#34–#38) shrinks
those injections without weakening coordination compliance. This report proves both
halves: the reduction is real, and the compliance gates behave identically.

## Methodology

`test/token-diet-ab.test.ts` replays one **identical** multi-turn agent scenario
against a fresh in-memory daemon per arm and captures every byte each hook injects:

> session-start (rules + board dump on a seeded 8-card / 4-agent board) → no-card
> registration nudge → scripted card registration → human message delivery →
> overlapping card created by a rival agent → stale-card nudge (>10 min) → card
> update → stop-block on a stale in_progress card → stop loop-guard → card done →
> silent stop → session-end

Agent names are pinned so both arms are byte-comparable. Tokens are computed as
`ceil(chars / 4)` — the same formula as the telemetry endpoint
(`GET /api/v1/boards/:id/telemetry`, card #34), so these numbers line up with the
live meter. Reproduce with:

```sh
node scripts/ab-token-diet.mjs        # markdown tables
node scripts/ab-token-diet.mjs --json # raw report
```

The same harness run on different commits measures each diet step's effect; run on
one commit with `ORCHESTRA_VERBOSE_RULES=1` vs unset it A/Bs the rollback flag.

## Injected tokens per session (identical replayed scenario)

| hook event | pre-diet (8e1f9dc) | after #36 (10c07de) | after #35 (compact) | reduction |
|---|---|---|---|---|
| session_start (rules + board dump) | 530 | 530 | _pending #35 merge_ | — |
| user_prompt_submit (nudges) | 50 | 38 | 38 | 24% |
| post_tool_use (messages + nudges) | 87 | 48 | 48 | 45% |
| stop (block reason) | 86 | 37 | 37 | 57% |
| **total** | **751** | **652** | _pending_ | **13.2% so far** |

> **Status:** interim. #36 (nudge discipline) and #37 (done-work awareness, no
> injection impact) are merged and measured above. #35 (compact rules + snapshot)
> is on branch `token-diet-35`; the session_start row and the ≥50% total verdict
> will be finalized when it merges. These are per-session figures on the synthetic
> board; session_start recurs on every session and compaction scales with board
> size, so real-world savings grow with board activity.

Nudge/stop savings compound in practice: under #36 the stop hook no longer blocks
at all when the card was updated in the last 10 minutes (the harness backdates the
card to force a block deterministically), and repeat nudges drop the command
syntax, so a compliant agent sees near-zero stop/nudge tokens in real sessions.

## Compliance gates (identical scenario, both arms)

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

10/10 gates pass identically in both modes (enforced by the test suite on every
run — a regression fails CI, not just this report).

## Live monitoring

The web system meter (top bar) shows a persistent **injected** stat: cumulative
injected tokens across boards, with a per-agent breakdown in the tooltip. It reads
`GET /api/v1/boards/:id/telemetry` and stays hidden on daemons that predate the
endpoint.

## Rollback

The compact injections can be reverted per-process without a deploy:

```sh
export ORCHESTRA_VERBOSE_RULES=1
```

- Read at render time by `src/hooks.ts` (CLI session injections) and
  `src/conductor.ts` (hired-agent prompts) — restart the affected session/daemon
  to apply.
- `=1` restores the full verbose rules + unscoped board dump; unset (or any other
  value) keeps the compact defaults.
- The A/B suite (`test/token-diet-ab.test.ts`) runs the verbose arm through this
  exact flag, so rollback parity is retested continuously.
