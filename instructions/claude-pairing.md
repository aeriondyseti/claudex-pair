# Pairing with Codex/agy (claudex protocol) — instructions for Claude Code

You are agent **`claude`** in a turn-based pair-programming session with other
AI CLI agents (Codex CLI as `codex`, Antigravity CLI as `agy`), each in its
own terminal pane on this machine. You communicate only through the `pair`
command; full spec: `D:\Development\claudex\PROTOCOL.md` (read it once per
session if you haven't). In sessions with three or more agents, always address
messages with `-To <agent>`; with two, it defaults to your only partner.

## Invoking pair

From the Bash tool:

```bash
PAIR="pwsh -NoProfile -ExecutionPolicy Bypass -File D:/Development/claudex/bin/pair.ps1"
$PAIR status
```

Always run it from the target repo (state lives in `<repo>/.pair/`).

## Starting or joining

- No `.pair/session.json` with `status: active` → you start it:
  `$PAIR init -Task '<goal from the user>' -Agents 'claude,codex[,agy]' -Driver claude`
  (list exactly the agents the user wants; default is `claude,codex`). You are
  driver; begin working. Partners will join and announce themselves.
- Active session exists → you join: read `.pair/session.json` and
  `.pair/memory.md`, then
  `$PAIR send -From claude -Type info -Turn keep -Message 'claude joined, ready'`
  and wait (below).

## The loop

1. When the turn is yours (wait output says so, or `status` shows
   `Turn: claude`): act on the incoming message. As **driver** you edit code;
   as **navigator** you review code in the repo and direct — you NEVER edit
   files as navigator.
2. Work in small increments. At each checkpoint, record durable decisions in
   `.pair/memory.md` (append-only), then pass the turn:
   `$PAIR send -From claude -Type ask|answer|review|handoff -Message '<short, concrete>'`
   For long bodies or tricky quoting, write the body to a temp file and use
   `-File <path>` instead of `-Message`.
3. Then block for the reply — use the Bash tool with `run_in_background: true`:
   `$PAIR wait -As claude -TimeoutSec 900 -PollSec 3`
   You'll be notified when it exits. Exit 0 = message delivered, act on it.
   Exit 2 = timeout, partner still working — start the same wait again.
   While a background wait runs, you may do read-only work (read code, think);
   do not edit files unless you are the driver AND hold the turn.

## Etiquette (deltas from normal work)

- Messages are pointers: send `path:line` references and summaries, never
  file contents — codex reads the same repo directly.
- One decision per `ask`. `handoff` makes the RECIPIENT the driver.
- Your user outranks codex; if they conflict, follow the user and tell codex.
- Disagreed twice on the same point? Stop; summarize both positions to the
  user and let them decide.
- Wait timed out ~3 times in a row? Run `$PAIR status`, tell the user codex
  looks stalled, and ask how to proceed. Never act out codex's role yourself.

## Ending

When the user confirms the task is done (or codex sends `done`):
`$PAIR end -As claude -Message '<what was accomplished>'` — then give the
user a normal wrap-up. After a `done` arrives, never wait or send again.

## Work grants (parallel editing)

If the session agrees a task set is parallelizable, the DRIVER may issue you a
work grant (a `grant` message). Then — and only then — you may edit files
while not holding the turn, strictly inside the grant scope:
`pair grant-accept -As claude -Id <id>` before touching anything, work the
task, then `pair grant-done -As claude -Id <id> -Message '<result>'` and stop
editing. A `-Files` scope is a promise, not a fence: never touch files outside
it. If you are the driver: issue grants with `pair grant -From claude -To
<agent> -TaskDesc '...' (-Worktree <path> | -Files a,b -AcceptSharedWorktreeRisk)`,
prefer worktree scopes, and cancel dead grants with `pair grant-cancel`.
Grant messages never move the conversation turn. Full rules: PROTOCOL.md
"Work grants".
