# R1 implementation proposal: one equal-partner protocol

Status: revision 2, cross-agent review approved by Claude on 2026-09-27
(message `20260927-215930-838`), with two optional clarifications applied below.
Design only; new proposed decisions still require user acceptance, and no
implementation is claimed. Implements [ROADMAP.md R1](../ROADMAP.md#r1--equal-partner-mode-as-the-default-and-only-mode).
Source baseline: `5fec4cf` on `worktree-roadmap-equal-partner`. The main checkout
has the user's additional uncommitted review-verb changes. Those must be landed
on main before cutting the R1 implementation branch. Do not commit, overwrite,
or merge that user work mid-flight merely to satisfy this proposal.

## Recommendation and decision boundary

Use a **shared worktree, fully asynchronous messages, and exclusive file claims**.
Every partner has the same ability to claim work, edit, ask, answer, and review.
No partner assigns another partner work or grants them permission to act. Work
is self-selected after discussing the objective and boundaries. A claim records
the claimant's intent; it is not a delegation or a task assignment.

This is a simplification of the existing messaging runtime, taking the durable
identity binding from peer mode. It is not the old peer planning system with its
barriers hidden. There is no topology field, driver, initiator authority, turn,
planning phase, ballot, task board, managed branch, or broker-created worktree.

| Decision | Source / disposition |
|---|---|
| Lightweight broker-rejected overlapping file claims | User-decided in R1 |
| N partners, including agy; two is the common case | User-decided in R1 |
| Old session state and WAL need not replay | User-decided in R1 |
| Shared worktree; no automatic workspace provisioning | Proposed answer to R1 shape question |
| Remove the turn token entirely | Proposed answer to R1 turn question |
| Keep blocking asks as a local CLI choice | Proposed; blocking does not grant authority |
| Claims persist until explicitly released; no expiry | Proposed; an absent listener does not establish that editing stopped |
| Equal invitation rights; forced removal remains human-only | Proposed roster rule |
| All current partners signal readiness before ordinary session end | Proposed close rule, described below |
| Broker is the only mutation runtime; retire legacy direct-file mode | Proposed simplification needed for authoritative overlap checks |

These proposals are reviewable defaults, not additional user decisions. R2's
native messaging investigation remains separate. R1 keeps the existing IPC,
delivery subscription, and harness waiting mechanism.

## What the current code actually supplies

| Evidence | Implication for R1 |
|---|---|
| `src/core/types.ts`: `PairSession` / `PeerSession`, grants, phase/planning unions | Replace with one state type; changing the default flag alone is insufficient. |
| `src/core/decide.ts`: pair grants and peer planning; `validateScope` checks declarations but does not arbitrate overlapping paths | Implement claims as a new small domain feature, not renamed grants. Peer claims/workspace sagas are future design, not a completed subsystem to preserve. |
| `src/broker/journal.ts`: WAL, snapshot, delivery ledger, dedup, awaiting, credential bindings, plus sealed/planning artifacts | Retain durability and identity; delete planning payloads and old replay normalization. |
| `src/apps/cli/brokerGateway.ts`: connection-bound attach and reconnect | Generalize this to every agent connection rather than deleting it with peer mode. |
| `src/core/awaiting.ts`: reverse-endpoint thread matching and oldest-untagged fallback | Keep thread correlation; remove ambiguous untagged resolution for the new protocol. |
| `src/core/evolve.ts`: lightweight review requests/gates; any tagged answer can clear a gate; departure drops some gates | Add explicit addressee/request identity and validate settlement. Departure must not silently erase review objections. |
| `src/apps/cli/brokerCli.ts`: fused waits depend on turn passing | Replace that trigger with command intent (`ask` versus nonblocking send). |
| `src/core/stats.ts`, gateway DTOs, TUI and filesystem codecs contain turn/phase/role fields | Update projections and metrics together with the domain, including snapshots. |

The working tree on `main` already adds dedicated review verbs beyond this
branch's base. Carry forward their useful CLI work after adapting it to these
contracts. This document does not claim a passing runtime baseline.

## Working contract

1. Partners agree on the objective through messages. There is no mandatory plan
   artifact or approval ballot. A partner proposes what it will tackle, acquires
   the relevant claim, and edits only after receiving a committed success.
2. Partners may read any project file and review concurrently. Claims reserve
   edits, not reads. A failed claim returns the blocking owner and scope; discuss
   the overlap, narrow the scope, or choose other work. No automatic queue or
   stealing.
3. Before expanding an edit, atomically update the claim. Release promptly when
   editing stops; send a summary and request a review with explicit scope. A
   released claim does not certify the work or settle review findings.
4. Shared-worktree Git operations still require coordination. Avoid broad staging,
   checkout/reset/stash, whole-tree formatters, and commits containing someone
   else's edits. Stage explicit owned paths. Hold the exclusive `git` claim
   across stage plus commit and every index/HEAD/ref-changing operation;
   use a temporary repo-wide file claim as well for operations that
   can rewrite other partners' files. The broker does not execute or police Git.
5. Claims do not isolate test runs from concurrent edits. State the reviewed
   commit(s), or identify an uncommitted snapshot explicitly. Do not call moving
   shared-worktree test results validation of an exact commit.
6. When idle, keep a listener armed using the harness's existing supported
   mechanism. While useful independent work remains, nonblocking messages and
   async review allow it to continue. R1 does not invent native push delivery.

Example (proposed CLI):

```text
pair init -As claude -Agents claude,codex,agy -Task "Improve review delivery"
pair join -As codex
pair claim -As codex -Files src/core/awaiting.ts,tests/core/awaiting.test.ts -Message "Thread resolution"
pair claim -As claude -Areas src/adapters/tui/ -Message "Show review debt"
pair review-request -From codex -To claude -Base <commit> -Head <commit> -Message "Review thread matching"
pair claim-release -As codex -Id <claim-id> -Revision 1 -Message "Edits complete; review pending"
pair verdict -From claude -To codex -ReplyTo <request-id> -Severity MED -Message "Explain this edge case"
pair review-resolve -From codex -To claude -ReplyTo <verdict-id> -Message "Fixed in <commit>; checked with ..."
pair ready -As codex
```

No command transfers a role. A reviewer wishing to fix something claims the
paths itself after the previous owner releases them.

## State, commands, and authority

Keep `decide(state, envelope)` and `evolve(state, event)` pure. The broker
authenticates and supplies IDs/time/path facts; `decide` authorizes transitions.
The state outline below is a target schema, not a compatibility union:

```ts
type SessionState = {
  schemaVersion: 2;
  sessionId: string;
  task: string;
  status: 'active' | 'paused' | 'completed';
  started: Timestamp;
  registry: Registry;                 // invited, active, left, removed
  claims: Readonly<Record<ClaimId, Claim>>; // active file or git claims only
  reviewRequests: Readonly<Record<MessageId, ReviewRequest>>;
  reviewGates: Readonly<Record<MessageId, ReviewGate>>;
  ready: readonly AgentId[];
  userChannelTokenHash?: string;
};
type ClaimScope = { kind: 'file' | 'directory'; path: string };
type Claim = {
  id: ClaimId;
  owner: AgentId;
  resource: { kind: 'files'; scopes: readonly ClaimScope[] } | { kind: 'git' };
  revision: number;
  purpose: string;
  created: Timestamp;
  updated: Timestamp;
};
```

Derive the active roster from the registry rather than maintaining a second
independently mutable roster. Preserve public credential binding metadata and
broker-private verifiers. Keep awaiting debts durable in the journal's existing
projection; do not create a competing resolution rule in the UI.

| Action | Rule |
|---|---|
| `init` | Caller is one of the named invitees and binds its own credential atomically. Other names are invited, not impersonated or required to attach before work starts. Init creates no owner. |
| `invite` | Any active partner can invite another identity; user channel can also admit. Invitation alone gives no authenticated connection. |
| `join` / reconnect | Self only, invited or voluntarily left identity, with valid binding. Reconnect does not duplicate membership. Removed identities require a fresh invitation from the user. |
| Send, ask, review, claim | Any authenticated active member, subject to its own operation's validation. |
| Update/release claim | Owner only; compare expected revision. No assignee or issuer field. |
| `leave` | Self only, after releasing own claims. Review obligations survive. No automatic end when the last member leaves. |
| Kick / force-release / pause / resume / forced end | Authenticated user channel only; no agent becomes a moderator. |
| `ready` / `unready` | Self only. Ready is a completion declaration, not a grant of authority. |
| `end` | Any active member, with the close conditions below. |

Remove the current fixed eight-agent domain limit; retain transport byte limits
and validate roster payload size explicitly. Logic and tests must work with
arbitrary N within those resource bounds, including more than eight and a
temporary one-member or zero-member session. Omitted `-To` is valid only when
exactly one other active member exists; otherwise return `recipient-required`.

Invited-but-never-joined identities do not count as active members and never
block readiness or end. Joining/rejoining starts unready; departure removes
only that member's ready declaration. Pending invitations confer no authority.

Preserve today's pause behavior on retained operations. Add the narrow rule
that agent claim acquire/update (including git claims) and ready/ordinary end
are rejected while paused. Owner release and unready remain allowed, so a
partner can relinquish work safely without waiting for resume. Existing authenticated user
recovery actions remain available, including forced release. Resume changes
status only. A broader pause/lapse redesign is deferred.

## File and Git claims: exact contract

Expose `claim`, `claim-update`, `claim-release`, and read-only `claims`.
`-Files` names exact paths; `-Areas` names recursive directories. A command can
contain both. `claim-update -Id ... -Revision ...` replaces the whole scope set
atomically; a rejection leaves the original claim intact. Release also takes
the expected revision. Creation starts at revision 1. IDs are never reused.

`claim -Git` acquires the one exclusive repository Git resource, with the same
owner/revision/release/durability rules as file claims. It is mutually exclusive
with `-Files`/`-Areas`, cannot change resource kind on update, and conflicts only
with another git claim, never a file/directory claim. Hold it around the entire
stage-and-commit sequence and any command changing the index, HEAD, or refs.
Acquire required file scopes first, then git; on conflict, do not hold git while
waiting for file scopes. On acquiring git, inspect existing staged changes and
do not commit/un-stage someone else's leftovers. Recovery requires discussion
or human intervention if the prior holder crashed with a dirty index. A git
claim serializes cooperative commands; it does not clean or enforce the index.
Operations rewriting project files additionally require their file scopes.
The `.git` path ban remains: this resource is not permission to edit metadata
files directly. Git claims do not expire automatically despite normally being
held only for a short stage/commit operation.

The broker passes raw declarations to pure `src/core/claims.ts`, which validates
and canonicalizes them and checks overlap inside the serialized decision path.
No filesystem walk or new path adapter is required:

- Paths are relative to the broker's canonical repository root, use `/`, and
  have no leading/trailing separators in the stored key. `.` is allowed only
  as the explicit repo-wide directory scope.
- Normalize `\\` separators; remove `.` components; reject `..`, absolute/drive/
  UNC paths, empty names, control characters, wildcards, Windows device names,
  alternate-stream colons, and components ending in a dot or space. Scope
  syntax is literals, not globs. Preserve a display spelling separately if needed.
- Normalize Unicode to NFC, then apply JavaScript `toLowerCase()` (not
  locale-dependent `toLocaleLowerCase()`) to comparison keys on every host.
  This conservatively rejects case-distinct claims rather than allowing a
  Windows collision. Canonical keys in WAL replay do not depend on the host.
- New files/directories are valid. Paths are lexical repo-relative names; R1
  does not resolve symlinks, junctions, reparse points, or hard links. Partners
  must use ordinary repo paths and avoid aliases; alias validation is deferred.
- An exact-file scope overlaps the same file; a directory overlaps itself and
  every descendant; directories overlap if either contains the other. Compare
  path components: `src/a` must not collide with `src/ab`. A file at a directory
  scope's exact path also conflicts. Reject overlapping scopes across distinct
  claims even for the same owner; use `claim-update` instead.
- Deduplicate and reduce redundant scopes within a single claim. Proposed
  bounds: 128 scopes per claim, 1,024 characters
  per path, 1,024 characters for purpose. Return explicit limit errors.
- Reject `.pair` and `.git` metadata scopes. A `.` claim reserves project edit
  space; it never authorizes direct modification of broker or Git metadata.

Acquisition, overlap check, WAL append, and state publication use the existing
serialized commit path. Two racing acquisitions have exactly one winner.
Responses include claim ID, revision, canonical scopes, and commit sequence;
`claim-conflict` includes each blocking claim/owner and the intersecting paths.
Other errors include `invalid-claim-scope`, `claim-not-owner`,
`claim-revision-conflict`, `claim-not-found`, and `claim-limit`.

Journal `claim-acquired`, `claim-updated`, and `claim-released`; releases carry a
reason (`owner`, `user`, `kicked`, `session-ended`) and optional summary.
Author comes from the enclosing authenticated record. Released claims disappear
from active state but remain in history/stats. Claim changes publish durable
broker-authored notices to other active members in the same transaction; replay
must not enqueue the notices again.

No timer, listener loss, broker idle exit, or delivery acknowledgement releases
a claim. These are not delivery leases. Claims survive restart and do not keep
an otherwise idle broker alive. After a crash, the owner reconnects and inspects
its existing claims; a user can explicitly release abandoned claims. Forced
release/kick cannot stop an already running editor: the UI states this, and the
human first stops or coordinates with that process before another partner edits.

This guarantees exclusion among canonical broker declarations. It does not
intercept writes, prevent edits outside claims, or detect filesystem aliases.
Instructions prohibit using or creating aliases inside active scopes. Stronger
filesystem enforcement is outside R1's explicit lightweight requirement.
The deliberate unattended-run tradeoff is that a crashed owner's claim can
block work until the owner reconnects or the human releases it. R1 does not
let the remaining agents vote away an absent partner's claim.

## Messages, waits, batches, and reviews

Remove `TurnMode`, the `turn:` header, role changes, and implicit close via raw
`done`. Keep ask/answer/review/info plus typed lifecycle notices. Operational
notices are broker-authored; agents cannot forge them through `send`.

`send` returns after commit by default. `ask` sends once and waits for its own
thread(s), unless `-NoWait` is given. `send -Type ask` follows the same default
as `ask`; other send types never fuse implicitly. `review-request`, `verdict`,
and `review-resolve` are always nonblocking. This preserves the useful fused
decision request without tying it to global permission to work.

All answers/verdicts/resolutions require `-ReplyTo`. Validate reverse endpoints
and known target kind before committing. Remove oldest-untagged settlement.
For an already settled thread, reject another resolution with `thread-settled`
(unless it is a retry with the original idempotency key); an explicit info
message can record further discussion. Keep thread outcome metadata outside
the bounded transcript ring so compaction cannot change these rules.

Batch asks remain one atomic transaction, with individual IDs and a shared
group ID; there is no special last item's turn pass. Fused batch wait completes
only when all requested threads are terminal. Batch answer input identifies
each request ID explicitly; validate every item before committing any item.

Fused waits print/ack intervening FYIs and keep waiting for their target threads.
Standalone wait drains available deliveries and returns. Exit 0 means the wait
condition was satisfied; exit 2 means timeout. Output distinguishes answered,
lapsed, and cancelled threads, never claiming all were answered just because
they became terminal. Kicked, revoked-credential, or session-ended subscription
termination is an explicit terminal outcome. Timeout after send still says
`SEND ALREADY COMMITTED — do NOT re-send` and gives `pair wait -Threads ...`.
Keep request dedup, at-least-once delivery, print/flush-before-ack, and reconnect
from the last acknowledged delivery cursor.

Retain the lightweight async review system rather than importing planning
findings. `review-request` stores requester, reviewer, declared base/head/path
scope and lapse deadline. A verdict must reference that request and travel from
its reviewer to requester. A HIGH/MED verdict creates a gate with request ID,
reviewer, addressee, severity, scope and verdict ID. LOW does not block close.
Only the addressee's `review-resolve` to that reviewer clears the gate, with a
nonempty explanation of the fix or dispute. This remains the existing conduct
model of an explicit response, not proof of a code fix or a new reviewer-vote
machine; unresolved disagreement goes to the user under the conduct rules.

Ordinary answers cannot bypass these checks. Implement dedicated core review
commands, lowering their output to ordinary threaded messages plus typed review
events in one transaction. The broker's runtime allowlist must expose these
commands and reject attempts to bypass them through generic `send` fields.

Preserve the 15-minute default and explicit `review-lapsed` provenance for an
unanswered request. Once a verdict creates a gate, no lapse clears it. A verdict
after lapse is rejected as `thread-settled`; send an advisory info message and
open a fresh review request if a new formal review is needed. Late-verdict
reopening rules are deferred. A completed session never reopens. Add this
conduct rule to all harness instructions: when a late info reports a HIGH
finding, the requester marks itself unready and opens a fresh review-request to
that reviewer before readying again. This is a conduct obligation, not automatic
severity detection in free text or a gate created by an info message.

Departure cancels ordinary awaiting debts and unanswered review requests with
explicit durable outcomes, without interpreting cancellation as consent. Existing
review gates survive departure of either party. The addressee can still settle
a gate addressed to a departed reviewer (archive the response, no delivery to
the removed member); otherwise the user must explicitly waive it with a reason.
Kick/leave must not become a way to erase findings silently.

## Closing without a driver

`ready` says "I have stopped editing and consider this objective complete."
It requires no owned claims, no unanswered debts involving the caller, and no
review gates addressed to it. There is no automatic session end. Any partner
may then run `end -Summary ...` if all active partners are ready
and there are no active claims, pending review requests, unresolved
asks, or review gates anywhere in the session. Otherwise return `end-blocked`
with the concrete blockers. `propose-end` can remain a nonbinding broadcast
convenience; it no longer petitions a driver.

Readiness is per member, with no global generation. Acquiring either kind of
claim clears only its owner's ready declaration; a new HIGH/MED gate clears
only its addressee's. `unready` clears only the caller. These changes are part
of the same journaled transition as the triggering operation. Messages,
propose-end notices, lapse, delivery operations and other members' activity do
not clear readiness. New asks/reviews can still block end through its live debt
checks without erasing ready declarations. A late claim and end are serialized:
if claim wins, end sees the claim and unready owner; if end wins, claim fails
because the session is completed. No silence window is needed.

The user can force end regardless of readiness: record outstanding debts/gates,
release claims and send terminal notices in the same commit. This is visibly
forced completion, not approval. Forced kick also releases the removed member's
claims and voids its deliveries atomically, wakes its blocked subscriptions, and
preserves review gates. Ordinary end and forced end still write the summary to
memory through the broker's existing projection path.

## Storage, identity, and compatibility cut

Keep the broker's single writer, authentication boundary, WAL flush-before-ack,
election/recovery protection, snapshots, tamper detection, mirrors and observer
resynchronization. Generalize peer credential attach/rebind to the sole model.
An init binds only its caller; invited partners attach with their own credentials.
Authentication precedes dedup lookup, so a removed or revoked connection cannot
replay a privileged success. Recovery must preserve bindings and revocations.

Use protocol/schema version 2 (verify the available numeric version at
implementation). Stamp and validate the discovery/IPC handshake, WAL records,
snapshot and session mirror. Missing version is legacy, not a default to the
new shape. Validate before replay, torn-tail truncation, mirror repair, or any
append. An incompatible snapshot or well-formed unsupported WAL record is a
version error, never a corrupt tail to truncate. An old broker/client mismatch
fails explicitly rather than falling back to file mode or spawning a competing
writer. Session IDs remain mandatory and bind commands/subscriptions to the
correct session so delayed requests cannot mutate a replacement session.

Do not migrate or automatically delete existing `.pair/` data. Report
`unsupported-session-version` with a short recovery procedure: stop the old
broker/listeners, preserve the entire old directory outside the new `.pair/`,
then initialize a fresh session. The implementation must leave legacy bytes
untouched on rejection, including read-only commands. No reset/migration engine
is needed for R1. History documents remain readable; old WAL analytics are not
a supported format after the cut. Memory can be copied deliberately as context,
never imported as authoritative state.

Remove the `CLAUDEX_PROTOCOL_MODE=fs` selection in `src/apps/cli/main.ts` and
its direct-file mutation composition (there is no `-Mode fs` CLI flag). Reject
the legacy environment setting explicitly rather than silently ignoring it.
Remove the no-journal filesystem watch fallback in `src/apps/cli/watch.ts`;
an unsupported old session gets the same version/recovery diagnostic. Keep filesystem
adapters that implement the broker's journal/mirrors/message codec, and direct
read-only diagnostics with their observed sequence/epoch. Remove ignored legacy
flags rather than accepting them silently: generic per-command unknown-flag
validation rejects `-Topology`, `-Driver`, `-Turn` and grant/planning/worktree
options; generic unknown-command rejection covers retired verbs. No special
error per retired flag. Keep `-NoWait` only where it has meaning.

## Surface and code changes

| Area | Implementation work |
|---|---|
| `src/core/{types,commands,events,decide,evolve,queries,errors,index}.ts` | Single schema, authority table, readiness and review contracts. Add pure `claims.ts`; remove grants, phases, turns, draft/findings/ballot branches and role queries. Delete `plan.ts` / `rotation.ts` when no live consumers remain. |
| `src/core/awaiting.ts`, `src/broker/journal.ts` | One explicit thread transition model with durable terminal outcomes; claim/readiness replay and snapshots; version validation; remove sealed bodies/planning artifacts and legacy normalization. |
| `src/broker/{server,ports}.ts`, `src/apps/broker/main.ts` | Shared serialized claim commit path, authenticated sole-model admission, durable notices, removal/close cleanup and DTOs. Remove peer deadline/planning plumbing. No new filesystem path adapter. |
| `src/app/ports/{gateway,index}.ts`, `src/app/usecases.ts` | Role-free public contracts; claim/review query DTOs; remove direct-file mutation use cases if no longer used. Preserve dependency direction. |
| `src/adapters/fs/*`, `src/adapters/ipc/*` | Versioned role-free codecs and wire validation; claim mirror/view instead of grant store; remove artifact projections and obsolete transport operations. |
| `src/apps/cli/{main,brokerCli,args,brokerGateway,brokerWait,batch,bind}.ts` | New commands/help, explicit flag rejection, revised fused wait and batch inputs; retire fs bind composition; preserve review-verb follow-up work from main. |
| `src/apps/cli/watch*.ts`, `src/adapters/tui/*` | Replace driver/turn/grants/planning panels with members, claims, review debt, ready state and liveness. Update user actions (force-release/waive-review instead of grant/phase controls). Retain confirmation and durable action-notice correlation. |
| `src/core/stats.ts`, `src/apps/cli/stats.ts` | Keep message/thread/review/lapse throughput; add claim hold durations/conflicts if recorded and readiness/close timing. Remove turn-based wait/work ratios and planning metrics; do not relabel claim duration as measured work time. Rejected claims are not WAL events, so no durable conflict count unless explicitly instrumented. |
| Wake digest | Include own claims, peers' scope summary, owed/requested threads, review gates, ready members and session status; remove turn/role/phase fields. Keep memory pointer and declared review scope. |
| Docs / harness entry points | Rewrite `PROTOCOL.md`, README, all three instructions and installed `/pair` / `$pair` skills together. Verify actual installed paths during implementation. Remove role prompts, plan ballots, topology examples and grant instructions. Preserve per-harness waiting guidance; R2 verifies alternative transports later. |

Keep older design files in `docs/`, adding a historical/superseded banner where
they could be mistaken for current operating instructions. Update
`docs/ARCHITECTURE.md` and `docs/BROKER-SPEC.md` for the live contracts; these are
implementation references, not merely archived feature proposals. Do not touch
the separate `claudex-tui*` experimental checkouts as though they were product
sources.

## Deferred hardening / tech debt

- Filesystem alias walks and stronger Unicode/filesystem equivalence checks;
  lexical declarations are the initial guarantee.
- A redesigned comprehensive pause/lapse matrix beyond preserving retained
  behavior and blocking claim acquisition/updates while paused.
- Late verdicts that reopen lapsed review threads.
- Per-member claim-count policy; retain per-request size bounds in R1.
- Specialized migration errors for each retired flag; generic unknown options
  are sufficient.

These are not R1 acceptance blockers. The core slice retains lexical claims,
the git resource, explicit thread IDs, surviving review gates, symmetric
authority, per-member readiness, and a clean version cut.

## Implementation sequence and acceptance

Implement on one feature branch in reviewable slices. Do not ship a transient
two-mode release. Cross-agent protocol review is required by the roadmap before
implementation; Claude approved revision 2 with no remaining blockers.

1. **Freeze contracts and fixtures.** Review the proposed decisions, create
   role-free session/command fixtures and transition tables, enumerate retained
   transport tests. The user's review-verb follow-up must already be landed on
   main before the implementation branch is cut; do not absorb it mid-flight.
2. **Replace the domain.** Claims, registry authority, review correlation,
   readiness and lifecycle; remove both topology branches and their exclusively
   obsolete tests. Adapt retained invariant tests rather than discarding them.
3. **Wire durability and transport.** Schema cut, path validation, claim
   serialization/recovery, identities, thread outcomes and cleanup. Remove
   direct-file mutations and planning artifacts; retain failure injection tests.
4. **Finish CLI and observation.** Commands, waits/batches, rejected old flags,
   watch/user controls, codecs, wake packets and honest stats.
5. **Update operating contract and validate.** Protocol/instructions/skills and
   runnable examples; full checks, Windows real-broker scenario, and a manual
   harness rehearsal. Only then mark R1 complete in the roadmap.

Required acceptance evidence:

| Test group | Scenarios that must pass |
|---|---|
| Symmetry | Swap any two agent identities and obtain equivalent permissions/results. Initializer has no extra rights. Exercise 2, 3 (claude/codex/agy), and >8 members. |
| Scope correctness | Exact-file conflict, ancestor directories, siblings, `src/a` vs `src/ab`, slash/case/NFC variants, nonexistent paths, root claim, invalid/escaping lexical paths and bounds. |
| Atomic claims | Concurrent clients on one broker race for one scope: one success. Partial multi-scope collision commits nothing. Failed expansion preserves old claim. Wrong owner/stale revision rejected. Separate election test proves competing startups leave one writer. |
| Git resource | Two stage/commit claimants serialize; git does not conflict with file claims; wrong-owner release rejected; crash preserves git claim; instructions cover staged leftovers and file scopes for working-tree rewrites. |
| Durability | Crash after append/before reply, retry same request, snapshot/restart with claims and ready state, disconnected owner retains claim, idle broker restart, mirror rebuild and tamper refusal. |
| Messaging | Nonblocking sends/reviews; fused ask waits only for its IDs; FYI does not finish it; partial batch remains pending; wrong endpoint reply rejected; timeout does not duplicate send; replay and print-before-ack retained. |
| Review | Either partner requests/reviews; unrelated answer cannot clear gate; only addressee resolves; post-lapse verdict rejected; departure preserves gates; rejoin or explicit user waiver resolves abandonment. |
| Lifecycle | Leave with claims rejected; forced kick/end atomically release/void/notify; stale credential rejected; paused acquire/update rejected but owner release/unready allowed; no inherited claims/readiness on rejoin; zero-member session remains recoverable. |
| Completion | Missing readiness/debts/claims block end; claims clear only owner's ready, gates only addressee's; N-agent completion messages preserve readiness; invitees do not block close; end/acquisition race serializes; forced end accurately records unfinished work. |
| Compatibility | Legacy snapshot/WAL/mirror and mixed versions fail before writes/truncation; no fallback writer; old flags fail clearly; same-version damaged-tail recovery still works. |
| Projections | Live push and fresh snapshot agree on claims, reviews, roster and readiness. No operational driver/turn/phase/grant labels; wake digest and stats show the new semantics. |
| Real workflow | Three partners take disjoint claims, collide deliberately, update/release, exchange batched asks and async review, restart broker mid-wait, and close cooperatively. No role changes or topology flag. |

Run `bun run check` (lint, dependency-cruiser, TypeScript, all tests) and
`bun run build`. Add focused real CLI tests around the new command contracts;
retain the journal/IPC/election/delivery suites with new fixtures. Search live
sources/help/instructions for old topology and authority terms and inspect each
remaining hit (historical documentation and explicit rejection messages are
legitimate). Report automated evidence separately from actual Claude/Codex/agy
harness rehearsal; a synthetic three-name test does not prove harness behavior.

R1 is done when there is one live protocol and mutation runtime end to end,
every retained feature works without roles or turns, claims reject overlap
durably, the full checks pass, and installed entry points teach the same model.

## Review disposition (Claude round 1)

B1 accepted: replace global generation with per-member readiness and serialized
end predicates. B2 accepted: add exclusive non-path git claim, including staged
leftover recovery and acquisition order. B3 accepted: tier filesystem alias
checks, pause redesign, late-verdict rules, claim-count policy and bespoke flag
errors out of initial R1. Corrected fs-mode removal to the environment switch
and no-journal watch fallback.

N1 accepted: invitees never block readiness/end. N2 accepted as an explicit
tradeoff: user-only forced release, with possible unattended blocking. N3
accepted: user's main changes land before implementation branch creation, not
mid-flight. N4 accepted: concurrent clients on one broker plus a separate
election test. N5 accepted: NFC plus locale-independent lowercase. N6 retained:
explicit staging, release is not review, committed-send timeout wording,
unambiguous recipient defaults and honest metrics.

Round 2 approved with no blockers. L1 accepted: owner release and unready remain
allowed while paused. L2 accepted: late HIGH info obliges the requester to
unready and request a fresh review before declaring readiness again; this is
instruction-level conduct, not an automatic gate.
