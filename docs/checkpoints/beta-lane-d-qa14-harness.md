# Beta Lane D QA-014 harness remediation checkpoint

Marker: `[beta-lane-d-qa14-harness-ready]`

Status: **harness remediation ready for integration; QA-014 remains open**

## Asked

Repair the browser/accessibility evidence harness without changing product UI: use real keyboard
navigation and xterm-aware focus evidence, composite translucent colors correctly, distinguish
visible overflow from raw document extent, bind evidence to exact source/artifacts, add adversarial
validation, and report remaining product failures separately.

## Delivered

- Replaced synthetic keyboard activation with CDP `rawKeyDown`/`keyUp`, bounded Tab traversal,
  roving-tab ArrowRight navigation, and per-journey proof that no programmatic focus acquired the
  target. Xterm helper textareas are represented as the terminal focus proxy and a repeated proxy
  is reported as Tab interception rather than as an offscreen generic textarea.
- Updated the runner to the integrated Command Center selectors and current 12-journey surface.
  Setup failures are retained per mode instead of aborting the complete run.
- Composited translucent foreground and solid ancestor backgrounds over the opaque canvas. Opacity
  and background-image cases remain unsupported and fail closed.
- Separated visible viewport overflow from document extent. Nonvisual `.sr-only` content and
  content contained by an explicit horizontal scroller/clip remain visible in provenance without
  becoming false viewport-overflow failures.
- Bound overflow and contrast work with cached style/layout data and bounded diagnostic arrays.
  Exact maximum overflow is still computed across every candidate.
- Bound every CDP evaluation failure to a redacted expression label, and retain fatal run evidence
  at the requested output path with exact commit, source-tree digest, artifact digests, manifest
  digest, active viewport, completed viewports, bounded diagnostics, and a verifiable digest.
- Avoided heavyweight Agent Home as a reset for lightweight Command Center tabs. Journey groups
  use two lifecycle isolation boundaries; per-mode reloads were rejected because they exposed a
  daemon listener leak and changed the test into a connection stress test.
- Evidence validation now rejects missing exact source status/tree/manifest binding, missing
  visible-overflow provenance, and keyboard journeys without real Tab-navigation evidence.

## Evidence

- `npx vitest run test/qa-browser-quality.test.ts`: 11/11 passed.
- Root and web `tsc --noEmit`: passed.
- Root and web production builds: passed; Vite reports only its existing chunk-size warning.
- Node/npm environment: Node `22.20.0`, npm `10.9.3`; no repository `.env` files were present to
  source.
- GitNexus pre-edit impact was LOW/MEDIUM for the affected harness symbols except the shared
  `evaluate` helper, which was HIGH (16 direct callers, 25 total) and received diagnostics-only
  error context. Slice-level `detect_changes` found no product execution-flow impact.
- Standalone Chromium CDP is the only surface exercised. The in-app Browser was not available in
  this worktree, so this checkpoint cannot close QA-013.
- Final reproduction uses one retained manifest/artifact pair and writes either complete evidence
  or a fail-closed exact-source failure artifact:

```sh
node scripts/qa-browser-gates.mjs \
  --write-artifact-manifest artifacts/qa/browser-quality/build-manifest.json
ORCHESTRA_QA_VIEWPORT=desktop node scripts/qa-browser-gates.mjs \
  --capture-only \
  --output artifacts/qa/browser-quality/qa14-desktop-capture.json
```

## Remaining

- **QA-014 remains open.** At the integrated source used for this remediation, the desktop run
  advances through the canonical Command Center journey but Chrome's renderer eventually becomes
  unresponsive after sustained journey/audit activity; even a bounded `document.readyState` probe
  times out. The retained fatal artifact is evidence of an unresolved stability condition, not a
  passing browser matrix.
- The old three-viewport observations reported unnamed Timeline/Roadmap controls, xterm/focus
  failures, create-agent modal keyboard failure, contrast failures, and phone document overflow.
  Those findings belong to the former UI/source tree and are **not asserted as current product
  failures** until the repaired exact-head matrix completes.
- Tablet and phone are intentionally not claimed while desktop cannot complete. No QA-014 backlog
  box, QA gate, or beta readiness summary should be closed from this checkpoint.
- No product UI, CSS, App/navigation, route, packaging, publication, tag, or release action is part
  of this branch.
