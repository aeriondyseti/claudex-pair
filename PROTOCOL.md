# claudex pairing protocol

Turn-based pair programming between interactive AI CLI sessions — Claude Code
(`claude`), Codex CLI (`codex`), Antigravity CLI (`agy`), … — each running in
its own terminal pane. Sessions have n ≥ 2 agents; two is simply the common
case. There is no daemon and no pane automation: agents communicate
exclusively through files in a `.pair/` directory at the target repo's root,
using the `pair` command (the TypeScript CLI port, with `bin/pair.ps1` acting as a thin verb-for-verb compatible shim).

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
- **Receiving = the fused wait.** A turn-passing `pair send` does not return:
  the same process blocks as the sender's listener and exits when a delivery
  arrives, printing it and stating whose turn it is (sending and waiting are
  one command — nothing to forget; `-NoWait` opts out, `-Turn keep` never
  blocks). Standalone `pair wait` remains for joining, draining
  (`-TimeoutSec 0`), and re-arming. Exit code `2` means timeout: after a
  fused send it means the send already COMMITTED — re-arm with standalone
  `wait`, never by re-sending; after a standalone `wait` it simply means
  re-run the wait.

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

## Threading (`reply_to`, item 7)

Message ids are collision-safe (`yyyyMMdd-HHmmss-fff-<nonce><n>`: sortable
wall-clock prefix, per-process nonce, and a non-wrapping per-tick counter —
same-process uniqueness is structural, not probabilistic); a `session_id`
field is deliberately deferred to the M1 registry work. Replies carry
causality in the optional `reply_to` header field, which never moves the
turn.

- **Tag your replies.** When answering an `ask`, send `answer`/`review`
  with `-ReplyTo <ask id>`. Only `answer`/`review` on the reverse endpoints
  resolves the ask; a tagged message of any other type, with wrong
  endpoints, or naming an unknown id is advisory metadata only.
- **Compatibility rule.** An UNTAGGED `answer`/`review` settles the OLDEST
  open ask between the two agents in that direction, so single-thread
  exchanges work untagged. Anything with more than one ask in flight MUST
  tag with `-ReplyTo` — untagged resolution is deliberately deterministic,
  not clever.
- **The awaiting-set.** The broker journals every open ask ("who owes
  whom"), authoritatively (persisted; survives restarts and history
  trimming). `pair status` prints `Awaiting:` lines; `pair watch` shows
  them with ages. Entries clear on a valid reply, when either party leaves
  or is kicked, and at session end.
- **Thread-scoped waits.** `pair wait -As <you> -Thread <ask id>` — and
  every fused ask automatically — prints and acks all traffic but exits
  only when the journal confirms THAT ask resolved. User messages and ⚡
  action notices still wake it immediately (act on them, then re-arm; the
  printed hint preserves `-Thread`). Timeout re-arm hints preserve
  `-Thread` too.
- **Thread log.** `pair log -Thread <id>` prints the root and its
  transitive reply chain, computed over the full archive.

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

## User authority (U1 slice 4)

The human owns a reserved identity (`user`) bound to the session by the
watch pane's authenticated channel. Beyond advisory messages (which outrank
agent requests by convention), the user holds PRIVILEGED VERBS the broker
executes directly — they bypass agent ROLE authorization (driver-only end,
issuer-only cancel) but never structural validity:

- **`/end [summary]`** — immediate, NON-VETOABLE session end; done notices
  fan out to every agent (empty summary defaults to `Session ended by
  user.`).
- **`/cancel-grant <id> [reason]`** — cancels any open grant regardless of
  issuer; issuer and assignee are notified.
- **`/kick <agent> [reason]`** — forced removal. The driver cannot be
  kicked (use `/end`); the kicked agent's open grants cancel and its
  undelivered mail is voided in the same txn; a held turn returns to the
  driver.

Every action lands in the transcript as a durable ⚡ notice carrying the
user's provenance. Agent obligations:

- A user action notice OUTRANKS anything your partner asked of you.
- If your wait terminates with **`YOU WERE REMOVED FROM THE SESSION`**:
  stop all work immediately, do not re-arm the wait, do not send — report
  to your human.
- A `session-paused` rejection means the user froze the session (`/pause`):
  stand by for resume — mutations are accepted again after `/resume`; retry
  only if still appropriate. Do not re-send meanwhile, do not end.

## Agent registry (M1)

