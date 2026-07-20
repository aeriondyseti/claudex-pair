# Peer model: phased, egalitarian parallel development

Status: **rev 2.2 — APPROVED / review-converged** (codex verdict
`20260720-100607-809`, 2026-07-20: passes F1–F10, R1–R8, C1–C4, all six
rulings, the F9 verification invariant, and the /pair+$pair entry-point
contract; three adversarial rounds total). Rev 1 authored by
claude (2026-07-20); blind-reviewed by codex the same day (verdict: approve
direction, reject implementation readiness; 10 blocking findings, all
accepted — session transcript 2026-07-20, ledger message
`20260720-094521-446`). Rev 2 incorporated every finding and all six
open-question rulings; rev 2.1 additionally resolves codex's round-2 findings
R1–R8 (`20260720-095647-013`), including the user-required entry-point
contract. Both changelogs at the end map finding → section. Supersedes M3's *leader-follower* topology
as the flagship parallelism direction in `ENHANCEMENTS.md`. The `pair`
(turn-based) and `round-robin` topologies survive unchanged; `adversarial`'s
phase barrier is absorbed here as a first-class primitive.

## Motivation and principle

The current protocol treats **the right to act** as the scarce resource: one
turn token, one driver who edits, everyone else waiting to review. That
serializes attention well for tight two-agent debugging, but it structurally
prevents N models from contributing as equals.

The peer model treats **integration** as the scarce resource instead. Every
peer is always free to think, message, and edit *its own workspace*;
coordination applies only where work meets:

1. the shared plan (what to build, in what order),
2. the claims board (who is building which piece),
3. the feature branch (what has been accepted).

One sentence of philosophy governs every mechanism below: **serialize when
deciding, parallelize when building.** The turn token is not deleted — it is
*scoped* to convergence work (planning, disputes), where round-robin turns are
the right tool. Claims own production work.

### The guarantee, stated honestly *(F10, narrowed further per R1)*

Peer topology guarantees exactly two things: **equal authority** (no agent
outranks another) and **bounded capture** (no peer can monopolize the board:
the WIP cap and review conscription are `decide`-enforced invariants). It
does **not** guarantee equal contribution, and it does **not** guarantee
non-idleness: if the board holds no task a given peer is eligible for —
production, review, or assist — honest idleness is the correct protocol
state, and `status`/`watch` report it as such (`no eligible work for
<peer>`), not as an error. Assist-class items and review conscription are
mechanisms that *widen* opportunity; they are not invariants that manufacture
work which the plan did not create.

## Session phase state machine

A peer-topology session adds a `phase` field to session state:

```
planning ──(vote passes)──► provisioning ──(branch saga journaled)──► implementation ──(exit criteria)──► ended
   ▲                                                                       │
   └──────────────────────(foundational-break vote)────────────────────────┘
```

- Phase transitions are `decide`-authorized events on the WAL like every
  other mutation; there is no side channel.
- `planning` uses the round-robin turn machinery. `implementation` has **no
  turn token at all** — authorization derives from claims and reviews.
- The human (reserved `user` identity, U1 channel) may force any transition
  as a privileged user-channel action, including ending from either phase.

## Phase 1 — Spec/Planning

### 1a. Blind proposal round

On session start (and on re-entry after a foundational break), the broker
opens a **sealed-submission barrier** — the `collecting → reveal` mechanism
specced for the adversarial topology, reused here:

- **Barrier membership and deadline snapshot at open** *(F4; ruling 3)*: the
  eligible-submitter set is the active roster at the moment the barrier
  opens, recorded in the barrier-open event. Peers joining after the open
  are **observers** until the next barrier or ballot; they do not submit,
  and they do not vote on this round's draft.
- Each eligible peer submits one full proposal:
  `pair propose -Phase planning -File <path>`. Proposals are held by the
  broker and **not delivered to anyone** until the barrier closes.
- The barrier closes when all eligible peers have submitted, or at the
  deadline. Deadline semantics *(ruling 3)*: the clock is armed at open;
  the **first submission starts a grace window** for the remainder, whichever
  bound is tighter. **No-show policy** *(F4)*: expiry with missing
  submissions pages the human, who rules each absentee as *abstain* (barrier
  proceeds without them; they remain observers for this round) or *wait*
  (deadline extended). Never a silent quorum shrink.
- On reveal, a broker-authored manifest wake is delivered to every active
  agent simultaneously; the authoritative proposal bodies are served by
  `pair artifacts` (the planning-artifacts query) and informational
  mirrors — the mailbox archive holds manifests, not bodies *(1B design
  correction: content-addressed reveal avoids N x N body duplication)*.
  Blindness is what buys independent designs instead of anchoring on
  whoever writes fastest.

