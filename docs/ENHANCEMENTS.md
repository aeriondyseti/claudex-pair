# claudex enhancement proposal

Joint output of a claude/codex pairing session (2026-07-12). Inputs: a survey of
prior art online and a code/spec review of `bin/pair.ps1` + `PROTOCOL.md`.

Prior art surveyed: [SeemSeam/claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge)
(referred to below as **SeemSeam ccb** — the project claudex was originally inspired by),
[cx994/ccb](https://github.com/cx994/ccb) (a distinct project, referred to as **cx994 CCB**),
[Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams),
[aider architect/editor mode](https://aider.chat/2024/09/26/architect.html),
[zen-mcp-server](https://github.com/BeehiveInnovations/zen-mcp-server),
[mob.sh](https://mob.sh/), [claude-squad](https://github.com/smtg-ai/claude-squad),
[TandemKit](https://fline.dev/blog/tandemkit-pair-programming-for-ai-agents/),
[claude_code_agent_farm](https://github.com/Dicklesworthstone/claude_code_agent_farm),
[Tmux-Orchestrator](https://github.com/Jedward23/Tmux-Orchestrator),
[AutoGen](https://microsoft.github.io/autogen/0.2/docs/tutorial/chat-termination/),
[OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/),
[Vibe Kanban](https://github.com/BloopAI/vibe-kanban).
Where an idea is credited to a source it is *inspired by* that source's design,
not a claim of identical mechanics.

**Constraints (revised twice by the user during this session).** The one hard
constraint is that the human controls the visual form: they own the terminals, and
claudex never imposes a UI or automates panes. Everything else moved: multi-agent
generalization is now an explicit goal (see the section before P3), and a **broker
daemon is now part of the required architecture** (user-confirmed) — see
Coordination architecture below. Durable `.pair/` files remain the recoverable
source of truth, but are written by the broker, not by competing CLI processes.

## Coordination architecture: the broker

A lightweight per-repo broker process is the **required coordination runtime**,
auto-started by the CLI and self-terminating when idle. Design rules (from codex's
review, user-approved):

- **Single writer / transaction coordinator.** The broker owns all mutations of
  session state, grants, routing, message claims, broadcast fan-out, heartbeats,
  and subscriptions. CLIs talk to it over a local IPC endpoint and never mutate
  `.pair/` directly.
- **IPC authentication and scoping.** OS-level pipe ACL / connecting-process
  identity check, plus a per-session unguessable capability token stored with
  user-only permissions; requests validate repo/session binding so a client of one
  repo's broker cannot confused-deputy another's.
- **Durable before acknowledged.** The journal is an append-only WAL with framed,
  checksummed records, flushed before the client is acked; compaction is by atomic
  snapshot replacement (not temp+rename of an ever-growing file). Recovery truncates
  only an invalid tail and replays committed records; the broker reconstructs its
  entire state from disk. Files stay human-readable and replayable.
- **Lifecycle.** The CLI discovers a running version-compatible broker or atomically
  starts one: single-instance lease (file lock used *only* for broker
  election/recovery protection), readiness handshake, clean idle shutdown. **Idle**
  means: no connected clients, no in-flight transaction, and no outstanding unacked
  delivery or work lease, sustained through a grace timeout — an active durable
  session alone does not keep the broker alive, because restart is transparent.
  A crashed broker is restarted and recovers journaled state; during recovery,
  commands fail loudly rather than falling back to competing direct writers.
- **Client reconnection.** Clients (e.g. a blocked `pair wait`) survive broker
  crash/restart via a reconnect loop with bounded backoff and a resumption
  handshake carrying `session_id`, `client_id`, last-acked event/message sequence,
  and broker epoch/version; subscription replay is idempotent.
- **External mutation = tamper, not input.** Human-readable does not mean
  externally writable: the broker detects journal/head mismatch caused by direct
  edits to `.pair/`, quarantines the mutation or enters a read-only conflict state,
  and requires explicit reconciliation via `pair doctor` — never an automatic
  silent reload.
- **Events accelerate, files decide.** FileSystemWatcher (or any event source) may
  wake the broker or clients but is notification-only — events can drop; correctness
  never depends on them.
- **Diagnostics stay file-native but honest about staleness.** Read-only commands
  (`status`, `log`, `doctor`, `watch`) may read `.pair/` directly without the
  broker — a diagnostic mode, not a mutation fallback. The broker's answer is
  authoritative when it is running; direct-file reads report the journal
  head/epoch they saw and may lag it.
- **Coordination ≠ workspace safety.** The broker serializes protocol state; it
  cannot prevent git/file conflicts between concurrent writers — M4's
  worktree-isolation / serialized-edit-grant policy remains required.

## P0 — protocol correctness (fix before adding features)

1. **Specify the session state machine; the broker serializes it** *(code review)*
   `Send-PairMessage` renames the message into the inbox *before* the read-modify-write
   session save, so a receiver can consume a message before the turn flips, and a crash
   mid-send leaves inconsistent state. Reordering the writes only reverses the
   inconsistency. The fix: specify the state machine (states, transitions, who may
   trigger each), then run **all** mutations — send, claim, end — through the
   broker's serialized transaction path with a durable commit journal (see
   Coordination architecture). Cross-process file locking survives only for broker
   election/recovery protection, not as the general mutation mechanism.

2. **Enforce turn/role invariants in `pair send`** *(code review)*
   Today either agent may send a turn-passing message regardless of `session.turn`,
   a navigator can send `handoff`, and `-From x -To x` is accepted. Validate:
   turn-passing sends require sender == turn holder; `handoff` requires sender == driver;
   recipient must be `Other(sender)`; session-ending commands — `pair end` and the
   raw `send -Type done` parity path — require sender == driver (item 11's
   close-authority rule).

3. **Re-init isolation / session rotation** *(code review; claude-squad; cx994 CCB)*
   A new `pair init` over a completed session silently inherits the old `memory.md`,
   archive, and any stale inbox files, contaminating the next task. Give each session
   an id; on re-init rotate prior state to `.pair/history/<session-id>/`. This also
   creates the substrate for deliberate history/resume UX later. Rotation must move
   only per-session state — `.pair/conventions.md` (item 19) and `.pair/history/`
   itself are durable and stay in place. Rotation and session-id assignment run
   inside the broker's serialized transaction path: two simultaneous `pair init`
   calls must not race (the broker's single-instance lease alone does not cover this).

4. **Harden `Save-Session`** *(code review)*
   Fixed `session.json.tmp` name collides under concurrency; use unique temp names
   on the broker-serialized commit path (the only file lock is the broker
   election/recovery lease), validate the schema on load, and keep a rolling backup.

5. **Delivery semantics in `pair wait`: lease / ack / redelivery** *(code review)*
   Duplicate consumption (two waiters under the same identity — e.g. a re-armed
   background wait racing a manual one) is solved by broker delivery semantics, not
   filesystem claim races: the broker leases a message to one waiter, requires an
   ack, and redelivers on lease expiry if the waiter crashed before acting.
   Delivery is therefore **at-least-once** — an ack lost after the agent already
   acted causes redelivery — so messages and actions carry ids and the broker
   deduplicates/idempotently applies them; this matters more than the numeric lease
   default. Leases support heartbeat/extension with configurable defaults so a long
   review doesn't expire mid-read. Separately, wait should distinguish FYI
   (`turn: keep`) messages from the turn-granting message when reporting whose
   turn it is.

6. **Input validation and future-proof header serialization** *(code review)*
   Reject `PollSec <= 0` and negative `TimeoutSec`/`Tail`. Header injection is *not*
   currently exploitable (the body is written after the closing `---` delimiter and
   header values are generated or enum-constrained), but serialization should be
   hardened now as future-proofing before headers grow free-form fields
   (`reply_to`, task labels, correlation metadata).

Testing for this tier is not a separate milestone: each P0 slice lands with
failure/concurrency Pester tests written first or alongside (crash-mid-send,
concurrent send/send and send/wait, re-init over live state, lease duplication,
ack loss, lease expiry/redelivery, broker-crash recovery, end races).

## P1 — reliability and visibility

7. **Message identity and threading** *(code review; inspired by zen-mcp-server's
   continuation threads)*
   Millisecond timestamp ids can collide; replies carry no causality. Add `session_id`,
   unique message ids (sequence or UUID), and `reply_to` on `answer`/`review`.
   Enables `pair log -Thread <id>` and unambiguous multi-ask exchanges. (UX-level
   value, so P1 — but ids/`reply_to` should ride on the P0 header work.)

8. **Listener liveness + progress staleness** *(claude_code_agent_farm heartbeats;
   inspired by SeemSeam ccb's no-progress-based timeouts)*
   Three distinct signals, not one: **broker-process liveness** (lease/readiness),
   **client-listener liveness** (the broker observes each agent's IPC connection or
   lease heartbeat — no heartbeat files needed), and **agent progress** (derived from
   state/message activity timestamps). `pair status`/`watch` show all three (listener
   age, last-activity age, pending-message age) with a stalled warning. `pair ping`
   *(cx994 CCB)* is a liveness probe answered by the partner on its next wait —
   useful, but only a true round trip when the partner actively replies.

8a. **Driver-side turn revocation on navigator timeout** *(user request,
    2026-07-12 — pulled into current scope; the action on item 8's signals)*
    When the driver has passed the turn (asked a question, requested a review) and
    the navigator produces no reply within a configurable timeout, the driver may
    revoke the turn and continue instead of blocking indefinitely on a dead or
    wedged partner. Design constraints:
    - **Revocation is a broker-executed privileged action**, not an ordinary send —
      a deliberate, journaled exception to item 2's "turn-passing requires sender ==
      turn holder" invariant, available only to the driver (in M3 terms: the
      control-authority holder revoking a grant it issued). Like every mutation it
      is a `decide`-authorized envelope through the single-writer commit path; the
      broker contributes the liveness facts the pure core cannot know.
    - **Timeout must distinguish "gone" from "still working."** It keys off item 8's
      liveness signals: an active lease heartbeat (item 5) defers revocation, so a
      navigator mid-way through a long review is not robbed of the turn; only a
      missing listener or stalled progress starts the clock.
    - **No silent turn theft.** `pair status`/`watch` surface the pending timeout
      before it fires; the revocation lands as an explicit `turn_revoked` record in
      the navigator's inbox and the archive. A late reply from the revoked navigator
      is recognized as stale (message ids / `reply_to` from item 7, grant epoch) and
      is archived as advisory rather than mutating turn state.
    - Configurable per-session timeout with a conservative default; disabled means
      today's behavior (wait forever).
    See BROKER-SPEC.md "Turn revocation" for the wire/serialization contract and
    failure cases (F15/F16).

9. **`pair doctor`** *(code review)*
   Detect and repair orphaned turn-passing messages, stale turns, claimed-but-orphaned
   messages, leftover temp files, malformed session.json.

10. **Context revival via partner** *(inspired by zen-mcp-server's context-revival
    behavior)*
    `pair send -Type rehydrate`: after a context compaction/restart, the compacted
    agent asks; the partner answers with a distilled state-of-session from its intact
    context plus `memory.md`. The reply follows a structured schema — session/grant
    state, decisions, open questions, files/commits touched, provenance and
    timestamps — and the receiving agent treats the partner's prose as
    untrusted/advisory, re-verifying anything load-bearing against the repo.
    Cheapest fix for the biggest failure mode of two long-running interactive
    sessions.

11. **Close authority: driver-only end, cooperative close, navigator leave/rejoin**
    *(Agent Teams; driver-only end and leave/rejoin are user rules, 2026-07-12 —
    pulled into current scope)*
    Three related verbs with distinct authority:
    - **`pair end` is driver-only.** Ending the session kicks every participant,
      so only the driver may do it. The same restriction covers the raw
      `send -Type done` parity path — today *any* participant's done-send
      completes the session (`src/core/decide.ts`); under this rule a navigator
      done-send is rejected (`end-not-driver`), not silently demoted to a plain
      message. A *user-authorized* end stays immediate and non-vetoable — the
      user outranks both agents — executed as a privileged user-channel action
      per U1.
    - **Agent-proposed close** ("I think we're done") remains a request any
      participant may make (`pair propose-end`, rejectable with a reason); the
      driver decides and executes the actual end.
    - **Navigator leave / join / kick — roster mutations** *(user rule: join/leave
      changes the roster, not a presence flag)*. `pair leave` removes the
      navigator from the roster; `pair join` re-admits it. **Roster authority is
      the driver's, uniformly — one rule, no initial-vs-later special case**
      *(user rule)*: `pair init` must be issued as the agent that becomes driver
      (it declares the initial roster — today `decide` doesn't check this;
      `init-not-driver` guard added), and every later join is driver-admitted.
      Rules:
      - **Voluntary leave is blocked while the agent holds an offered/active
        grant** (`leave-with-grant`): finish it (`grant-done`) or have the driver
        cancel it first. Leaving while holding the turn returns the turn to the
        driver in the same transaction.
      - **Kick (`pair kick`, driver-only) is the forced removal.** The kicked
        agent's open grants are cancelled in the same transaction and reassigned
        by the driver — reissue to a new assignee; a `grant-reassign`
        convenience may wrap cancel+issue.
      - **Undelivered deliveries for a removed agent are voided to the archive**,
        never queued for a possible return — a rejoining agent is a fresh roster
        entry that catches up via item 10's rehydrate, not via stale redelivery.
      - The driver can neither leave nor be kicked; handoff first.
      - The roster may shrink to the driver alone — valid protocol state, because
        leave-to-reset-and-rejoin is a supported recovery flow for a
        malfunctioning agent. But **kicking the last navigator prompts the driver
        to end the session** (CLI-level advice, not a `decide` invariant) unless
        the driver is waiting for a return; init's ≥2-agent rule applies only at
        creation.
      This pulls the pair-scope slice of M1's add/remove rules forward; M1 keeps
      the N-agent generalization (registry versioning, `registry_updated`,
      bounded roster).
    See BROKER-SPEC.md "Session end & roster lifecycle" (F17–F22). PROTOCOL.md's
    End step ("one agent runs `pair end`") gets the driver-only wording when the
    guard lands in `decide`.

## P2 — workflow features (better pairing, not just safer)

12. **Structured handoff template** *(OpenAI Agents SDK handoffs; mob.sh)*
    `handoff` bodies carry done / next / open-questions / files-touched sections;
    `pair send -Type handoff` scaffolds or rejects free-form bodies. A role swap
    should never be a context lottery.

13. **Review gate with anchored findings** *(Vibe Kanban; claude-squad)*
    `review` messages use a findings format: severity + `path:line` + verdict
    (approve / request-changes). Driver must address or dispute each finding.

14. **Convergence tracking for disagreements** *(TandemKit)*
    Findings tagged severity (HIGH/MED/LOW) × agreement (agreed/partial/disputed);
    escalate to the human when a HIGH/MED finding is still disputed after **two**
    rounds — matching the protocol's existing "disagreed twice → stop" rule, now
    tracked as visible state instead of convention.

15. **Plan-approval gate mode** *(Agent Teams; aider architect/editor)*
    `pair init -Mode plan-gate`: the driver posts a plan and gets navigator approval
    (or rejection with feedback) before touching files.

16. **Git-aware review requests** *(code review)*
    Review asks carry base/head/worktree metadata so the navigator knows exactly what
    to review — not diff payloads; messages stay pointers.

17. **WIP-branch checkpointing — separate opt-in proposal** *(mob.sh)*
    `pair next` auto-committing to a `pair/<base>` branch on each handoff, squashed by
    `pair end`, would make every turn a checkpoint — but it mutates the user's worktree
    and branch state, a materially bigger blast radius than anything else here. Keep it
    a separate opt-in design (`-Mode wip-branch`), off by default, decided with the user.

18. **Independent-investigation mode** *(TandemKit)*
    `pair init -Mode independent`: inboxes sealed until both agents post findings
    files, then normal flow — anti-anchoring for reviews and debugging.

19. **Durable conventions file, separate from session memory** *(inspired by SeemSeam
    ccb's shared memory doc; AutoGen summary_method)*
    `memory.md` is per-session and rotates with item 3. Reusable learnings
    ("conventions agreed", "what worked") go to a durable `.pair/conventions.md`
    that survives rotation and is seeded into the next session's memory. `pair end`
    prompts both agents for entries.

20. **Turn limits / runaway protection** *(AutoGen)*
    `max_turns` + counter in session.json; status/watch display it; wait warns past
    the cap so a ping-pong can't run away unnoticed.

## Multi-agent generalization (user-requested direction)

> **Direction update (2026-07-20):** the flagship parallelism direction is now the
> **peer model** — see [PEER-MODEL.md](PEER-MODEL.md) (rev 2.2, review-converged
> 2026-07-20: claude drafted, codex blind-reviewed and approved after three
> adversarial rounds — 10 blind findings, 8 round-2, 4 round-3). It supersedes
> M3's *leader-follower* preset (single-model-in-charge is the shape being moved
> away from); M1/M4/M5 remain load-bearing as its prerequisites, M3's `pair`,
> `round-robin`, and `adversarial` mechanics survive (the adversarial barrier
> becomes the peer model's planning opener).

The user has asked for this explicitly: arbitrary agent count, per-agent roles, and
support for known collaboration topologies. This is a **protocol evolution**, not a
widening of `ValidateSet('claude','codex')`. The central design move (from codex's
feasibility review): separate **control authority** from **work grants** — a single
global turn token cannot model leader-follower, where several followers legitimately
work at once. The required broker (see Coordination architecture) is what makes this
tractable: it manages concurrent logical grants, phase barriers, routing, and
delivery natively, where pure file locking would strain. Workspace safety (M4) is
unchanged — coordination serialization does not prevent git/file conflicts.

M1. **Agent registry with lifecycle** *(SeemSeam ccb's per-agent config)*
    `.pair/agents.json`: each participant gets a unique filesystem-safe id (distinct
    from its display name), CLI type (claude, codex, gemini, …), role, status
    (active / joined / left), and inbox. `-From`/`-To`/`-As` validate against the
    registry instead of a hardcoded enum. Define add/remove rules and what happens
    to an agent's pending grants and undelivered messages when it leaves — item 11
    now defines the pair-scope answers (grant-guarded voluntary leave, driver kick
    with grant reassignment, voided deliveries); M1 generalizes them. Registry
    changes carry a monotonically increasing registry version and emit a
    `registry_updated` event to subscribed clients. v1 sets a bounded practical
    limit (registry-defined N, not implied unbounded scaling). Two-agent sessions
    stay the zero-config default (`pair init` unchanged).

M2. **Per-agent roles — enforced vs advisory, stated honestly** *(SeemSeam ccb role
    packs; cx994 CCB's role charter; aider architect/editor)*
    A role = named responsibilities + constraints declared in the registry. Two
    distinct classes: **enforced capabilities** — which message types and grant
    actions an agent may perform, authorized by the broker (the CLI may preflight,
    but the broker is authoritative) — and **advisory
    behavioral constraints** — e.g. "reviewer never edits files", which `pair.ps1`
    cannot detect and which remain instruction-text discipline unless backed by
    worktree permissions or harness support. Ship a small built-in set (driver,
    navigator/reviewer, architect, tester) plus free-form labels; role text is
    injected into each agent's joining instructions.

M3. **Grant model + topology presets** — a topology defines *authorization over
    actions and grant cardinality*, not merely whose name is in a turn field:
    - **Work grant**: `grant_id`, assignee, scope, state, `reply_to`. A follower may
      act only within its active grant and cannot pass a global turn it never held.
    - **pair** (today's default) and **round-robin / mob** *(mob.sh)*: at most one
      active grant; the existing `turn` field is exactly that grant's projection.
      Round-robin cycles it through the registry in order.
    - **leader-follower** *(Tmux-Orchestrator hub-and-spoke; Agent Teams)*: the
      leader holds control-plane authority permanently and issues zero or more
      concurrent work grants; followers reply only to their grant and do not message
      each other. `handoff` does not exist here — the verbs are grant / reassign /
      delegate. (`handoff` is a pair/round-robin verb, not universal.)
    - **adversarial** *(TandemKit; cross-provider review practice)*: a phase/barrier
      state machine — `collecting → reveal → converge → resolved` — not merely sealed
      inboxes; findings converge via item 14's severity × agreement tracking. The
      arbiter may be an agent or **the human, represented as a resolution role in
      session state, not as a fake agent inbox**.
    Declared at `pair init -Topology <name>`; send-time invariants (item 2) become
    authorization checks against the topology's permitted actions.

M4. **Execution safety for concurrent writers** *(claude-squad's worktree isolation)*
    Concurrent followers sharing one worktree is unsafe. Explicit v1 policy per
    grant: read-only grants (research, review) may run concurrently; **concurrent
    writer grants require an isolated git worktree/branch; otherwise edit grants are
    serialized.** "Mechanically enforced disjoint file scopes" are deferred until a
    sandbox/harness can actually enforce them — claudex must not claim enforcement
    it cannot deliver. If claudex claims worktree enforcement, the broker
    provisions and tracks worktree ownership per grant.

M5. **Routing and broadcast with delivery semantics** *(SeemSeam ccb's broadcast)*
    With N > 2, `-To` becomes required (no more `Other($from)` default). Broadcast is
    a single event with per-recipient delivery/ack state (or all-or-none enqueue) —
    N independent sends can partially succeed and must not masquerade as a broadcast.
    Watch/status/log grow per-agent columns and colors.

M6. **Sequencing constraint**: parameterize the P0 spec over **topology capabilities,
    permitted actions, and grant cardinality** — not topology names. Implement pair
    first, keeping `turn` as a compatibility projection of the single-grant case; add
    leader-follower only after grant and workspace-isolation semantics (M3, M4) are
    specified. README's "trivially extensible" claim gets replaced by a pointer to
    this design.

## User-requested additions (late in session)

U1. **Interactive `watch`: a first-class user channel with honest provenance**
    *(user request; extends the Agent Teams trust rule)*
    Implementation handoff: [TUI-UPGRADE-NOTES.md](TUI-UPGRADE-NOTES.md).
    `pair watch` grows an input line: alongside the live transcript, the human can
    send instructions into the session as the reserved identity **`user`** — to one
    agent or broadcast. This closes the gap where a relayed "my user said X" is
    unverifiable (the exact scenario that forced a mid-session confirmation round
    in this very review) — but its trust boundary must be stated accurately, not
    overclaimed:
    - **Provenance label is `trusted_user_client`, not "guaranteed human-typed."**
      Agents run arbitrary shell as the same OS user; binding IPC identity proves
      which *client* authored a message, not who typed it. Guaranteed human origin
      would require an out-of-band trust boundary the design does not pretend to have.
    - **Separate credentials**: each agent gets its own credential and the user
      channel gets a distinct one — never a shared capability. The user credential
      lives outside agent-readable repo/env state (OS credential store, or a
      separately launched trusted-UI boundary), so impersonating watch requires
      more than reading `.pair/`.
    - **Authority-changing directives get interactive confirmation** in the watch
      TUI (or an equivalent signature step); where feasible, piped/scripted stdin
      does not silently receive human authority.
    - **Precedence semantics are explicit, not prose-implied.** A user message never
      implicitly mutates protocol state. Directing text is advisory-until-acknowledged
      (message ids + per-recipient ack); state changes go through explicit privileged
      commands — cancel-grant, pause, resume, end — executed by the broker as
      user-channel actions. User `end` in particular is a privileged broker action,
      not an ordinary message. Advisory user messages default to `turn: keep` and
      outrank agent messages per the existing protocol rule.
    - The `user` identity lives outside the agent registry: it cannot hold grants,
      take turns, or be a handoff target. All user messages land in the archive, so
      the transcript shows exactly what the human injected and when.

U2. **Antigravity CLI (`agy`) as a supported adapter** *(user request)*
    Add Google's Antigravity CLI as a supported **cli_type** — an adapter, distinct
    from participant identity: registry ids stay arbitrary, and an agy-backed agent
    can be any participant in any topology, not inherently "the third agent."
    Deliverables: the `agy` adapter (credential handling, wait/reconnect behavior,
    capability discovery), an `instructions/agy-pairing.md` operating guide, a
    `/pair` entry point appropriate to its harness, and a PROTOCOL.md
    waiting-mechanics entry. Interaction details — slash-command syntax, foreground
    vs background waiting, timeout tolerance — must be **verified against the
    installed Antigravity harness/version, not assumed** from how Claude Code and
    Codex CLI behave. Acceptance: a defined three-participant test topology
    (e.g. leader-follower with claude leading, codex + agy as followers) passing
    end-to-end. Beyond its own utility, agy is the forcing function for M1–M6 —
    the first heterogeneous CLI exercising the registry, roles, and three-agent
    topologies for real.

U3. **Fused send+wait — push delivery via process exit** *(user request,
    2026-07-14; supersedes the hook-centric sketch discussed the same day)*
    The observed #1 operational failure: an agent sends a turn-passing message
    and forgets to run `pair wait`, so replies rot in the inbox and the session
    stalls. No broker-side push can fix this — an idle CLI agent's loop only
    runs when a tool result returns or the harness injects input — so the push
    must terminate in a harness facility. The portable primitive every
    harness has is **tool-call completion**: a backgrounded process exiting
    where the harness tracks background tasks (Claude Code), a foreground
    command returning everywhere else (Codex, agy). Therefore the process IS
    the subscription:
    - **Mechanism.** A turn-passing `pair send` (`ask`/`answer`/`review`/
      `handoff`) does not return after commit; the same process rolls straight
      into the wait loop as the sender's listener and **exits when a delivery
      arrives**. The reply's arrival is what terminates the process; the
      harness announces the completion. Send + block + deliver = one process.
    - **Exit contract** (same as today's `wait`): exit 0 = delivery received
      and printed (act on it), exit 2 = timeout, other nonzero = error.
      **Timeout ≠ send failure**: a timed-out fused send has already
      committed, so exit-2 output must lead with `SEND ALREADY COMMITTED — do
      NOT re-send` and direct the agent to re-arm with **standalone
      `pair wait`**, never by re-running the send (a naive retry would
      duplicate the message — file mode mints a fresh messageId on every
      send). The fused wait is **unbounded by default**; `-TimeoutSec` exists
      for harnesses that need bounded foreground calls. A CLI test pins this
      boundary. Output always states whose turn it is: an FYI (`turn: keep`)
      wakes the process without granting the turn — the wake event and the
      right-to-act are deliberately decoupled, and the output is where that
      distinction lives.
    - **Blocking follows the turn token.** Auto-wait only when the send passes
      the turn — passing the turn means "I am now blocked on you," so blocking
      is the honest default. `-Turn keep` sends return immediately (the sender
      intends to keep working); `-NoWait` opts out explicitly. `done`/end
      sends return immediately. Standalone `pair wait` remains for
      join/recovery and re-arming.
    - **What fusing actually buys.** Correctness is NOT the claim: the durable
      inbox (file mode) and the delivery ledger (broker mode) mean a fast
      reply landing between send and wait was never lost — it sat in the
      inbox; the failure was that nobody came back for it. Fusing closes the
      *agent liveness* gap: a successful send proceeds directly into the
      subscription by control flow — the agent cannot forget the subscribe
      step, because it is not a step. (A brief transport interval between
      commit response and subscription registration remains and is safe —
      delivery is durable; an atomic broker execute+subscribe operation may
      additionally eliminate it, but zero-window registration is NOT part of
      the contract unless that atomicity is specced.) In broker mode the
      fused command holds one IPC connection and resumes its subscription
      from the client's last acked `deliverySeq` — commit seq is NOT a
      delivery cursor; BROKER-SPEC separates the two deliberately. The F14
      print+flush-before-ack client contract applies unchanged.
    - **Per-harness waiting mechanics** (PROTOCOL.md section gets rewritten
      when this lands): Claude Code backgrounds the fused command
      (`run_in_background`; harness re-invokes the agent on exit) — unbounded.
      Codex CLI runs it foreground with its tolerated timeout (~240s) — the
      command's *return* is the wake-up, and sending/waiting being
      inseparable leaves nothing to forget. agy: verify per U2's rule
      (foreground like Codex until its harness demonstrably announces
      background exits).
    - **Implementation shape.** The fuse is **CLI orchestration, not a merged
      use case**: `sendMessage` and `waitForMessages`
      (`src/app/usecases.ts`) stay independently testable; the CLI command
      layer (`src/apps/cli/main.ts`) calls send then rolls into the shared
      wait-rendering helper. The existing `ask` convenience (main.ts) already
      chains send+wait and must become a pure alias (set type, delegate once)
      or it would double-wait. Changing send's default to block is a breaking
      change for existing scripts/e2e expectations — the slice ships with a
      migration note and tests covering `-NoWait`, `-Turn keep`, and the
      timeout boundary.
    - **Residual gap: re-arming.** After exit 2 (timeout) or exit 0 on an FYI
      when the agent still lacks the turn, the agent must re-run **standalone
      wait** — still a remembering problem, now much smaller. Mitigations, in
      order: the output's final line is an explicit next-action
      (`NEXT: pair wait -As codex ...` — trailing instructions are what LLM
      agents most reliably follow); optional harness-level hardening where
      available — a Claude Code `Stop` hook (`pair hook stop`) that blocks
      going idle while the session is active with unread mail or no live
      listener (rides item 8's listener-liveness signal), and a Codex
      `notify`-hook adapter that alerts the *user* (toast + `watch`/`status`
      STALLED flag) since Codex hooks are one-way. Hooks are hardening, not
      the mechanism — the fused command must be sufficient on a bare harness.
    - Cross-refs: rides item 5's lease/ack/redelivery semantics and item 23's
      broker subscription channel; feeds item 8's listener liveness (a fused
      waiter is a live IPC connection the broker can observe).

## P3 — DX and extensibility

21. **JSON output and stable error codes** *(code review)*
    `-Json` on status/log/wait for programmatic wrappers; documented exit codes.

22. **Round-limited log** *(cx994 CCB)*
    `pair log -Rounds N` to re-read just the last N exchanges instead of the archive.

23. **Event-driven delivery — absorbed into the broker architecture** *(code review)*
    Originally "FileSystemWatcher wait with polling fallback" in this tier; the
    broker (P0, see Coordination architecture) now owns delivery and subscriptions,
    so near-instant wakeups come with it. FileSystemWatcher may wake the broker but
    is notification-only and never correctness-critical.

24. **Quality-gate hooks — tracked and trusted** *(Agent Teams hooks)*
    Optional `on-handoff` hook; nonzero exit blocks the turn flip and returns the
    script output as feedback ("tests failing — fix before handing off"). Hooks are
    *repo configuration*, so they live in a tracked location (e.g. `.claudex/hooks/`),
    not inside gitignored `.pair/`, and require explicit trust/approval before first
    execution (hooks run arbitrary code).

25. **Multi-agent generalization** — promoted to its own section above (M1–M6) at
    the user's request; see "Multi-agent generalization (user-requested direction)".

## Suggested sequencing

P0 lands as ordered slices, each test-first:

1. **Spec first**: write down the session state machine (states, transitions, who may
   trigger each) — including 8a's driver `revoke-turn` transition — the broker
   IPC/journal contract, and the recovery scheme; encode them in
   failure/concurrency Pester tests before touching `pair.ps1`.
2. **Broker + commit journal** (item 1 and Coordination architecture) with items 4
   and 6 riding along (same code path); election lock, readiness handshake, idle
   shutdown, crash recovery.
3. **Invariant enforcement** (item 2, now including driver-only end/done-send) and
   **session rotation** (item 3).
4. **Delivery semantics: lease/ack/redelivery** (item 5), with U3's fused
   send+wait riding the same slice — it is the subscribe channel's first
   consumer, and its file-mode fallback (send rolls into today's poll loop)
   can land even before the broker wiring.
5. Then P1 visibility (items 8, 9) — small, immediately useful — with 8a (turn
   revocation) riding item 8: the liveness signals and slice-4 lease semantics it
   depends on are already in place, so it lands as a `decide` transition plus a
   broker liveness guard, not new machinery. Item 11's roster verbs
   (leave/join/kick) land here too — they share the liveness/status surface.
6. Workflow features by demand, starting with 12 (structured handoff) and 13 (review
   gate), which encode what the instruction files already ask agents to do by convention.