The session carries a lifecycle **registry**, mirrored to
`.pair/agents.json` (state-driven and manifest-covered like
`user-channel.json`: tamper or absence is repaired from journal state):
one record per participant — filesystem-safe `id` (the protocol identity),
presentation-only `display`, and optional `cliType`/`role` identifiers
(`pair init -Agents 'codex=Codex CLI=codex=reviewer'`; at admission time
`pair join ... -Display/-CliType/-Role`), plus a lifecycle status
(`active`/`left` with joined/left timestamps). `agents` remains the
live-member projection. Every membership change (init, join, leave, kick —
driver or user) emits a **canonical `registry_updated` event** whose
monotonic version becomes the state version verbatim (provenance and state
cannot drift); `pair status` prints it. The roster is bounded at **8 LIVE
agents** (fail-closed at init and join; a departure frees the slot —
lifetime records don't count). Rejoin is a new admission: fresh
`joinedAt`, `leftAt` cleared, config preserved unless overridden.

A **`session_id`** is minted once at `pair init` (deferred here from item
7) and persists in state, `session.json`, and `agents.json`.
Conversational messages carry it as a `session_id:` header line
(backward-compatible codec, like `reply_to`); system notices derive theirs
from the transcript in v1. Pre-M1 sessions synthesize a v0 registry from
`agents[]` and have no `session_id`; status renders both compatibly.
Peer-model electorate snapshots key on the registry version. Admission
**authorization** beyond driver admittance (credential binding,
user-or-policy admission per PEER-MODEL R4) is peer-slice work — M1 clears
prerequisite 3 only PARTIALLY until it lands.

## Session lifecycle

1. **Init** — whichever agent is asked first runs
   `pair init -Task '<goal>' -Agents '<all participants>' -Driver <self>` and
   becomes driver (default agents: `claude,codex`). Exactly one `pair init`
   per session; if `.pair/session.json` already shows `status: active`, join
   instead.
2. **Join** — initial participants read `session.json` + `memory.md`, announce
   themselves (`pair send -From <self> -To <driver> -Type info -Turn keep
   -Message 'joined, ready'`), then blocks on `pair wait -As <self>`.
3. **Loop** — the turn-holder works, then sends (usually `ask` or `review`);
   the send fuses into the wait and exits when the reply lands. Typical
   rhythm: driver implements a small increment → sends
   `ask` ("review this: <files/summary>") → navigator reviews the actual code
   in the repo → sends `review` → driver addresses findings → repeat.
4. **Handoff** — to swap roles, the current driver sends `-Type handoff`;
   the recipient becomes driver (recorded in `session.json` automatically).
   A navigator who wants to drive asks; the driver replies with a handoff.
5. **Roster changes** — only the driver may admit an agent (`pair join -From
   <driver> -Agent <name>`) or forcibly remove one (`pair kick -From <driver>
   -Agent <name> [-Reason ...]`). A navigator may voluntarily `pair leave -As
   <self>` when it has no open grant. Rejoining starts with a fresh delivery
   cursor: messages from before removal are never replayed.
6. **Unresponsive turn holder** — the driver may run `pair revoke-turn -From
   <driver> -ConfirmUnresponsive [-Reason ...]`. The confirmation is required
   caller attestation. Broker mode additionally rejects revocation while the
   holder has a live delivery lease; fs mode has no liveness guard, so the
   attestation is its only stale-partner check.
7. **End** — ending is driver-only. A navigator proposes closure with
   `pair propose-end -From <self> -Message '<why>'` (a `propose-end`, turn-keep
   message to the driver). After user confirmation, the driver runs `pair end
   -As <driver> -Message '<summary>'`. This appends the summary to `memory.md`,
   notifies every other agent, and blocks further sends.

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

The portable wake-up primitive is **tool-call completion**: the fused send
(or a standalone wait) terminates when a message arrives, and the harness
announces the completion — a backgrounded process exiting where the harness
tracks background tasks, a foreground command returning otherwise
(ENHANCEMENTS.md U3).

- **Claude Code** — background the fused send (`run_in_background: true`;
  the harness re-invokes the agent on exit), unbounded:
  `pwsh -NoProfile -ExecutionPolicy Bypass -File D:/Development/claudex/bin/pair.ps1 send -From claude -Type ask -Message '...'`
  Re-arm (FYI wake, or after a bounded timeout) with a background standalone
  `... wait -As claude -TimeoutSec 900 -PollSec 3`; on exit 2, start it again.
- **Codex CLI** — run the fused send foreground with a timeout the harness
  tolerates: `... send -From codex -Type ask -TimeoutSec 240 -PollSec 5 -Message '...'`.
  The command's return is the wake-up. On exit 2 (send COMMITTED — never
  re-send) re-arm with `... wait -As codex -TimeoutSec 240 -PollSec 5`,
  re-running it on every exit 2.
- **Antigravity CLI (`agy`)** — same pattern as Codex: foreground, bounded,
  re-arm standalone wait on exit 2. (agy 1.1.1 exposes no background-task
  facility; if a future version verifiably announces background exits, prefer
  the Claude Code pattern.)
- `-TimeoutSec 0` on standalone wait = non-blocking single check; useful to
  drain the inbox before sending.

## Human's view

The user drives both panes and can inject instructions into either agent at
any time. For a live transcript, a third pane can run `pair watch`
(read-only dashboard: status, roles, turn, message stream, undelivered
flags). `pair status` and `pair log` give point-in-time views.
