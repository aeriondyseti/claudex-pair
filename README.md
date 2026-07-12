# claudex

Pair programming between interactive AI CLI agents — **Claude Code**,
**Codex CLI**, and **Antigravity CLI** — each in your own Windows Terminal
pane, collaborating through a file-based, turn-based message protocol.
Sessions take any number of agents (two is the common case). No daemon, no
pane automation, no visual layer: you own the terminals; claudex owns the
conversation between the agents.

Inspired by [claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge)
(its `/ask` delegation + shared memory), minus the WezTerm/mobile UI.

## How it works

Each target repo gets a `.pair/` directory: a `session.json` (task, agents,
roles, whose turn), per-agent inboxes, an archive (full transcript), and a
shared `memory.md`. Agents exchange markdown messages via `pair send`; an
agent "listens" by blocking on `pair wait`, which prints, archives, and
reports whose turn it is. One agent is **driver** (edits code), all others
are **navigators** (review, direct — never edit); a `handoff` message makes
its recipient the driver. Turn-passing is only accepted from the turn holder
and `handoff` only from the driver — the CLI enforces both. Full spec:
[PROTOCOL.md](PROTOCOL.md).

## Components

| path | what |
|---|---|
| `bin/pair.ps1` | the CLI: `init` `send` `wait` `ask` `status` `log` `watch` `end` |
| `bin/pair.cmd`, `bin/pair` | cmd / Git Bash shims |
| `PROTOCOL.md` | canonical protocol spec (both agents read this) |
| `instructions/claude-pairing.md` | operating instructions for Claude Code |
| `instructions/codex-pairing.md` | operating instructions for Codex CLI |
| `instructions/agy-pairing.md` | operating instructions for Antigravity CLI |
| `~/.claude/skills/pair/SKILL.md` | `/pair` in Claude Code |
| `~/.agents/skills/pair/SKILL.md` | `$pair` skill in Codex CLI (agents-skills standard; browse via `/skills`) |
| `~/.gemini/config/skills/pair/SKILL.md` | `/pair` skill in Antigravity CLI (`agy`) |

The global instruction files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`)
carry an identical pointer section, so those agents also recognize an active
session without the slash command (e.g. "ask codex what it thinks"); agy
relies on its skill description for the same effect.

## Usage

```
┌────────────────────────┬────────────────────────┐
│ pane 1:  claude        │ pane 2:  codex         │
│ > /pair build a rate-  │ > $pair join the       │
│   limiter for the API  │   pairing session      │
├────────────────────────┴────────────────────────┤
│ pane 3 (optional):  pair watch                   │
│ live transcript: status, turn, message stream    │
└──────────────────────────────────────────────────┘
```

1. Open one pane per agent in the same repo; start `claude`, `codex`, and/or
   `agy` in them.
2. Give **any** agent the pairing skill with the task — `/pair <task>` in
   Claude Code and agy, `$pair <task>` in Codex — and it inits the session
   (listing the participants via `-Agents`) and becomes driver. Tell each
   other agent to join — it becomes a navigator and waits. Agents also
   recognize an active session from plain requests like "join the pairing
   session".
3. Watch them ping-pong: implement → review → fix → handoff. Interject in
   any pane whenever you like; you outrank the agents.
4. Optional extra pane: `pair watch` for a live color-coded transcript
   (read-only; `pair status` / `pair log` for point-in-time views).
5. Finish by telling any agent to end the session (`pair end` writes the
   summary to `.pair/memory.md` and notifies every other agent).

If a wait ever times out (exit code 2), it's not an error — the partner is
still working; the agent just re-arms the wait.

## Notes

- Requires PowerShell 7 (`pwsh`). State is per-repo; `pair init` adds
  `.pair/` to that repo's `.gitignore`.
- Codex CLI must be allowed to run `pwsh` (approve the command or allowlist
  it in `~/.codex/config.toml`); same for agy on first use.
- The mailbox is plain markdown on disk — `git`-free and debuggable with a
  file explorer. Sessions support any agent list (`-Agents`); the conversation
  is single-turn-token, but the driver can issue **work grants**
  (`pair grant`) so several agents edit in parallel within agreed scopes —
  see "Work grants" in [PROTOCOL.md](PROTOCOL.md). Richer topologies and the
  coordination broker are designed in
  [docs/ENHANCEMENTS.md](docs/ENHANCEMENTS.md) (M1–M6) and not yet built.
