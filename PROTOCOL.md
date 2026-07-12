# claudex pairing protocol

Turn-based pair programming between interactive AI CLI sessions — Claude Code
(`claude`), Codex CLI (`codex`), Antigravity CLI (`agy`), … — each running in
its own terminal pane. Sessions have n ≥ 2 agents; two is simply the common
case. There is no daemon and no pane automation: agents communicate
exclusively through files in a `.pair/` directory at the target repo's root,
using the `pair` command (`D:\Development\claudex\bin\pair.ps1`).

## Model

- **Named agents**, declared at init (`-Agents 'claude,codex[,agy,...]'`).
  An agent only ever sends as itself (`-From <self>`) and waits as itself
  (`-As <self>`). Impersonating a partner corrupts the session, and the CLI
  rejects identities that are not session participants.
- **One turn token.** `session.json` records whose `turn` it is. Only the
  turn-holder acts (edits files, writes `.pair/memory.md`, sends messages that
  pass the turn — the CLI enforces this). All other agents block on
  `pair wait`; they may still send FYIs with `-Turn keep`.
- **Two roles**: one `driver` (edits code) and one or more `navigators`
  (review, direct, answer questions — never edit files). Roles are independent
  of the turn: navigators take turns too (to review, answer, direct) but
  express all change requests as messages to the driver, not as edits.
- **Addressing**: `-To` is required whenever more than one possible recipient
  exists; in a two-agent session it defaults to the only partner.
- **Receiving = blocking on `pair wait`.** The wait command prints incoming
  messages, archives them, and tells the agent whether the turn is now theirs.
  Exit code `2` means timeout — re-run wait; the partner is still working.

## Filesystem layout (in the target repo, not in claudex)

```
.pair/
├── session.json     # task, agents, driver, navigators, turn, status, started
├── memory.md        # shared session memory: decisions, open questions, handoff notes
├── inbox/
│   ├── claude/      # messages awaiting claude   (NNNN-<from>-<type>.md)
│   ├── codex/       # messages awaiting codex
│   └── <agent>/     # one inbox per session agent (e.g. agy)
└── archive/         # delivered messages (full session transcript)
```

Messages are markdown files with a YAML-style header (`id`, `from`, `to`,
`type`, `turn`, `sent`) followed by the body. They are written atomically
(temp file + rename), so a reader never sees a partial message. `pair init`
adds `.pair/` to the repo's `.gitignore`.

## Message types

| type      | meaning                                                        | turn      |
|-----------|----------------------------------------------------------------|-----------|
| `ask`     | question / request that needs a reply                          | pass      |
| `answer`  | reply to an `ask`                                              | pass      |
| `review`  | navigator's verdict on the driver's work                       | pass      |
| `handoff` | the **recipient becomes driver**; everyone else navigates      | pass      |
| `info`    | FYI that needs no reply (progress note, "joined the session")  | keep      |
| `done`    | session complete (emitted by `pair end`, sent to every agent)  | keep      |

`-Turn pass` (default) hands the turn to the recipient; `-Turn keep` delivers
without giving up the turn (recipient sees it on their next wait/check).

Enforced invariants: a turn-passing message is only accepted from the current
turn-holder, and `handoff` is only accepted from the current driver. FYIs
(`-Turn keep`) may be sent by anyone at any time.

## Work grants (grants-lite)

When the agents **agree in conversation** that a set of tasks is parallelizable
without conflict, the driver can issue **work grants** so several agents edit
simultaneously. This is the interim, file-only shape of the grant model in
`docs/ENHANCEMENTS.md` (M3/M4); a broker will later replace the mechanics but
not the concepts.

- **Editing rule (amended).** An agent may edit files iff it is (a) the driver
  holding the turn, or (b) the assignee of an **active** grant, strictly within
  that grant's scope. Everything else in the protocol is unchanged.
- **Lifecycle**: `offered` → (`grant-accept`) → `active` → (`grant-done`) →
  `done`, or → `cancelled` (driver only, any open state). The assignee must
  accept before editing. Grant records live in `.pair/grants/<id>.json`; every
  transition runs under a per-grant lock and rejects stale states (issuer
  cancel and assignee complete can race legitimately).
- **Scopes**: `-Worktree <path>` **declares** a pre-provisioned isolated git
  worktree/branch for the assignee (create it around issuance, e.g.
  `git worktree add <path> -b pair/<grant-id>`; the driver merges results).
  claudex records the declaration — it does not provision or enforce the
  worktree, so compliance is still discipline; the isolation is what makes
  this the M4-shaped mode. `-Files a,b,c` shares the main worktree and is
  **advisory only — NOT M4-safe**: it requires the explicit
  `-AcceptSharedWorktreeRisk` acknowledgement and a file list all agents
  agreed is disjoint. When in doubt, use worktrees. Note: `.pair/` lives in
  the coordinator repo, not in a worktree — an assignee working inside its
  worktree must call mailbox/grant commands with `-Root <coordinator repo>`.
