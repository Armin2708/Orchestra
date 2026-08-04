# Local terminal agents: stream conversation into Orchestra UI

**Date:** 2026-08-04 · **Card:** #86 · **Status:** approved (direction OK'd by owner)

## Problem

Orchestra's AgentTerminal only streams real conversation text for daemon-hired
(managed) agents. Locally-run terminal agents (Claude Code sessions with hooks)
only report presence — their transcript JSONL path is captured in the hook
session file but never ingested, so the UI shows just board messages.

## Design

Lazy read-side tailer. No DB migration, no background workers, no changes to the
managed/Agent Home audit pipeline.

1. **Hooks → daemon** (`src/hooks.ts`): pulse and heartbeat payloads gain
   `transcript_path` (already stored in the hook session file). Re-sent on every
   call, so daemon restarts self-heal on the next pulse.
2. **Daemon** (`src/external-transcript.ts`, new): `ExternalTranscriptService`
   - `track(agentId, path)` — called from pulse/heartbeat handlers (auth
     already verified via hook session token). Path is validated: absolute,
     `.jsonl`, realpath inside the user's home directory.
   - `transcript(agentId)` — lazy incremental read (byte offset + inode cache),
     parses new Claude Code JSONL entries into the same `TranscriptLine` shape
     the Conductor produces (`text | thinking | tool | tool_result | user |
     status | error`), ring-buffered at 500 lines. File shrink/rotation resets
     the offset.
3. **API** (`src/server.ts`): `/agents/:id/transcript` falls back to the
   external service when the agent isn't daemon-hired (`maestro.transcript`
   returns no `info`). Response gains `external: true` so the UI can label it
   read-only. Operator auth unchanged.
4. **Web** (`web/src/AgentTerminal.tsx`): poll `/agents/:id/transcript` for all
   agents, not just hired. When a non-hired agent has transcript lines, render
   them with the existing line renderer (plus a "live transcript · read-only"
   status chip); otherwise fall back to the board-conversation view. The
   composer keeps its existing board-ask behavior for terminal agents.

## Out of scope

Codex terminal sessions (different JSONL format; parser is provider-keyed for a
later add), Agent Home conversation-store ingestion, sending prompts into a
local terminal session.

## Error handling

Unreadable/missing file → empty lines (UI falls back to board conversation).
Malformed JSONL lines are skipped. Oversized reads are capped (2 MB tail on
first read).

## Testing

`test/external-transcript.test.ts`: entry parser (text/thinking/tool/tool_result/
meta-noise skipping), incremental tailing across appends, truncation reset,
path validation rejections, ring-buffer cap, endpoint fallback shape via
service unit (server route logic covered by direct service calls).