Proposals are prose plus a candidate task decomposition (schema below —
non-binding at this stage, but writing it early surfaces decomposition
disagreements while they are cheap).

### 1b. Round-robin convergence

After reveal, the turn token cycles the *barrier-snapshot* roster in registry
order. The starting peer **rotates each round** so no one structurally gets
the last word. On your turn you may, in any combination:

- amend the living draft (`.pair/phases/planning/draft.md` — broker-owned,
  written only by the current turn-holder);
- file critiques against the draft or another proposal;
- and you **must** respond to open critiques addressed to your own prior
  amendments (resolve, concede, or dispute with reasons).

Critiques use the structured findings format (ENHANCEMENTS.md items 13/14):
severity (HIGH/MED/LOW) × agreement state (agreed/partial/disputed) ×
anchor (draft section or proposal reference). Convergence is therefore
**measurable, not a vibe**: the phase cannot end with unresolved HIGH/MED
findings.

### 1c. The vote gate

Any peer, on its turn, may **call the question** on the current draft.

- **Electorate snapshot** *(F4)*: calling the question snapshots the eligible
  voter set (the barrier-snapshot roster, minus peers the human has ruled
  absent). Joins and leaves after the snapshot do **not** alter this ballot's
  electorate — a leave is recorded as an abstention that pages the human
  (unanimity cannot silently shrink to fewer minds than reviewed the draft).
  This replaces rev 1's blunt "roster changes void the tally."
- **Revision binding.** Votes bind to a draft revision hash. Any subsequent
  edit voids all cast votes. No approving a moving target.
- **Ballot contents.** The vote covers scope *and ordering*: the prose design
  and the normative task block, including dependency edges.
- **Pass condition.** Unanimous approval from the snapshot electorate AND
  zero unresolved HIGH/MED findings. LOW findings may ride into
  implementation as board annotations.
- **Rejection discipline.** A rejection must carry reasons; those reasons
  become the mandatory agenda of the next round. Content-free vetoes are
  rejected by `decide` (`vote-reject-without-reason`).
- **Livelock guard.** A configurable round cap (default: 3 full cycles).
  Hitting the cap with open disputes pages the human (watch TUI + toast),
  who arbitrates, re-scopes, or ends.
- **Vote records** *(ruling 1)*: WAL events are authoritative; each vote is
  additionally **projected into the archive** as a transcript message, so the
  mailbox record reads complete without journal access. The projection is
  derived, never load-bearing.

### 1d. The plan artifact

The draft is two coupled parts, and the broker validates the second **before
allowing the question to be called** — an unparseable decomposition cannot be
voted on:

1. **Prose design** — rationale, decisions, rejected alternatives. Seeds
   `memory.md` and the eventual session digest.
2. **Normative task block** — machine-readable (fenced YAML/JSON in the
   draft), one entry per task:

```yaml
plan:
  wip_cap: 1              # max active production claims per peer (F1)
  verification:            # tiered gate (F9)
    fast_gate: <command>   # mandatory, runs per merge-request
    full_suite: <command>  # runs at cadence + phase exit
    cadence: <policy>      # e.g. every-N-merges | hourly | exit-only
tasks:
  - id: t1
    title: <short>
    class: production | assist        # assist: research/test/docs (F10)
    merges: true | false              # assist only; false = output returns as
                                      # messages, claimable by observers (R4)
    description: <what and why>
    acceptance: [<criterion>, ...]
    deps: []            # task ids that must be MERGED first
    affinity: [<path glob>, ...]   # advisory conflict-avoidance hints
    size: S|M|L         # advisory
```

## The transition (planning → implementation)

On a passing vote the session moves through an explicit **provisioning
substate** *(C1)* — implementation is never exposed without its branch:

1. **WAL-atomic on the vote**: freeze the plan (immutable `plan.md` +
   `plan.json` in the session archive, stamped with the approved revision
   hash), mint the claims board from the task block (`.pair/tasks/`,
   broker-owned), set `phase: provisioning`, retire the turn token.
   **`decide` rejects claims while `phase: provisioning`.**
2. The **feature-branch saga** runs (`pair/<session-id>` cut from the agreed
   base ref — intent/prepare/apply/completion per Workspace sagas below).
3. Only the saga's **journaled completion** transitions
   `phase: implementation` — the event that opens claiming. Saga failure
   leaves the session in `provisioning` with a conflict event and pages the
   human; there is no implementation-without-a-branch state.

Every claim, merge-request, and amendment thereafter carries the plan
revision hash it was executed under.

## Workspace sagas: WAL ∘ git is not atomic *(F2)*

Every operation that touches both protocol state and git (branch cut,
worktree provision, merge, worktree removal) is an **idempotent saga**, never
a single assumed-atomic step. Four journaled stages *(prepare added per R3)*:

