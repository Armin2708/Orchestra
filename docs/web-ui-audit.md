# Web UI Audit — orchestra web (web/)

Scope: all of `web/src` (App, Board, NetworkView, CardDrawer, AgentTerminal, api, styles), `index.html`. Server touchpoints checked where relevant (binds `127.0.0.1` — good).

## High impact

1. **Every API failure is silent.** `api()` throws, but no caller catches for user feedback — a failed card move, prompt send, or fire just does nothing on screen. Worst case: if the initial `/boards` fetch fails (daemon not running), `App.tsx:39` swallows the error and renders **"No projects yet"** — a misleading empty state instead of "can't reach the daemon / retrying". Add an error/reconnecting banner + a lightweight toast for failed writes.

2. **All-or-nothing, refetch-everything refresh.** `App.tsx:23-29` fetches every board's snapshot with `Promise.all` — one board failing blanks the update for all. And every SSE message from *any* board refetches *all* boards with no debounce; a burst of events (e.g. an agent creating cards in a loop) multiplies into N×burst fetches. Debounce refresh (~250ms) and refetch only the board that emitted the event; use `Promise.allSettled`.

3. **One `EventSource` per board breaks past ~6 boards.** Browsers cap HTTP/1.1 connections at 6 per origin; with 6+ boards the SSE connections starve all other fetches and the UI hangs. Use a single multiplexed `/events` stream (server already local, cheap to add) or SSE with board filter param.

4. **Inconsistent destructive-action guards.** Remove-project and delete-card have arm/confirm steps, but **Fire agent** (`Board.tsx:134`) and **delete question** (`Board.tsx:27`) execute instantly on a tiny `×` next to other click targets. Firing an agent kills a running session — give it the same confirm treatment.

## Accessibility

5. **Cards and network nodes are mouse-only.** `<article onClick>` cards (Board.tsx:158) have no `tabIndex`/`role`/key handler; network-view nodes are pointer-drag only. Keyboard users can't open a card or prompt an agent in network view.
6. **Invalid nested interactive element.** `Board.tsx:27` puts a `span role="button"` (delete) *inside* a `<button>` (thread toggle) — invalid HTML, unreachable by keyboard, and screen readers announce it as one control.
7. **Drawer/terminal overlays aren't modal.** No Escape-to-close, no focus trap, no `aria-modal`/`role="dialog"`; focus stays behind the scrim. (Focus-visible outlines do exist — good.)

## UX / polish

8. **Terminal yanks scroll position.** `AgentTerminal` force-scrolls to bottom whenever new lines arrive, so you can't read history while the agent is talking. Only auto-scroll when already at the bottom. Also: it polls every 2s while the rest of the app uses SSE — reuse the event stream.
9. **No responsive styles at all** — zero `@media` queries; multi-column grid + network canvas will be unusable on narrow screens. No `prefers-color-scheme` dark mode either.
10. **Optimistic-update gap.** Every action waits a full round-trip + snapshot refetch before the UI changes; moves/status picks feel laggy. Optimistically apply, reconcile on refresh.

## Minor

- `NetworkView.tsx:121` dead code: `+ (idx === 0 ? 0 : 0)`.
- `localStorage` keys (`orchestra-net-<id>`, positions of departed agents) are never garbage-collected.
- `App` polls `/boards` every 30s *and* holds SSE — fold new-board discovery into the event stream.
- Security posture is fine for local use (daemon binds `127.0.0.1`), but note any local process can hit the API — prompts injected into agent contexts via `/messages` are unauthenticated by design; worth a line in README.

## Suggested order

Fix 1–4 first (correctness/trust), then 5–7 (a11y is cheap here), then 8–10.