- **Turn independence.** Grant traffic (`grant`, `grant-done`, `grant-cancel`
  messages) always travels with `turn: keep`; the conversation turn token is
  never moved by grant activity. The driver keeps directing the session while
  grantees work.
- **Provenance**: `-AgreedIn <message-id>` records which conversation message
  agreed the parallel split.
- **Honest limits** (until the broker): scope compliance in `-Files` mode is
  instruction-level discipline; there is no lease/expiry — a dead assignee's
  grant is cancelled manually by the driver; `session.json` concurrency
  characteristics are unchanged.

## Session lifecycle

1. **Init** — whichever agent is asked first runs
   `pair init -Task '<goal>' -Agents '<all participants>' -Driver <self>` and
   becomes driver (default agents: `claude,codex`). Exactly one `pair init`
   per session; if `.pair/session.json` already shows `status: active`, join
   instead.
2. **Join** — each other agent reads `session.json` + `memory.md`, announces
   itself (`pair send -From <self> -To <driver> -Type info -Turn keep
   -Message 'joined, ready'`), then blocks on `pair wait -As <self>`.
3. **Loop** — the turn-holder works, then sends (usually `ask` or `review`)
   and waits. Typical rhythm: driver implements a small increment → sends
   `ask` ("review this: <files/summary>") → navigator reviews the actual code
   in the repo → sends `review` → driver addresses findings → repeat.
4. **Handoff** — to swap roles, the current driver sends `-Type handoff`;
   the recipient becomes driver (recorded in `session.json` automatically).
   A navigator who wants to drive asks; the driver replies with a handoff.
5. **End** — when the user says the task is finished (or the pair agrees and
   the user confirms), one agent runs `pair end -As <self> -Message
   '<summary>'`. This appends the summary to `memory.md`, notifies every
   other agent, and blocks further sends. All agents then report to their
   users.

## Rules of conduct

- **Small increments.** Pass the turn at every natural checkpoint (plan
  drafted, function written, test green). Don't disappear for an hour of
  work; the protocol's value is the tight review loop.
- **Messages are pointers, not payloads.** Both agents have the same repo on
  disk. Send file paths, `path:line` references, and short summaries — never
  paste whole files. The receiver reads the code directly.
- **One decision per `ask`.** Compound questions get half-answered.
- **Navigator never edits.** Not code, not tests, not docs. Change requests
  travel as messages. (Exception: after a `handoff`, roles have swapped.)
- **Memory discipline.** Before passing the turn, record durable decisions in
  `.pair/memory.md` (append-only; never rewrite the partner's entries). On
  receiving the turn after a long wait, re-read `memory.md` first.
- **The user outranks the partner.** If your user's instructions conflict
  with a partner message, follow the user and tell the partner why.
- **Escalate disagreement, don't loop.** If the pair disagrees twice on the
  same point, stop ping-ponging: summarize both positions to your user and
  let the humans decide.
- **Stale partner.** If `wait` times out repeatedly (~3 times) with no
  message, run `pair status`, tell your user the partner seems stalled, and
  ask how to proceed. Never silently take over the partner's role.

## Waiting mechanics per CLI

- **Claude Code** — run wait as a background task (harness notifies on exit):
  `pwsh -NoProfile -ExecutionPolicy Bypass -File D:/Development/claudex/bin/pair.ps1 wait -As claude -TimeoutSec 900 -PollSec 3`
  with `run_in_background: true`. On exit 2, start it again.
- **Codex CLI** — run wait as a normal foreground command with a timeout the
  harness tolerates: `... wait -As codex -TimeoutSec 240 -PollSec 5`, and
  re-run it whenever it exits with code 2.
- **Antigravity CLI (`agy`)** — same pattern as Codex: foreground
  `... wait -As agy -TimeoutSec 240 -PollSec 5`, re-run on exit 2. (agy 1.1.1
  exposes no background-task facility; if a future version does, prefer the
  Claude Code pattern.)
- `-TimeoutSec 0` = non-blocking single check; useful to drain the inbox
  before sending.

## Human's view

The user drives both panes and can inject instructions into either agent at
any time. For a live transcript, a third pane can run `pair watch`
(read-only dashboard: status, roles, turn, message stream, undelivered
flags). `pair status` and `pair log` give point-in-time views.
