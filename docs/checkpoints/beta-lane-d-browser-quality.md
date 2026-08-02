# Beta Lane D browser quality checkpoint

Marker: `[beta-lane-d-browser-p1-remediated]`

Status: **QA-015 evidence gate implemented; QA-013 and QA-014 remain open**

## Asked

Own QA-013–QA-015: desktop/tablet/phone browser journeys; keyboard, focus, screen-reader and
contrast checks; and observed startup, snapshot, transcript, graph and search performance. The
gate must fail closed on stale artifacts or unverified budgets and retain bounded redacted evidence.

## Delivered

- `scripts/qa-browser-gates.mjs` runs 12 journeys at desktop `1440 × 1000`, tablet `834 × 1194`
  and phone `390 × 844` against a disposable, token-authenticated daemon and Chrome profile.
- The fixture uses authenticated public APIs for its board, 18 agents, card, workspace, canonical
  job/session, durable identity/conversation and 250 events. It does not mutate the live database.
- Readiness now requires 18 graph agents rendered, at least 250 transcript events rendered and
  exactly five matching search results rendered. A button, input or empty container is insufficient.
- Every one of the 36 journey/viewport combinations records accessible-name, forward/reverse
  keyboard/focus, Chrome AX-tree and opaque-background contrast evidence. Agent Home also checks
  modal keyboard activation, reverse focus trapping, Escape close and focus restoration.
- Pointer/touch, keyboard and DOM fallback now run from separate reset states. Each mode has its
  own readiness assertion and result. DOM fallback is labeled `counts_toward_pass: false` and can
  never make a failed pointer or keyboard journey pass. The new observations truthfully retain the
  independent failures under QA-014.
- User-journey performance samples are taken only from the pointer mode. DOM fallback is explicitly
  `diagnostic_only` and `performance_eligible: false`; changing its elapsed time cannot affect a
  retained sample, p95 or budget. Each performance record separately retains
  `quality_gate_passed`, so a fast failed pointer attempt is never presented as a quality pass.
- Conversation search acquires keyboard focus by bounded Tab navigation and records the Tab-event
  count. Its keyboard branch contains no pointer activation or programmatic focus acquisition.
- Interaction readiness requires two consecutive observations with a 4-second bound, while async
  render/page readiness has a separate 10-second bound. All three retained runs completed with the
  same 55 honest quality findings instead of flaking on the former 750 ms deadline.
- Navigation attempts hit-tested mouse/touch and keyboard activation before its deterministic DOM
  fallback. Search types through DevTools keyboard events and exercises the real React form/search
  flow. The interaction method and any fallback remain visible in source and evidence.
- Contrast only evaluates opaque computed text over opaque solid backgrounds. Translucent,
  composited, image or opacity cases are marked unsupported instead of being reported as passes.
- No network failure is blanket-ignored. `/events` failures are treated like every other failed
  request. The retained observations and checked rerun had zero failed requests, console errors and
  page exceptions.
- Normal mode requires an explicit `--baseline`, a valid baseline digest, retained observation
  digests, exact viewports/surfaces and finite `budget_ms` values whose `budget_source` is
  `checked_observation`. Capture mode emits observations only and cannot self-budget.
- Baseline samples, p95 and budgets are recomputed directly from every retained observation during
  validation; changing claimed values and recomputing the self-digest still fails.
- Retained paths must resolve to real non-symlink files inside
  `docs/qa-evidence/browser-quality/`; absolute, escaping and symlink paths fail closed.
- Manifest creation refuses dirty tracked source, hashes every tracked file with SHA-256, builds
  both artifacts after that clean-source check, and records the bounded ignored runtime directories.
- The build manifest binds the tested `dist/` and `web/dist/` trees to exact Git HEAD plus recursive
  SHA-256 artifact digests. Missing, stale or changed artifacts fail before Chrome starts.
- Evidence defaults to `artifacts/qa/browser-quality/evidence.json`, outside the disposable runtime,
  and is never deleted by the runner. Its internal digest is independently recomputable after
  removing only `sha256` and `validation_errors`.