1. **Intent record** appended to the WAL (op, inputs, expected git refs,
   saga id) — committed before any git command runs.
2. **Prepare record**: all non-ref-moving construction happens and its
   result is journaled **before any ref moves**. For a merge: the candidate
   merge commit is built (as an unreferenced object), its **candidate hash**
   and the **fast-gate verdict against exactly that hash** are appended as a
   `prepare-result`. For provisioning: the resolved base commit. Recovery
   can therefore always distinguish "decided what to write" from "wrote it".
3. **Operation-specific apply** *(generalized per C2)*. Where the operation
   moves refs, apply is a **ref CAS**: compare-and-swap against the value
   recorded in the intent (`git update-ref` with old-value verification); a
   miss aborts the saga with a conflict event — never a force-win, never a
   retry against a silently different base. Where the operation's effects
   are not (only) refs — worktree add/remove touch a directory *and* git's
   worktree registry — the intent declares **journaled postconditions** and
   apply is complete only when all hold. E.g. worktree provision: directory
   exists at the recorded path, `git worktree list` registers it, HEAD is
   the prepared base commit; removal: directory absent, registry entry
   pruned.
4. **Completion record** appended to the WAL (resulting refs/commit ids, or
   the verified postconditions).

**Recovery outcomes are enumerated and each is a contract test** *(R3)*.
On broker start, sweep sagas lacking a completion:

| journal state found | recovery action |
|---|---|
| intent only | abort: compensate scratch state (unreferenced objects are garbage-collectable; no apply effects exist yet by stage ordering) |
| prepare-result, apply not landed (ref op) | re-verify the expected base ref is unchanged: unchanged → resume apply with the *journaled* candidate hash; moved → abort saga, emit conflict event |
| prepare-result, apply incomplete (non-ref op) | evaluate the journaled postconditions: all hold → append completion; none hold → re-run apply (idempotent); partial (e.g. directory present but unregistered) → complete forward if the postconditions can still be satisfied, else compensate (prune registry, remove directory) and abort |
| apply landed, no completion | postconditions/ref == prepared value → append completion (idempotent); mismatch → conflict state below |
| any state contradicting the repo | enter read-only workspace-conflict state; `pair doctor` reconciles with the human — the broker never guesses |

**Compensation and repair are restricted to broker-owned namespaces**
*(R3)*: `refs/heads/peer/*`, the session feature branch
(`refs/heads/pair/<session-id>`), and broker-provisioned worktrees. User
branches, tags, stashes, and working copies are never touched by recovery,
under any outcome.

- **Git refs are never authoritative protocol state.** The WAL decides what
  *should* be true; reconciliation derives what *is* true and repairs or
  reports drift (`pair doctor` grows a workspace section).
- **The git authority boundary, stated exactly** *(C4)*: a peer may commit
  to — and move — **only the branch of its own live, epoch-scoped claim,
  from inside its provisioned worktree** (those commits are what
  `checkpoint` publishes). The broker (`Workspace` port) exclusively owns
  everything else: feature/integration refs, branch creation, all merges,
  worktree lifecycle (provision/freeze/remove), and any cross-branch
  operation. Epoch fencing makes the peer's half revocable: a fenced
  epoch's commits can no longer be checkpointed, reviewed, or merged.

## Phase 2 — Implementation

### Claims (grants minus the issuer)

A claim reuses the shipped grant lifecycle with self-issuance:

- `pair claim -As <self> -Task <id>` — atomic via the broker; one claimant
  per task; rejected unless all `deps` are **merged** (not merely "done").
- **Fairness invariants, enforced in `decide`** *(F1)*:
  1. **WIP cap**: a claim is rejected while the claimant holds ≥ `wip_cap`
     active production claims (plan-declared, default 1). Capture rate is
     bounded by cap × merge throughput — and merging requires *another*
     peer's review, a structural brake first-come cannot outrun.
  2. **Review conscription**: a claim is rejected while an unassigned
     merge-request exists that the claimant is eligible to review
     ("stop starting, start finishing").
  3. When ready production tasks < idle peers, `assist`-class tasks
     (research, test authoring, docs — first-class board items, *F10*) are
     the sanctioned outlet; the board surfaces them to unclaimable peers.
     If none exist either, the peer idles honestly (see The guarantee) —
     the board never invents work.
- Claiming provisions an isolated worktree **via saga**:
  `git worktree add <path> -b peer/<task-id>-e<epoch> <feature-branch>`,
  broker-run and broker-tracked, with a `.pair-root` pointer file so mailbox
  and board commands resolve the coordinator repo without `-Root`
  gymnastics. **There is no shared-worktree mode in peer topology.**
