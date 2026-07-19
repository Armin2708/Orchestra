# Show HN draft

**Title:** Show HN: Orchestra – a live coordination board for Claude Code agents

I built Orchestra after repeatedly running several Claude Code sessions in one
repository and watching them duplicate work or edit the same files. It is a
local daemon plus web kanban: sessions register through hooks, claim cards and
paths, receive overlap warnings, and can message each other while they work.

The newer workflow goes beyond presence: milestone review gates, an independent
delivery verifier, a serialized test-gated merge queue, card-to-commit history,
and manual/automatic wake after Claude usage-limit resets. The board is also an
installable PWA and can be exposed to a phone through a token-protected tunnel.

Everything is local (`127.0.0.1` + SQLite under `~/.orchestra`); there is no
Orchestra account or hosted backend. The CLI/plugin is MIT licensed.

GitHub: https://github.com/Armin2708/Orchestra

npm: https://www.npmjs.com/package/orchestra-board

I would especially value feedback from people running more than two coding-agent
sessions: are advisory path claims enough, or should the board support an
optional hard lock?
