# Landing-site Lottie audit

All four demos are 1440×810 at 60 fps with a 10-second loop. They use the vendored full `lottie-web` player, the page's Geist/Geist Mono fonts, and the existing light-app-inside-dark-site presentation.

## Verification method

- Served with `python3 -m http.server 8766 --directory site` (the existing server on port 8766 was reused).
- Used Playwright from the requested scratchpad and pinned the registered Lottie animations with `goToAndStop(milliseconds, false)` before capturing each `.frame.demo`.
- Clean audit B: **100, 900, 1700, 2500, 3300, 4100, 4500, 5200, 6100, 6900, 8000, 8800, 9500 ms**.
- Clean audit C (offset between the first audit's moments): **300, 1200, 2100, 2900, 3700, 4300, 4800, 5600, 6400, 7300, 8400, 9200, 9800 ms**.
- Key-beat coverage included join pop/line draw, join drag, mail entrance/click/reply/send/delivery, review move/deny/bounce/human drag/acceptance, and memory command/save/persist/next-session injection.
- Full-page scaling checks: **1440×900 viewport** (1440×7291 full-page capture) and **390×844 viewport** (390×6309 full-page capture). On mobile every demo measured 350 px wide and the page reported no horizontal overflow.

## `demo-join.json`

**Problems found**

- The terminal floated in the lower-left while the board action happened far away, so the command did not read as the cause of the new agent.
- Agent names, terminal output, and the drag result were too small at landing-page scale.
- The new agent's connection and cursor were easy to lose, and the final drag state lacked a clear explanation.

**Changes**

- Rebuilt the frame as a stable two-panel composition: terminal on the left, labeled live board on the right.
- Added a three-beat header (`RUN IN TERMINAL` → `AGENT JOINS` → `DRAG · LINK FOLLOWS`) with only the current beat highlighted.
- Enlarged the typed command and joined output, then sequenced output → agent pop → dashed connection → joined callout.
- Kept `teal-ibex`, its nameplate, cursor, pulse, and dashed edge on the same animated path during the drag; the final label states that the link stays attached.
- Fixed the vendored player's dashed-stroke requirement by naming both dash and gap entries; early frames and the full loop now render reliably.

**Evidence**

- Audits B and C checked all listed times; focused beats were visible around **3300–4800 ms** (join) and **6100–8400 ms** (drag/follow).

## `demo-mail.json`

**Problems found**

- The incoming card, inbox row, reading pane, reply field, and delivery toast felt like separate scenes rather than one routing flow.
- The original reading/reply copy was too small, while the incoming card could peek into the frame as an orphan before its entrance.
- Send-to-terminal delivery was implied but not spatially anchored.

**Changes**

- Rebuilt the layout as a fixed Inbox list beside a fixed reading pane, with a target terminal badge in the pane.
- Started the incoming mail fully off-screen, moved the complete card into the Inbox, highlighted it, and attached the cursor click to that row.
- Revealed the message in place, typed the reply in the compose bar, activated Send, and flew a small envelope toward `violet-puffin · terminal`.
- Added a final delivery toast tied to the terminal target and a three-beat header (`INCOMING` → `OPEN + REPLY` → `TERMINAL DELIVERY`).

**Evidence**

- Audits B and C checked all listed times; focused beats were visible around **1200–2900 ms** (entrance/click), **3700–6900 ms** (open/type/send), and **7300–9200 ms** (terminal delivery/toast).

## `demo-review.json`

**Problems found**

- The avatar, moving card, gate, denial message, and human cursor could appear detached or overlap.
- The gate was small and ambiguous, while the accepted state became an oversized green block unrelated to the original card.
- Column counts did not visibly explain the state transition.

**Changes**

- Rebuilt a four-column Kanban with stable Triage / In progress / Review / Done geometry and live counts.
- Attached `violet-puffin` and its avatar to the moving card as it enters Review and attempts Done.
- Placed a persistent dashed boundary and `REVIEW GATE · HUMAN ONLY` label clear of the avatar path.
- Animated the denied attempt into the boundary, bounced the card back, and displayed a large but non-overlapping `DENIED · needs a human` state.
- Attached the `HUMAN` tag to the cursor during the second drag, removed it after drop, updated Done to 13, and replaced the original card with a same-sized accepted card/check.

**Evidence**

- Audits B and C checked all listed times; focused beats were visible around **1700–2900 ms** (agent to Review), **4100–5600 ms** (gate/deny/bounce), and **6100–9200 ms** (human drag/accept).

## `demo-memory.json`

**Problems found**

- The memory chip and storage slot floated between two terminals without a strong path or chronological handoff.
- The disabled future terminal looked like an unrelated gray panel, and injection appeared without enough anticipation.
- Command, persistence, and future-session context competed at the same visual weight.

**Changes**

- Rebuilt a left-to-right three-stage layout: CLAUDE terminal → persistent `ORCHESTRA_HOME` slot → CODEX terminal.
- Sequenced command typing and confirmation before moving the note along a drawn path into the storage slot.
- Added a saved check and `SAVED ONCE` hold before announcing `NEW CODEX SESSION` and brightening the future terminal.
- Drew the second path only after the new session appears, then injected a multiline `=== MEMORY ===` block and confirmed that context is already loaded.
- Added a three-beat header (`REMEMBER` → `PERSIST` → `INJECT NEXT SESSION`) so each cause/effect stage remains explicit.

**Evidence**

- Audits B and C checked all listed times; focused beats were visible around **2100–4800 ms** (remember/persist) and **6100–9200 ms** (new session/inject/loaded).