- **Checkpoints publish transferable state** *(R7)*:
  `pair checkpoint -As <self> -Task <id>` records the claim branch's current
  commit hash in the WAL — the broker verifies the commit exists on the
  claim's branch and the epoch is live before accepting. `merge-request`
  implies a checkpoint. "Last recorded commit" everywhere in this document
  means **the latest accepted checkpoint** — prose exhortations to commit
  early cannot publish a hash to the WAL; only this verb does. The
  instruction contract (below) requires checkpointing at meaningful units of
  work; the succession worst case (no checkpoints → successor starts from
  the branch point) is the declared cost of ignoring it.
- **Claim epochs and fencing** *(F5)*: every claim carries an epoch,
  incremented on each succession. Lease expiry (below) **freezes** the old
  worktree: the broker marks the epoch dead, and every broker git operation
  is fenced on epoch validity — a zombie assignee can keep typing in its
  frozen worktree, but nothing it does can reach the board, a merge-request,
  or the feature branch. The successor **never inherits a writable
  workspace**: it gets a *fresh* worktree provisioned from the predecessor's
  **latest checkpoint** (uncommitted and uncheckpointed work is abandoned by
  design — checkpointed commits are the only transferable substrate).
- **Claim liveness: the keepalive companion** *(F7, mechanism per R5)*.
  Activating a claim mints an **epoch-bound renewal capability** (a token
  scoped to claim id + epoch, useless once the epoch is fenced) and the CLI
  spawns a detached **keepalive companion** — a minimal process holding only
  that capability, renewing the claim lease on interval over its own broker
  connection. Renewal is therefore independent of any tool call the agent
  runs or blocks in *(a peer deep in a long build or thread-wait does not
  expire its own claim)*, and independent of the agent harness entirely.
  Claim renewal is a **separate wire verb** from delivery-lease heartbeats
  *(ruling 5)* — extension semantics differ (a long build vs. a long read).
  Failure semantics: renewal lapse (companion death, machine sleep — the
  broker cannot and does not distinguish) starts a grace window, surfaced as
  a WARNING in `status`/`watch` **and as a preemptive control wake to the
  claimant**; lapse past grace = lease expiry → epoch bump, freeze,
  succession from latest checkpoint, page the human. A renewal carrying a
  stale epoch is rejected (fencing). No peer can revoke another peer's
  claim.
- `pair release -As <self> -Task <id> [-Reason]` — voluntary unclaim; the
  latest checkpoint is noted for the successor; the worktree is frozen
  and reaped, same as expiry (no writable transfer, even cooperatively).

### Review lifecycle *(F3)* — a real state machine, not a verdict

Transitions, exhaustively *(diagram replaced per C3 — fixup returns to
re-review, never to merge-verify)*:

| from | to | trigger |
|---|---|---|
| (claim) | merge-request/unassigned | claimant posts merge-request (implies checkpoint) |
| unassigned | review-assigned | eligible peer pulls it, or broker nudge past threshold; review lease starts |
| review-assigned | unassigned | review lease expiry or reviewer departure (repeat pages the human) |
| review-assigned | changes-requested | verdict: request-changes (findings attached) |
| review-assigned | approved(H) | verdict: approve, bound to head hash H |
| changes-requested | fixup | claimant reopens the worktree |
| fixup | review-assigned | new head posted: **all prior verdicts void**; the same reviewer keeps the lease if still live, else unassigned |
| approved(H) | merge-verify | broker constructs the exact candidate merge commit (feature-head + H), runs the fast gate on it |
| merge-verify | merged | gate green → feature-head CAS per the merge saga |
| merge-verify | changes-requested | gate red → gate output attached as findings |
| approved(H) | review-assigned | any commit moving the head off H before merge-verify begins (verdict voided) |

- `pair merge-request -As <self> -Task <id>` posts base/head refs,
  ahead/behind counts, a conflict preflight, and self-review notes; the
  claimant's worktree freezes (fixup reopens it).
- **Assignment** *(ruling 2)*: pull-first — any eligible peer takes it
  (`pair review-claim`). If it sits unassigned past a threshold, the broker
  **nudges** an eligible peer and assigns with a **review lease**; expiry or
  reviewer departure returns it to unassigned and pages on repeat.
- **Never self-approve**: `decide` rejects verdicts from the merge-request's
  claimant. In a two-peer session the other peer is always the reviewer; the
  human arbitrates disputes.
- **Verdicts are head-hash-bound**: `approved` records the exact head commit
  it approved. Any fixup commit voids the verdict and returns the state to
  review-assigned. **Stale verdicts** (arriving after a void, carrying an old
  hash) are archived as advisory, never applied.
- Findings use the standard format; a finding disputed twice pages the human.

### Integration: verified merges into the feature branch *(F9)*