- Three bounded, redacted observations are retained in `docs/qa-evidence/browser-quality/`.
  `scripts/create-browser-baseline.mjs` validates them and deterministically regenerates the baseline.

## Performance policy and evidence

The beta experience ceilings are explicit product expectations, not multiples of an arbitrarily
slow run:

| Surface | Beta experience ceiling |
|---|---:|
| Startup | 1,500 ms |
| Snapshot loading | 3,000 ms |
| 250-event transcript loading | 3,500 ms |
| 18-agent graph view | 1,000 ms |
| Search with five rendered matches | 750 ms |

Each checked budget is the lower of its experience ceiling and the regression bound
`max(2 × observed p95, observed p95 + 150 ms)`. The retained baseline digest is
`aed64e9907f0059ac5f7cf817e07e4fc53eac04d8323d45a6434da52bf06cb0b`.

Retained observation evidence/file digests:

| Observation | Evidence SHA-256 | File SHA-256 |
|---|---|---|
| 1 | `f2301fe15e0d2aa6e785aa1dde22abf6fbaaf4ce74f04625e06fc52514adfbbf` | `57787b833431618227b97132a6a4fac6743b096eb0aee11b982ecf480eb704bc` |
| 2 | `10afd56e73dbdf38c20677a5bc121f0b039ce509353bcccb245dc87d65cb7f29` | `bd5599328ad62d043c7dd2b75a62e9b02e177d2d290391344961a4d54a0cf79a` |
| 3 | `594d6556d5b3c2def5d02a2dd75da9a79701d302ddbf04aed9faf59f4cfe8413` | `055560f61a92c5a253431074e3d495cb3388a0d10a1d538e4d5ad159f5bc281d` |

The regenerated baseline recomputes these p95/budget pairs directly from the three retained runs:

| Viewport | Startup | Snapshot | Transcript | Graph | Search |
|---|---:|---:|---:|---:|---:|
| Desktop | 90 / 241 ms | 395 / 791 ms | 530 / 1,061 ms | 423 / 847 ms | 616 / 750 ms |
| Tablet | 260 / 520 ms | 574 / 1,148 ms | 616 / 1,232 ms | 460 / 920 ms | 917 / 750 ms |
| Phone | 76 / 226 ms | 913 / 1,826 ms | 574 / 1,149 ms | 600 / 1,000 ms | 180 / 361 ms |

The tablet search observation exceeded the 750 ms product ceiling in one retained run; the checked
exact-head reruns therefore remain authoritative for the current-run performance result, while the
baseline preserves that outlier rather than normalizing it away. The final integrator must
regenerate the build manifest and evidence at the exact integrated HEAD.

## Honest accessibility/browser findings

- **QA-013 remains open:** the in-app Browser inventory was exactly `[]`. Standalone Chrome CDP
  evidence does not prove the intended in-app Browser surface.
- **QA-014 remains open:** all 36 surfaces were inspected and the expanded coverage found real
  failures rather than preserving the earlier narrow pass:
  - Timeline and Roadmap contain unnamed input/combobox controls in both DOM and AX evidence.
  - Forward/reverse traversal finds offscreen terminal controls and surfaces where focus falls out
    of the interactive set.
  - Enter did not open the create-agent modal in the automated keyboard journey, so modal trap,
    Escape and restoration cannot be claimed as passing.
  - Every journey has at least one opaque text contrast failure. Translucent/composited cases are
    reported unsupported, not passed.
  - Phone retains the known 149 px document overflow from `.sr-only` static positioning.
- Shared UI/CSS ownership remains with Lane B/integration. This lane records the findings and does
  not silently modify shared navigation or styles.

## Reproduction

```sh
npm run build
npm --prefix web run build
node scripts/qa-browser-gates.mjs \
  --write-artifact-manifest artifacts/qa/browser-quality/build-manifest.json
node scripts/qa-browser-gates.mjs \
  --baseline docs/qa-browser-performance-baseline.json
```

The second command is expected to retain evidence and exit non-zero until QA-014 is remediated.
