# Beta Lane D browser quality checkpoint

Status: **automated gates ready; QA-013 and QA-014 remain open**

## Asked

Own the independent QA-013–QA-015 slice: a desktop/tablet/phone interaction matrix, keyboard,
focus, screen-reader and color-contrast checks, and observed-baseline performance gates for
startup, snapshots, transcript loading, graph views and search. Failure artifacts must redact
secrets. The in-app Browser evidence boundary must remain explicit.

## Delivered

- `scripts/qa-browser-gates.mjs` runs an isolated, dependency-free Chromium DevTools Protocol
  fallback against a disposable Orchestra home and Chrome profile. It never reads browser
  cookies, storage, profiles or credentials.
- The frozen matrix is desktop `1440 × 1000`, tablet `834 × 1194`, and phone `390 × 844`.
- Every viewport runs 12 real journeys across graph, Agent Home transcript/search, Messages,
  Workspace, Timeline, Shipped, Open Work, Organization, Roadmap, Settings and Board.
- The scale fixture uses 18 graph agents and 250 durable transcript events. Snapshot, transcript,
  graph and search timings use the real application/API paths.
- Accessibility gates inspect accessible names, 12-step keyboard focus traversal, Chrome's full
  accessibility tree and computed WCAG text contrast.
- Artifacts contain bounded redacted JSON only. The runner does not capture HTML, response bodies,
  local/session storage, transcripts or screenshots. Credential-shaped fields, bearer values,
  environment assignments and URL credentials are redacted before writing.
- Every DevTools command has a 20-second timeout, so a wedged renderer fails instead of hanging CI.
- `docs/qa-browser-performance-baseline.json` retains three observations and derives budgets with
  `ceil(max(observed p95 × 4, observed p95 + 100ms))`; these are single-host engineering budgets,
  not public SLOs.
- `test/qa-browser-quality.test.ts` freezes the matrix, required surfaces, budget provenance,
  redaction, contrast calculation and fail-closed evidence validation.

## Evidence

Environment:

- Source application commit: `0dd3dd43b9f376370ee73a9e2fe4725974caaae8`.
- Node `22.20.0`; npm `10.9.3`.
- Project environment files: none.
- In-app Browser inventory: exactly `[]`.
- Fallback surface: standalone Google Chrome headless through CDP.

Retained capture digests:

- `6b649c7a9ad24afd535bbe0307aed12de4a30011d8857ab3734de1cb6d454e47`
- `c14d4b909c5720d8f3c3a8bc66522d64f946287075d754b0db43d03e368a4807`
- `5d75f345537658959f3ebae82f4d5fe04b17d29b57b991e36452e81f7801dc33`

The checked-baseline rerun at `2026-08-02T07:51:51.429Z` produced digest
`f6ebf4a75add835d77a558053847640694c044611e8660d74afc61818df44054`.
All 15 performance observations stayed below their derived budgets:

| Viewport | Startup | Snapshot | 250-event transcript | Graph | Search |
|---|---:|---:|---:|---:|---:|
| Desktop | 84.7 / 3,113 ms | 730.1 / 8,998 ms | 295.1 / 2,011 ms | 2.7 / 105 ms | 46.1 / 522 ms |
| Tablet | 96.4 / 1,557 ms | 843.0 / 6,040 ms | 347.0 / 1,945 ms | 10.4 / 113 ms | 45.6 / 237 ms |
| Phone | 109.6 / 1,126 ms | 829.6 / 8,152 ms | 301.7 / 3,034 ms | 8.1 / 110 ms | 88.7 / 645 ms |

All 36 journeys completed. Accessible-name, keyboard-focus and accessibility-tree gates passed in
all three viewports. Fresh captures reported no console errors, page exceptions or failed observed
API requests.

Focused contract gate:

```text
npx vitest run test/qa-browser-quality.test.ts
1 file / 6 tests passed
```

## Observed blockers

The exact failure set was stable across all three captures and the baseline-gated rerun:

1. Desktop text contrast fails.
2. Tablet text contrast fails.
3. Phone document width exceeds the viewport by 149 px.
4. Phone text contrast fails.

The phone width is caused by the global `.sr-only` absolute-position rule retaining its static
horizontal position inside the scrolling navigation. The visually hidden node appears at
`x=538..539` in a 390 px viewport. The tab rows themselves are intentionally horizontally
scrollable and are not the document-width root cause.

Lane B owns the shared CSS. The minimal integration candidates to verify there are:

```css
/* web/src/agentOs.css — pin visually-hidden content so it cannot enlarge the document */
.sr-only {
  inset: 0 auto auto 0;
  clip-path: inset(50%);
}
```

Contrast remediation must preserve the design while reaching WCAG AA. Start with these observed
selectors/tokens, choose darker values, then rerun the computed gate rather than accepting the
example values blindly:

- `web/src/styles.css`: `--ink-soft`, `.meter-label`, `.meter-reset`, stale/degraded meter text and
  `.usage-caret`; observed ratios ranged from `2.72` to `4.48` against their rendered backgrounds.
- `web/src/agentHome.css`: `--ah-muted`, `--ah-faint`, `.ah-rail > header p`, `.ah-kicker`,
  `.ah-header-fact > span`, `.ah-runtime-links b`, `.ah-search label`, `.ah-event > footer`,
  `.ah-conversation-foot small`, `.ah-detail-section > header span`, `.ah-fact-list dt`,
  `.ah-attention-list time`, and `.ah-history-list small, code`; observed ratios were approximately
  `2.87` to `3.08` for the first visible failures.
- Candidate starting values for visual review are `#6f6d68` on white/off-white for general muted
  text and `#68625a` inside Agent Home, but the automated gate is authoritative after Lane B's
  complete CSS is integrated.

## Remaining

- **QA-013 stays open.** The in-app Browser inventory was `[]`; standalone CDP fallback evidence
  cannot prove the intended Browser surface.
- **QA-014 stays open** until Lane B/integration fixes the shared overflow and contrast findings and
  this exact automated matrix passes without `--capture-only`.
- QA-015 has an implemented observed-baseline regression gate and its checked rerun passed every
  performance budget. The central integrator must wire the command into the release/CI gate because
  this lane was prohibited from changing root `package.json` or release workflows.
- Central integration command after the CSS train lands:

  ```sh
  node scripts/qa-browser-gates.mjs \
    --baseline docs/qa-browser-performance-baseline.json \
    --output /absolute/redacted/evidence.json
  ```