- On approval, the broker constructs the **exact candidate merge commit**
  (feature-head + reviewed head) and runs the plan's **fast gate against
  that commit** — not against the branch tips separately. Only a green fast
  gate permits the feature-head CAS (per the merge saga, F2). One approved
  breakage can no longer poison every concurrent worktree.
- The **full suite** runs at the plan-declared cadence and at phase exit.
  `status`/`watch` distinguish **fast-green** (per-merge gate) from
  **full-green** (suite) so nobody mistakes one for the other.
- Verification commands are plan-declared and vote-approved by the peers —
  but peers approving their own gate is not a trust boundary, and the human
  is not a ballot voter *(R6)*. Therefore: **gate execution requires an
  explicit privileged user confirmation** (a U1 privileged action, journaled
  with the exact command strings) before the first run. The broker refuses
  to execute a gate without a live confirmation record, and any amendment
  that changes a verification command voids the confirmation and re-triggers
  it. This is trusted execution *(F8)*: the gate runs code from the repo
  under review, and the journal must show the human confirmed exactly these
  strings.
- **Mainline is never touched by the session.** The human merges
  feature → main after the session ends.

### Plan amendments *(F6)* — discovery is not failure

Three tiers, now with defined effects on in-flight work:

1. **Task-local deviation** — claimant notes it in the merge-request; the
   reviewer accepting it *is* the approval. No ceremony, no hash bump.
2. **Scope delta** — `pair propose-amendment -Delta <file>`. Async
   mini-vote; **electorate snapshots at proposal time** *(ruling 6)*; same
   revision-binding discipline (the delta names the plan hash it amends; an
   intervening amendment voids the proposal). On passing, the plan hash
   increments and the delta declares an **impact class per affected task**:
   - `untouched` — claims, reviews, approvals continue unchanged;
   - `rebase-required` — open claims on the task keep their worktree but
     must rebase onto the new dependency/ordering before merge-request
     (existing merge-requests return to the claimant as fixup);
   - `obsoleted` — the task is closed; its claim is released through the
     standard freeze path, and any open merge-request is withdrawn with the
     work preserved on its branch for salvage.
   Approvals and verdicts always bind to (plan-hash, head-hash) pairs; an
   amendment can therefore never silently retroactivate a stale approval.
3. **Foundational break** — a vote-gated return to Phase 1, as a real
   sub-state machine: `break-proposed → suspending` (each open claim is
   frozen at its last recorded commit and enumerated in a **wreckage
   report**: task, state, branch, salvageable commits) `→ suspended →
   planning` (the new barrier opens with the wreckage report as its brief,
   not blank proposals). Suspended claims are not auto-resumed: the new plan
   decides, per task, resume / rebase / obsolete via its task block.

### Phase 2 exit

Exit criteria, checked by the broker, proposed by any peer (`propose-end`),
confirmed by unanimous ack of the ballot-snapshot electorate or user command:

- claims board empty (all tasks merged, obsoleted by amendment, or
  explicitly deferred with a recorded reason),
- no open merge-requests,
- feature branch **full-green** (the plan's full suite passes at exit —
  fast-green is not sufficient here).

The closing act before `done`: generate the session digest (plan, outcome,
decisions, deviations, deferred work) into `.pair/history/<session-id>/`,
and hand the feature branch to the human.

## Authority model

- **No agent outranks another, ever.** All asymmetries are *positional*
  (current turn-holder in planning; claimant vs reviewer per task) and
  expire with the position.
- **The human is the only standing authority**: arbiter of capped disputes
  and no-shows, breaker of livelocks, executor of kicks, approver of
  verification commands, final merger.
- Roster *(F4; admission and eligibility per R4)*: joining is
  **authenticated admission**, not announcement — a join is a registry
  transaction (M1) over the broker's authenticated IPC identity, and the
  join event records the peer's credential binding. Admission is
  **authorized, not merely authenticated** *(round-3 clarification)*: by a
  privileged user action, or by a plan-declared admission policy the
  electorate approved (e.g. named expected participants); authentication
  alone never admits. An admitted peer is an **observer**. Production eligibility follows **one rule, one epoch**: *a
  peer may claim production tasks (and merging `assist` tasks) iff it is a
  member of the electorate snapshot bound to the current plan hash* — the
  original plan ballot or a later ballot/amendment whose snapshot includes
  it. There is no "joined after the plan" shortcut. Observers may claim
  only `assist` tasks flagged `merges: false` (research, analysis — output
  returns as messages, never as commits); their path to production
  eligibility is the next ballot, typically a trivial scope-delta amendment
  admitting them. Only the user kicks. Voluntary leave is blocked while
  holding an active claim or an assigned review — release/finish first; a
  leave during an open ballot is an abstention that pages the human.
- `handoff`, `revoke-turn`, and driver-only end **do not exist** in this
  topology. Their jobs are done by claim leases + epochs, the vote gate,
  and exit criteria respectively.

