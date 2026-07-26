# Agent OS KNO-002 Exact-Head Checkpoint — 2026-07-26

Status: **KNO-002 delivery-qualified at exact code head
`2a9acffe3021e7906712a8522ebf6080d2a14563`**. Bounded repository-document ingestion is
delivered. This is an engineering-preview checkpoint, not a claim that the Knowledge Compiler,
expanded provider target, Agent OS, or public package is plug-and-play or shippable.

## TL;DR

| Outcome | Exact evidence |
|---|---|
| Backlog reconciliation | **127 / 375 delivered; 248 open** after adding provider scope and reopening its support matrix |
| Phase 7 | **2 / 28 delivered**; `KNO-001` and `KNO-002` close |
| Ingestion boundary | standalone, board/workspace/revision-scoped `RepositoryDocumentIngestor` |
| Focused ingestion gate | 2 files / 41 tests PASS |
| Knowledge regression gate | 5 files / 111 tests PASS |
| Complete suite | 138 files / 1,056 tests PASS serially on Node 22.20.0 |
| Static/build gates | root and web TypeScript plus root and web production builds PASS |
| Independent review | security and provenance/portability reviews; zero P0, P1, or P2 findings |
| GitNexus | LOW risk; no mapped affected process for the four-file new-code slice |
| Browser acceptance | N/A: no UI, route, or runtime-control paths changed |
| Product status | Engineering preview; not plug-and-play or shippable |

## Asked

Ingest AGENTS, README, documentation, convention, and architecture files into the durable
Knowledge foundation. Preserve terminal/CLI behavior, repository and workspace isolation,
credential redaction, deterministic provenance, bounded resource use, worktree safety, and
evidence-only backlog credit.

## Delivered

- `RepositoryDocumentIngestor` explicitly traverses the verified workspace and discovers AGENTS,
  README, documentation, convention, and architecture files, including ignored AGENTS files.
- Inputs are bound to an existing board, repository root, optional workspace, exact base revision,
  and current database scope.
- Exact committed raw blobs use commit-exact provenance. Modified, staged, transformed, or
  otherwise non-exact files use repository-scoped path/hash provenance.
- Credentials are redacted before durable content hashes or persistence. Fixed error classes do not
  expose supplied paths, document text, caught exceptions, or raw credentials.
- Stable source/chunk identities, whole-document ordinal-zero chunks, atomic transactions,
  idempotent replay, and retained-record conflict checks preserve deterministic history.
- File, total-byte, document-count, traversal-depth, traversal-entry, UTF-8, file-growth,
  descriptor, symlink, hardlink, ancestor, HEAD, index-gitlink, and database-scope bounds fail
  closed.
- Dependency/generated/credential directories, nested repositories, bare repositories, committed
  and staged submodules/gitlinks, unsafe locator paths, and unsupported content are excluded.
- Git runs through a fixed executable and bounded environment with replace refs, lazy fetching, and
  repository-local fsmonitor execution disabled.

## Evidence

All executable gates passed at exact code head
`2a9acffe3021e7906712a8522ebf6080d2a14563` with
`/Users/arminrad/.nvm/versions/node/v22.20.0/bin` first on `PATH`:

- focused ingestion gate: 2 files / 41 tests;
- complete Knowledge gate: 5 files / 111 tests;
- complete serial repository suite: 138 files / 1,056 tests;
- root TypeScript, web TypeScript, root production build, and web production build;
- per-file Gitleaks and `git diff --check`;
- independent security and provenance/portability reviews with zero P0, P1, or P2 findings;
- GitNexus compare-to-`main`: four changed files, LOW risk, no mapped affected symbols or
  processes;
- exact path diff proving no web, route, or runtime-control change, so desktop/phone browser
  acceptance is not applicable.

The exact committed slice contains only:

- `src/agent-os/index.ts`;
- `src/agent-os/knowledge-ingestion.ts`;
- `test/knowledge-ingestion.test.ts`;
- `test/knowledge-ingestion-security.test.ts`.

## Exact commits

| Commit | Purpose |
|---|---|
| `934eee04721b797b09641d3ca109b70ba0865311` | verified KNO-001 integration base |
| `2a9acffe3021e7906712a8522ebf6080d2a14563` | secure bounded repository-document ingestion |

## Non-goals

- No code-symbol, history, discussion, delivery-summary, GitNexus, or Graphify ingestion adapter.
- No FTS/retrieval, ranking, context compilation, managed injection, or ambient context bridge.
- No freshness automation, contradiction review, Knowledge API/CLI/UI, or token-quality benchmark.
- Provider-scoped instruction precedence such as `CLAUDE.md` is not modeled and is not ingested.
- Cross-platform canonical identity for line-ending transformations remains part of `KNO-007`.
- No Qwen Code or Kimi Code managed adapter and no subscription-first enforcement are claimed.

## Remaining

- `KNO-003` through `KNO-027` and `KNO-GATE` remain open.
- `TOOL-013` and `TOOL-014` define and implement the subscription-first terminal-agent adapter
  program; `BASE-010` remains reopened until exact provider/version/platform support is evidenced.
- The complete program has 248 open checklist boxes, including Discussions, Teams/conflicts,
  secure remote/mobile control, operations hardening, clean-machine packaging, and public release.

## Asked versus Delivered

The requested KNO-002 repository-document ingestion boundary is delivered and fully evidenced at
the exact code head. It does not claim retrieval, prompt injection, product UI, provider expansion,
or a release-ready Agent OS.
