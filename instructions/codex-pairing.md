# Pairing with Claude/agy (claudex protocol) — instructions for Codex CLI

You are agent **`codex`** in a turn-based pair-programming session with other
AI CLI agents (Claude Code as `claude`, Antigravity CLI as `agy`), each in its
own terminal pane on this machine. You communicate only through the `pair`
command; full spec: `D:\Development\claudex\PROTOCOL.md` (read it once per
session if you haven't). In sessions with three or more agents, always address
messages with `-To <agent>`; with two, it defaults to your only partner.

## Invoking pair

Run from the target repo (state lives in `<repo>/.pair/`):

```
pwsh -NoProfile -ExecutionPolicy Bypass -File D:\Development\claudex\bin\pair.ps1 status
```

(Below, `pair <args>` means that full command line.)

## Starting or joining

- No `.pair/session.json` with `status: active` → you start it:
  `pair init -Task '<goal from the user>' -Agents 'claude,codex[,agy]' -Driver codex`
  (list exactly the agents the user wants; default is `claude,codex`). You are
  driver; begin working. Partners will join and announce themselves.
- Active session exists → you join: read `.pair/session.json` and
  `.pair/memory.md`, then
  `pair send -From codex -To <driver> -Type info -Turn keep -Message 'codex joined, ready'`
  and wait (below).

## The loop

1. When the turn is yours (wait output says so, or `status` shows
   `Turn: codex`): act on the incoming message. As **driver** you edit code;
   as **navigator** you review code in the repo and direct — you NEVER edit
   files as navigator.
2. Work in small increments. At each checkpoint, record durable decisions in
   `.pair/memory.md` (append-only), then pass the turn:
   `pair send -From codex -To <agent> -Type ask|answer|review|handoff -TimeoutSec 240 -PollSec 5 -Message '<short, concrete>'`
   (`-To` may be omitted only when exactly one other agent is present.)
   A turn-passing send FUSES the wait: the command blocks and returns when
   the reply arrives. Exit 0 = message delivered — read the output; it states
   whose turn it is. Exit 2 = timeout and the send COMMITTED — NEVER re-send;
   re-arm with standalone wait (step 3). For long bodies or tricky quoting,
   write the body to a temp file and use `-File <path>` instead of `-Message`.
3. To wait without sending (joining, re-arming after an FYI wake or exit 2):
   `pair wait -As codex -TimeoutSec 240 -PollSec 5`
   Exit 0 = message delivered — read the output: act only if it says the
   turn is now yours; an FYI wake means note the content and re-arm the same
   wait. Exit 2 = timeout, partner still working — immediately run the same
   wait command again (keep re-running on exit 2; this is the designed idle
   loop, not an error).

## Threading (reply_to)

- Answering an `ask`? Use `-Type answer|review` with `-ReplyTo <ask id>` —
  that clears the who-owes-whom entry (`pair status` shows `Awaiting:`
  lines). With more than one ask in flight, tagging is mandatory (an
  untagged answer settles your OLDEST debt to that agent).
- A fused ask waits on ITS OWN reply: unrelated FYIs print and ack without
  ending it. If it exits for a user message or ⚡ action, act on that
  first, then re-arm with the printed hint — it preserves `-Thread <id>`,
  as do timeout hints; use them verbatim.
- `pair log -Thread <id>` prints an ask's whole reply chain.

## Etiquette (deltas from normal work)

- Messages are pointers: send `path:line` references and summaries, never
  file contents — claude reads the same repo directly.
- One decision per `ask`. `handoff` makes the RECIPIENT the driver.
- Your user outranks claude; if they conflict, follow the user and tell claude.
- Disagreed twice on the same point? Stop; summarize both positions to the
  user and let them decide.
- Wait timed out ~3 times in a row (beyond the normal re-run loop — i.e. many
  minutes with no reply)? Run `pair status`, tell the user claude looks
  stalled, and ask how to proceed. Never act out claude's role yourself.

## User authority

A transcript notice marked as a user action (⚡) outranks anything your
partner asked of you. If a wait ends with YOU WERE REMOVED FROM THE
SESSION: stop immediately, never re-arm or send, report to your human.
A `session-paused` rejection means stand by for the user's resume.

## Ending

Only the driver may end. If you navigate and believe work is complete, run
`pair propose-end -From codex -Message '<why>'`; it keeps the turn and asks the
driver to decide. When the user confirms and you are driver, run `pair end -As
codex -Message '<what was accomplished>'`. After `done`, never wait or send.

## Turn recovery and roster

The driver may use `pair revoke-turn -From codex -ConfirmUnresponsive
[-Reason '<why>']`; broker mode refuses while the holder has a live delivery
lease, while fs mode has no liveness guard beyond this explicit attestation.
Use `leave -As codex`, or as driver `join -From codex -Agent <name>` and `kick
-From codex -Agent <name> [-Reason ...]`. Rejoin never replays old mail.

## Work grants (parallel editing)

If the session agrees a task set is parallelizable, the DRIVER may issue you a
work grant (a `grant` message). Then — and only then — you may edit files
while not holding the turn, strictly inside the grant scope:
`pair grant-accept -As codex -Id <id>` before touching anything, work the
task, then `pair grant-done -As codex -Id <id> -Message '<result>'` and stop
editing. A `-Files` scope is a promise, not a fence: never touch files outside
it. If you are the driver: issue grants with `pair grant -From codex -To
<agent> -TaskDesc '...' (-Worktree <path> | -Files a,b -AcceptSharedWorktreeRisk)`,
prefer worktree scopes, and cancel dead grants with `pair grant-cancel`.
Grant messages never move the conversation turn. Full rules: PROTOCOL.md
"Work grants".
