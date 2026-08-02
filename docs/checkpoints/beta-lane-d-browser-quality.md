# Beta Lane D browser quality checkpoint

Marker: `[beta-lane-d-browser-final-remediated]`

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
`113aa164fbfd59c60e24f31034fe61ba7961d1333e73affeed502e98390a59fb`.

Retained observation evidence/file digests:

| Observation | Evidence SHA-256 | File SHA-256 |
|---|---|---|
| 1 | `97d2029c4aa02265121b6baef121f13c2712c6975e6b0d9c6e28fca9ae343b3b` | `d34a3b5fdf24bde18d36470d571b124e04d9c1c1a16a20c1885c99ae69183332` |
| 2 | `7b998236dca0d9fccc953c448caa120812841cff20c0c2294944171fc74cb9a2` | `97f224d4605511c13d3400e5beab8ca301d766f1ee105ca10d1eabfc34324b51` |
| 3 | `b31800a70b3244bda7d9d0a2f2dbb193e784d0428e16e24d3f635761b6951625` | `64b8d9d7cb271211ccfdfc0214735e183785ab989ab75fe328e8aee340a0f978` |

The checked rerun used those budgets and passed all 15 performance comparisons:

| Viewport | Startup | Snapshot | Transcript | Graph | Search |
|---|---:|---:|---:|---:|---:|
| Desktop | 80 / 229 ms | 416 / 725 ms | 2,813 / 3,500 ms | 363 / 703 ms | 190 / 411 ms |
| Tablet | 81 / 235 ms | 466 / 1,352 ms | 2,874 / 3,500 ms | 355 / 1,000 ms | 186 / 513 ms |
| Phone | 217 / 1,198 ms | 696 / 1,963 ms | 2,699 / 3,500 ms | 348 / 790 ms | 196 / 366 ms |

The pre-ready checked evidence digest was
`3258be974c8e2a60a8ddbb184a4602259cde644c33da27c8fd380824779af123`.
The final integrator must regenerate the build manifest and evidence at the exact integrated HEAD.

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
