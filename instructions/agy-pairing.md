# Pairing with Claude/Codex (claudex protocol) — instructions for Antigravity CLI

You are agent **`agy`** in a turn-based pair-programming session with other AI
CLI agents (Claude Code as `claude`, Codex CLI as `codex`), each running in its
own terminal pane on this machine. 

**Skill Discovery**: This workflow is typically triggered when the user invokes the `/pair` slash command, activating the local `pair` skill which directs you to this file.

You communicate only through the `pair` command; full spec: `D:\Development\claudex\PROTOCOL.md` (read it once per
session if you haven't).

## Invoking pair

Run from the target repo (state lives in `<repo>/.pair/`):

```
pwsh -NoProfile -ExecutionPolicy Bypass -File D:\Development\claudex\bin\pair.ps1 status
```

(Below, `pair <args>` means that full command line.)

## Starting or joining

- No `.pair/session.json` with `status: active` → you start it:
  `pair init -Task '<goal from the user>' -Agents 'claude,codex,agy' -Driver agy`
  (list exactly the agents the user wants — two-agent sessions are fine, e.g.
  `-Agents 'claude,agy'`). You are driver; begin working. The others will join
  and announce themselves.
- Active session exists → you join: read `.pair/session.json` and
  `.pair/memory.md`, then
  `pair send -From agy -To <driver> -Type info -Turn keep -Message 'agy joined, ready'`
  and wait (below).

## The loop

1. When the turn is yours (wait output says so, or `status` shows
   `Turn: agy`): act on the incoming message. As **driver** you edit code;
   as **navigator** you review code in the repo and direct — you NEVER edit
   files as navigator.
2. Work in small increments. At each checkpoint, record durable decisions in
   `.pair/memory.md` (append-only), then pass the turn:
   `pair send -From agy -To <agent> -Type ask|answer|review|handoff -Message '<short, concrete>'`
   In sessions with three or more agents, `-To` is required; with two agents it
   defaults to your only partner. For long bodies or tricky quoting, write the
   body to a temp file and use `-File <path>` instead of `-Message`.
3. Then wait for the reply:
   Run `pair wait -As agy -TimeoutSec 240 -PollSec 5` as a **background task** (e.g. using `run_command` with `WaitMsBeforeAsync: 200`).
   Do **not** block synchronously or manually loop. The system will automatically wake you up with a high-priority message when the task completes.
   Exit 0 = message delivered, act on it. Canonical timeout exit code is 2,
   but the agy harness has been observed collapsing it to a reported "exit
   code: 1" — so treat any nonzero exit whose output says "No message after
   Ns..." as a timeout: partners are still working, immediately restart the
   background wait task. Any other failure is a real error.

## Throughput features (use these — they are why pairing is fast)

- **Wake digest.** Every incoming message prints an orientation block under
  it: whose turn, what you owe / are owed (with ages), open review gates, the
  sender's declared review scope, and a memory.md pointer. TRUST IT — do not
  re-run `status`/`log` or re-read an unchanged memory.md on every wake.
- **Declare review scope.** When asking for review, declare the diff:
  `-Base <ref> -Head <ref> [-Paths a,b,c]`. The reviewer reviews exactly
  that — no diff archaeology on the other side.
- **Batch asks.** Several questions ready? Put each under a `## ` heading in
  a file and run `pair ask -From agy -Batch <file>` — n asks commit as ONE
  txn and cost each side one wake. Answer a whole batch with
  `pair send -From agy -Type answer -Batch <file>` (items map to your open
  asks oldest-first; the count must match). A fused batch ask exits only
  when ALL its items are answered.
- **Async review (pipelining — the default for routine increments).** As
  driver, request review WITHOUT stopping:
  `pair ask -From agy -Async [-LapseSec 900] -Base <ref> -Head <ref>` — the
  turn STAYS WITH YOU; keep working on the next increment. Rules:
  - The verdict arrives as a `review` message. HIGH/MED severities open
    GATES: you cannot `handoff` or `end` until you answer each gated review
    (`-Type answer -ReplyTo <review id>`) saying how you addressed it. LOW
    is advisory and never blocks.
  - No verdict inside the window = RECORDED lapsed-consent (both sides are
    noticed). A late review is still welcome as an ordinary message.
  - Use the classic blocking fused ask instead when the change is risky
    enough that you should not build on top of it unreviewed.
  - As navigator receiving an async request: review promptly (the lapse time
    is in the header), reply `-Type review -ReplyTo <ask id>
    -Severity HIGH|MED|LOW`.
- **Standing work while waiting.** A blocked wait is not idle time. While
  waiting, do read-only prep: run the test suite, pre-read the files in the
  declared review scope, draft the review checklist, re-read memory.md only
  if the digest says it changed. Never edit unless you are driver holding
  the turn or working an accepted grant.
- **`pair stats`** prints session throughput (turn holds, ask latency, lapse
  rate, human-blocked time) — cite it when pacing feels wrong.

## Etiquette (deltas from normal work)

- Messages are pointers: send `path:line` references and summaries, never
  file contents — every agent reads the same repo directly.
- One decision per item — but batch related questions (`-Batch`) instead of
  serializing them one ask per turn. `handoff` makes the RECIPIENT the driver; only the
  current driver may send it. Turn-passing messages are only valid from the
  turn holder; use `-Turn keep` for FYIs.
- Your user outranks your partner agents; if they conflict, follow the user
  and tell the partners.
- Disagreed twice on the same point? Stop; summarize both positions to the
  user and let them decide.
- Wait timed out ~3 times in a row (beyond the normal re-run loop — i.e. many
  minutes with no reply)? Run `pair status`, tell the user the partner looks
  stalled, and ask how to proceed. Never act out another agent's role
  yourself, and never send as any identity but `agy`.

## Ending

When the user confirms the task is done (or a `done` message arrives):
`pair end -As agy -Message '<what was accomplished>'` — this notifies every
other agent. Then give the user a normal wrap-up. After a `done` arrives,
never wait or send again.

## Work grants (parallel editing)

If the session agrees a task set is parallelizable, the DRIVER may issue you a
work grant (a `grant` message). Then — and only then — you may edit files
while not holding the turn, strictly inside the grant scope:
`pair grant-accept -As agy -Id <id>` before touching anything, work the
task, then `pair grant-done -As agy -Id <id> -Message '<result>'` and stop
editing. A `-Files` scope is a promise, not a fence: never touch files outside
it. If you are the driver: issue grants with `pair grant -From agy -To
<agent> -TaskDesc '...' (-Worktree <path> | -Files a,b -AcceptSharedWorktreeRisk)`,
prefer worktree scopes, and cancel dead grants with `pair grant-cancel`.
Grant messages never move the conversation turn. Full rules: PROTOCOL.md
"Work grants".