## Communication in peer topology

- Fused send-wait survives as **thread-scoped** waiting: messages carry
  `reply_to`; an ask registers in a broker-tracked awaiting-set; the sender
  fused-waits on *that thread* if actually blocked, or sends `-NoReply` and
  keeps working.
- **Preemptive control delivery** *(F7)*: control-plane events — user
  messages, phase transitions, lease/epoch warnings, amendment notices —
  **interleave into any open wait**, thread-scoped or not. A peer blocked on
  a thread reply still hears "your claim lease is aging" or "foundational
  break proposed" immediately; the wake event and the thread reply remain
  distinguishable in the output contract.
- `status`/`watch` show the awaiting-set (who owes whom what, and for how
  long) alongside the board, review pipeline, and phase state.
- Peers may message each other freely at any time. Etiquette rules
  (pointers not payloads, one decision per ask) are unchanged.

## What survives, what dies

| survives unchanged | survives re-scoped | dies in peer topology |
|---|---|---|
| broker, WAL, leases/acks | turn token (planning only) | driver/navigator vocabulary |
| mailboxes, atomic messages | grants → claims (self-issued, epoch-fenced) | `handoff` |
| fused send-wait | adversarial barrier → 1a opener | `revoke-turn` (→ lease expiry + epochs) |
| watch TUI + U1 user channel | findings format (reviews AND critiques) | driver-only end / roster authority |
| memory.md, conventions | round-robin preset (→ 1b) | advisory `-Files` shared-worktree scope |

## Mapping to the codebase

- `core/`: new commands/events — `propose`, `reveal`, `draft-amend`,
  `critique`, `call-question`, `vote`, `plan-freeze`, `claim`, `release`,
  `checkpoint`, `claim-renew` (the keepalive verb), `merge-request`,
  `review-claim`, `review-verdict`, `merge-verified`, `merge-committed`,
  `propose-amendment`, `phase-transition`, `user-confirm-verification`,
  plus saga intent/prepare/completion events. All phase/vote/claim/review invariants live in
  `decide` (electorate snapshots, revision/head-hash binding, WIP cap,
  review conscription, self-approve rejection, dep-merged gating, epoch
  fencing). The turn invariants become conditional on phase + topology —
  the existing pair topology tables must keep passing byte-identical.
- `app/`: use-cases for barrier submit/reveal, vote tally, board queries,
  claim/review lifecycle, saga execution. New port: `Workspace` (worktree
  add/remove, ref CAS, candidate-merge construction, gate execution) — the
  first port whose adapter runs `git`; its contract suite needs
  failure-injection (dirty worktree, CAS miss, merge conflict, missing
  base, crash between intent and completion).
- `apps/broker`: barrier/ballot timers, claim + review lease expiry, epoch
  fencing, saga recovery sweep, nudge scheduling, preemptive control
  delivery.
- `adapters/tui`: phase indicator; planning lane (proposals, draft revision,
  findings, ballot state); board lane (todo/claimed/review/merge-verify/
  merged, epochs, fast-green vs full-green); awaiting-set.
- Sequencing (each slice test-first):
  1. phase field + planning round-robin + draft/critique/vote with
     electorate snapshots in `decide` (pure core, no git),
  2. barrier (broker timers + sealed delivery + no-show paging),
  3. claims = grant rename + self-issue + WIP cap + conscription + dep
     gating + epochs (still no git),
  4. `Workspace` port + saga framework + auto-worktrees + `.pair-root`,
  5. review state machine + merge-verify pipeline (fast gate, CAS merge),
  6. amendments (impact classes) + foundational-break sub-machine,
  7. entry-point and instruction surfaces per the normative contract above
     (both skills, all instructions/*.md, PROTOCOL.md peer-mode section),
     with one golden transcript per harness per contract item; retire
     pair-topology assumptions from CLI output where phase-conditional.

## Entry-point and instruction contract *(user requirement; R2)*

Normative specification for the agent-facing surfaces — Claude Code's
`/pair` skill (`~/.claude/skills/pair/SKILL.md`), Codex's `$pair` skill
(`~/.agents/skills/pair/SKILL.md`), agy's equivalent per its adapter, and
the operating files (`instructions/claude-pairing.md`, `codex-pairing.md`,
future `agy-pairing.md`). **Specification only in this revision — no skill
or instruction files are edited until the implementation slice** (sequencing
step 7). Each numbered item below is a behavioral contract the updated
surfaces MUST satisfy; acceptance is a golden transcript per harness
exercising each.

1. **Topology dispatch.** On invocation (or on detecting an active session),
   read `session.json` `topology` + `phase` and branch: `pair` topology →
   today's driver/navigator instructions, unchanged; `peer` topology → the
   peer-mode instructions below. The skills MUST NOT present driver/navigator
   vocabulary, `handoff`, `revoke-turn`, or driver-end guidance inside a peer
   session — those verbs do not exist there and the CLI rejects them; the
   instruction text is host-conditional, not merely deprioritized.
2. **Init.** `pair init -Topology peer -Task ... [-PlanningMode full|light]`
   — the initiator becomes an ordinary peer, not a driver. The skill's
   "no session exists" branch asks the user for topology when ambiguous and
   defaults to `pair` for 2 agents / prompts for `peer` at 3+.
3. **Planning-phase conduct.** Submit the blind proposal **before reading
   anyone else's** (the barrier enforces sealing; the instructions must
   additionally forbid soliciting a partner's proposal out-of-band —
   blindness is also an agent obligation). Then: round-robin turn
   compliance, critiques in the findings format, mandatory responses to
   critiques on your own amendments, votes bound to the stated revision
   hash, and never editing repo files during planning.
4. **Implementation-phase loop.** There is no turn. The loop is: arm a wait
   → on wake, dispatch by wake type — thread reply → continue that
   conversation; control wake (user message, phase transition, lease
   warning, amendment) → act on it, never mistake it for a thread reply;
   conscription notice → `review-claim` before any new claim; otherwise →
   claim eligible work (WIP cap respected), work it, `checkpoint` at
   meaningful units, `merge-request` when acceptance criteria pass locally.
5. **Claim duties.** Work only inside the provisioned worktree (never the
   coordinator repo); run mailbox/board commands via the worktree's
   `.pair-root`; checkpoint before any long pause; treat a frozen worktree
   after lease expiry as by-design state loss bounded by your last
   checkpoint, not as an error to fight.
6. **Keepalive awareness.** The keepalive companion is automatic; the
   instructions state its failure semantics (grace warning arrives as a
   control wake — checkpoint immediately when one does) and forbid the agent
   from renewing leases manually or killing the companion.
7. **Review duties.** On conscription or pull: verdicts in the findings
   format, head-hash-bound; never approve your own merge-request; a fixup
   invalidates your verdict and returns the review to you; disputes escalate
   to the human after two rounds.
8. **Wait/re-arm mechanics per harness** (unchanged exit contract: 0 =
   delivery, 2 = timeout, else error): Claude Code backgrounds waits and
   fused thread-sends (`run_in_background`, re-arm on exit 2); Codex runs
   them foreground with its tolerated timeout and re-runs on exit 2; agy per
   its adapter's verified behavior. After *any* transport error whose output
   shows the send committed: never re-send — re-arm a standalone wait.
9. **Ending.** `propose-end` + unanimous ack of the ballot-snapshot
   electorate, or privileged user end. The skills' wrap-up guidance replaces
   "driver runs `pair end`" with this flow in peer sessions.

## Prerequisites *(F8)* — dependencies stated completely

Peer mode **cannot ship** before:

1. **Transport stability**: the detached-daemon socket drop — reproduced
   three times in the very session that reviewed this document (two fused
   sends lost their listening socket within ~30 s at 09:45:58 and 09:49:42;
   one `connect ENOENT` after broker idle-stop at 09:50) — plus reconnect
   hardening. Peer mode multiplies long-lived connections (thread waits,
   claim heartbeats, preemptive delivery); this is a hard prerequisite, not
   a hardening item.
2. **U1 slice 4 (privileged user actions)**: paging, arbitration verdicts,
   kicks, forced transitions all terminate at the human — they need the
   privileged user-channel command path, not advisory messages.
3. **M1 agent registry + admission**: electorate snapshots and observer
   status require registry versioning and join/leave events.
4. **Item 7 (message ids + `reply_to`)**: thread-scoped waits and the
   awaiting-set are built on reply threading.
5. **Item 5 lease extensions**: claim leases and review leases with the
   separate heartbeat verb *(ruling 5)*.
6. **Trusted verification execution**: the fast gate runs plan-declared,
   ballot-approved commands via the broker; command provenance and approval
   must be journaled (the human approved exactly these strings).
7. **Saga framework** (F2): intent/completion records + recovery sweep in
   the WAL vocabulary, contract-tested before any git-touching slice.

## Honest costs and declared limits

- **Planning overhead is fixed; task size isn't.** N blind proposals +
  multi-round convergence is right for a feature and absurd for a rename.
  Ship a `light` planning mode — **no blind barrier** *(ruling 4)*: one peer
  drafts, one critique round, vote (electorate = active roster at draft
  post). Selectable at init or proposed as the session's first act, itself
  vote-gated.
- **Unanimity prices consensus at N.** Healthy at 2–3 peers. Larger rosters
  need a different gate (quorum, weighted, human-delegated) — **declared out
  of scope for v1** rather than half-solved.
- **Merge conflicts scale with parallelism.** Mitigations: decomposition
  granularity, dependency edges, affinity hints, review conscription, and
  the per-merge fast gate. A bad plan split will hurt in a way the serial
  model never did; the amendment tiers are the pressure valve.
- **Plan drift between peers** is caught by critiques/decision threads, not
  prevented. Typed session notes (`pair note`, ENHANCEMENTS item 19
  extension) are the cheap complement.
- **Token cost is real**: N continuously-active agents versus one worker and
  a cheap waiter. Peer mode is for work that genuinely decomposes; the pair
  topology remains the right default for serial-attention work.
- **Abandoned work on succession is a policy choice** *(F5)*: freezing a
  zombie's uncommitted work trades lost keystrokes for integrity. Commit
  early, commit often is the mitigations' first line — and it is stated in
  the instruction files, not assumed.

## Resolved questions (rev 1 open questions, ruled by review)

1. **Vote records**: WAL-authoritative, projected into the archive as
   transcript messages (projection is derived, never load-bearing).
2. **Review assignment**: pull-first; broker nudge + review lease when
   unassigned past a threshold.
3. **Barrier deadline**: membership + deadline snapshot at open;
   first-submission grace window; no-show pages the human.
4. **Light mode**: skips the blind barrier entirely (no degenerate barrier
   ceremony).
5. **Claim heartbeat**: separate wire verb from delivery-lease heartbeat —
   different extension semantics (long build vs. long read).
6. **Amendment electorate**: snapshots at proposal time.

## Changelog: rev 1 → rev 2 (finding → section)

| finding | resolution section |
|---|---|
| F1 first-come capture | Claims → Fairness invariants (WIP cap, review conscription, assist outlet) |
| F2 WAL∘git non-atomicity | Workspace sagas (intent/CAS/completion, recovery sweep) |
| F3 review lifecycle | Review lifecycle state machine (leases, fixup, head-hash-bound verdicts, stale-verdict guard, merge-verify) |
| F4 electorate churn | 1a barrier snapshot, 1c electorate snapshot, Authority model → Roster (observer status, no-show policy) |
| F5 worktree succession | Claims → epochs and fencing (freeze, fresh provision, never-writable transfer) |
| F6 amendment semantics | Plan amendments (impact classes, break sub-state-machine, wreckage report) |
| F7 control-plane preemption | Claims → broker-observed liveness; Communication → preemptive control delivery |
| F8 incomplete prerequisites | Prerequisites (7 items, incl. live socket-drop reproductions) |
| F9 per-MR verification | Integration (exact-candidate fast gate before CAS, fast-green vs full-green) — codex's ruling verbatim |
| F10 egalitarian overclaim | Motivation → The guarantee stated honestly; assist-class board items |
| rulings 1–6 | Resolved questions |

## Changelog: rev 2 → rev 2.1 (round-2 finding → section)

| finding | resolution section |
|---|---|
| R1 non-idleness still overclaimed | The guarantee (narrowed to equal authority + bounded capture; honest idleness is valid state) |
| R2 entry-point contract missing | Entry-point and instruction contract (9 normative items); sequencing step 7 |
| R3 saga not recovery-testable | Workspace sagas (prepare stage + candidate-hash journaling, enumerated recovery-outcome table, broker-owned-namespace restriction) |
| R4 admission/eligibility contradiction | Authority model → Roster (authenticated admission; single eligibility-epoch rule; `merges: false` observer assist); task schema `merges` flag |
| R5 heartbeat mechanism unspecified | Claims → keepalive companion (epoch-bound capability, detached renewal process, grace/expiry semantics) |
| R6 human "approved" without voting | Integration (privileged `user-confirm-verification` gate, journaled command strings, void-on-amendment) |
| R7 undefined "last recorded commit" | Claims → checkpoint verb (WAL-published hashes; succession from latest checkpoint) |
| R8 premature "review-converged" | ENHANCEMENTS.md direction note reworded to "under adversarial re-review" |

## Changelog: rev 2.1 → rev 2.2 (round-3 finding → section)

| finding | resolution section |
|---|---|
| C1 implementation exposed without branch | Phase state machine + The transition (provisioning substate; claims rejected until branch saga completion journaled) |
| C2 saga stages assumed ref CAS universally | Workspace sagas (operation-specific apply; journaled postconditions for worktree ops; extended recovery table) |
| C3 diagram routed fixup to merge-verify | Review lifecycle (exhaustive transition table replaces diagram; fixup → review-assigned) |
| C4 broker-only git vs peer checkpoints | Workspace sagas → git authority boundary (peers: own live epoch-scoped claim branch only; broker: all else) |
| (optional) admission authorizer unnamed | Authority model → Roster (privileged user action or electorate-approved admission policy) |
