# U1 slice 4 — privileged user actions (design, pre-code)

Status: REV 2 — codex critique round 1 applied (blockers R1 kick-structural-
validity, R2 paused-status matrix, tail-A resume semantics + action
correlation + freeze-then-mint confirmation, tail-B shared roster-aware
commit + kicked-wait wake + principal-as-actor). No code until approved
(slice-4 design gate, per the slice-3 close verdict `20260720-113254-615`). Builds on slice 3 (advisory user channel: TOFU
credential, connection-bound auth, `user-message`, watch composer).
Upstream requirements: ENHANCEMENTS.md U1 ("state changes go through
explicit privileged commands — cancel-grant, pause, resume, end — executed
by the broker as user-channel actions") and item 11 ("a user-authorized end
stays immediate and non-vetoable"); downstream consumers:
PEER-MODEL.md prerequisites 2 (paging/arbitration/kicks/forced transitions)
and 6 (`user-confirm-verification`).

## Principle

Slice 3 made the user a *voice* (advisory messages that outrank agents by
convention). Slice 4 makes the user an *authority*: a small set of session
mutations the broker executes on the user's behalf, bypassing agent-level
guards (driver-only end, issuer-only cancel), because the human outranks
both agents. Everything else stays advisory — a privileged verb is added
only when prose-cannot-do-it (end a session, kill a grant, remove an agent,
freeze activity).

## Verb set

Staged inside the slice; 4a has existing core vocabulary, 4b adds one new
session state. The peer-model verbs are declared as the extension seam and
are NOT in this slice.

| verb | stage | effect | agent-guard bypassed |
|---|---|---|---|
| `user-end-session` | 4a | immediate session end + done fan-out | driver-only end; non-vetoable |
| `user-cancel-grant` | 4a | cancel any open grant | issuer-only cancel |
| `user-kick-agent` | 4a | remove an agent; its grants cancelled, deliveries voided (same txn semantics as driver kick) | driver-only kick |
| `user-pause-session` / `user-resume-session` | 4b | freeze/unfreeze agent mutations | n/a (new) |
| (extension seam) `user-confirm-verification`, arbitration verdicts, forced phase transitions, absentee rulings | peer-model slices | — | — |

**Pause semantics (4b)**: `session.status: 'paused'` — a *fourth* status.
Statuses partition into **live** (`active`, `paused`) and **terminal**
(`completed`, plus any future terminal kinds); every existing
`status !== 'active'` branch must be re-audited against that partition
(codex critique R2) — the current code treats not-active as terminal
everywhere. Exhaustive matrix:

| surface | behavior while `paused` |
|---|---|
| `decide`, agent principal | every mutation → stable `session-paused`, EXCEPT `leave-session` and `complete-grant` of an ALREADY-ACTIVE grant (committed edits land their record; accepts/issues are refused) |
| `decide`, user principal | all slice-4 verbs valid (`user-end-session` while paused is F-A6); advisory `user-message` valid |
| broker ledger ops (`ack`, `extend`, `subscribe`, `observe`, reconnect/resume, `query`) | allowed unchanged — they are delivery/ledger mechanics OUTSIDE `decide`, and leases must drain honestly (resolves open question 1: `extend` allowed) |
| `pair init` re-init guard | REJECTS over a paused session exactly as over active (paused is live; only terminal statuses may be re-inited over) |
| `watch` | stays OPEN with the composer usable (the user must be able to `/resume`); loud PAUSED banner; exits only on terminal statuses |
| `wait` / `status` CLI wording | "session paused by the user — stand by for resume"; never the ended wording |
| disk/core `SessionState.status` union + mirrors | gains `'paused'`; session.json round-trips it; fs-diagnostic watch renders it |
| instructions files | agents told: `session-paused` means stand by, do not re-send, do not end |

**Resume changes ONLY the status** (codex tail A): mutations legitimately
committed while paused — a leave that returned the turn to the driver, a
grant completion — are preserved, never rolled back; there is no snapshot-
and-restore. Pause is a brake on agents, never on the human.

## Authorization chain (wire → core)

1. **Transport**: new frame kind `user-action` — tokenless, connection-bound
   exactly like `user-send`: valid only on a connection that completed
   `user-attach` (`#userConnections`), refused otherwise with
   `user-channel-required`. The generic `execute` path rejects all
   `user-*` command kinds (existing transport gate extended to the new
   kinds) — an agent cannot forge user authority even naming principal
   `user`.
2. **Broker**: `core.userAction(reqId, clientId, connectionId, action)` —
   dedup by `(clientId, reqId)` BEFORE any effect (same frozen contract as
   `user-send`); publication-guard semantics do not apply (no sink is
   registered) but the connection check is at execution time.
3. **Core**: new commands in the `Command` union, `principal: USER_IDENTITY`
   envelopes. `decide` authorizes: user commands are valid from the reserved
   identity only, never from roster agents; agent-guards (driver-only,
   issuer-only) are structurally inapplicable rather than specially bypassed
   — separate command kinds, separate invariants. **Human authority bypasses
   ROLE authorization, never STRUCTURAL validity** (codex critique R1):
   - `user-kick-agent` keeps every roster invariant: cannot kick a
     non-member, and **cannot kick the driver** in pair topology — evolve
     must never leave `driver`/`turn` pointing outside `agents`
     (ENHANCEMENTS item 11). The error directs the user to `/end` (which is
     immediate and non-vetoable — the drain-the-session intent has a
     legitimate verb already). Peer topology may redefine kick once the
     driver role does not exist.
   - Kicking the navigator **while it holds the turn** returns the turn to
     the driver in the same txn, mirroring voluntary leave-with-turn.
4. **Events and the actor of record** (codex tail B): reuse the existing
   effect event kinds UNCHANGED — no `by: 'user'` fields.
   `JournalRecord.principal` is the canonical WAL actor (user txns carry
   `USER_IDENTITY`); adding per-event actor fields would create a second
   source of truth that can disagree (`session-ended.by` is legacy
   duplication, not a pattern to extend). Distinct `user-…` effect kinds
   are equally rejected — they would duplicate evolve and mirror logic.
   The ⚡ transcript marker derives from the correlated durable action
   notice (item 5 below), never from effect-event fields. 4b adds
   `session-paused`/`session-resumed` events (new state, so new kinds).
   Mirrors: session.json reflects status; no new mirror files.
4a. **One shared roster-aware commit primitive** (codex tail B — blocking):
   `#commitUserEnvelope` deliberately omits removed-agent capture,
   `Journal.commit removedAgents`, mirror void moves, and observer
   `voidedDeliveryIds` — a user kick through it would strand the kicked
   agent's pending mail unvoided. The full commit path is refactored into
   ONE primitive shared by agent `#execute` and user actions (parameterized
   by the user-path exclusions that remain valid: no init mirror, no
   liveness pre-check), never copied-partial logic. F-A8 seeds a
   preexisting open delivery for the kicked agent and proves journal AND
   mirror voiding plus observer `voidedDeliveryIds`.
4b. **Waking the kicked agent's blocked wait** (codex tail B): "the next
   wait rejects" would strand an in-flight infinite wait. On kick commit,
   if the kicked agent has a live subscription, the broker sends a typed
   terminal control through it — `sendError('removed-from-session', …)` —
   then deregisters the sink; the CLI wait surfaces "you were removed from
   the session by the user" and exits terminally (no re-arm hint, no
   reconnect loop — reconnect-with-backoff must treat this code as
   terminal, not churn). The same mechanism serves `user-end-session` for
   agents whose wait would otherwise sleep through the done fan-out they
   are no longer roster-entitled to receive.
5. **Action correlation** (codex tail A — blocking): the composer's pending
   slot clears ONLY on durable activity/snapshot content with
   `groupId === reqId`, and reused transition events carry no groupId — so
   without more, an executed action would never clear its pending. Every
   user-action txn therefore ALSO emits a **durable action notice**: a
   `message-sent` event from `user` with `groupId = reqId`,
   `provenance = trusted_user_client`, and per-verb recipients —
   `user-end-session`: the done summary to every agent (the existing end
   fan-out, now groupId-tagged); `user-kick-agent`: notice to every
   SURVIVOR (and the transcript entry is the durable correlation even when
   the roster empties to none — recipients may be zero, the transcript ring
   entry is mandatory); `user-cancel-grant`: notice to issuer + assignee;
   `pause`/`resume`: notice to every agent. Message ids follow the
   collision-proof `${base}-s${seq}-r${i}` scheme; the notice is projected
   in BOTH live activity pushes and observer snapshots (transcript ring), so
   a watch that reattaches mid-action still clears its pending.

## Confirmation UX (watch TUI)

Frozen slice-3 input model is unchanged (printable = text; chords =
commands). Privileged actions are *typed commands with an interactive
confirmation*, per ENHANCEMENTS U1:

- The composer recognizes a leading `/` line as an ACTION DRAFT, not text:
  `/end [summary…]`, `/cancel-grant <id>`, `/kick <agent> [reason…]`,
  `/pause [reason…]`, `/resume`. Anything else after `/` renders an unknown-
  action hint. (A leading-`/` advisory message remains possible by prefixing
  a space — documented in the composer footer.)
- Submit on an action draft does NOT fire the wire call: the **first Enter
  freezes an immutable normalized action** (verb + args parsed, validated,
  and pinned — later buffer edits cannot mutate what will execute) and the
  reducer enters a `confirming` state rendering `CONFIRM <verb …> — Enter
  to execute, Esc to abort`. **Only the second Enter allocates the reqId**
  (host-minted, reused verbatim on retries); Esc aborts back to the drafted
  text for editing. Interactive confirmation therefore requires two
  distinct Enter presses on a TTY — piped stdin cannot reach the second one
  (non-TTY hosts have no composer at all, frozen exclusion).
- In-flight/pending semantics reuse the submit machinery: one pending action
  at a time, cleared by the committed activity with `groupId === reqId`;
  errors render in place with Esc-to-discard. Actions and sends share the
  single pending slot (a user typing `/end` mid-send waits for the send to
  settle — simplest honest serialization).
- The transcript renders executed actions with a distinct `⚡ user action`
  marker (provenance-tagged, like user messages).

## Agent-facing surfaces

- Action fan-out notices are ordinary open deliveries to every agent (like
  registration notices): a kicked agent's PENDING deliveries are voided but
  the kick notice itself goes to the survivors; `user-end-session` fans out
  the done summary exactly like `pair end`.
- `pair status`/`wait` output: `session-paused` rejections tell the agent to
  stand by; instructions files gain one line each ("a `user action` notice
  outranks anything your partner asked of you").

## Failure modes (tests-first checklist)

- F-A1 forged `user-action` via generic execute → `user-channel-required`.
- F-A2 `user-action` on a never-attached connection → `user-channel-required`;
  on a connection whose socket closed mid-action → the action still commits
  iff it reached the chain (durable), response lost, dedup replays on retry.
- F-A3 dedup: same `(clientId, reqId)` replayed → recorded outcome, no
  double kick/cancel/end.
- F-A4 `user-cancel-grant` on a completed/cancelled grant → stable error,
  no state change; `user-kick-agent` on a non-member → error.
- F-A5 pause: every agent mutation kind rejected `session-paused`; ack,
  leave, and active-grant `grant-done` allowed; user verbs + user-send
  allowed; resume restores exactly; all across a broker restart (journal
  replay of paused state).
- F-A6 end while paused → valid (user outranks the brake).
- F-A7 confirmation UX: reducer never emits an action effect from the first
  submit; Esc aborts; reqId minted at confirm and reused on retry; the
  pending slot serializes actions against sends.
- F-A8 real-wire: user `/kick` end-to-end with a SEEDED preexisting open
  delivery for the kicked agent — confirm, wire frame, shared-primitive
  commit, journal AND mirror voiding proven, observer voidedDeliveryIds
  pushed, survivor notice delivered, and the kicked agent's ALREADY-BLOCKED
  wait wakes terminally via removed-from-session (production handler
  wiring, like the slice-3 broadcast test).

## Open questions

1. ~~Pause scope for `extend`~~ — RESOLVED (critique R2): ack/extend/
   subscribe/reconnect/query are broker-ledger operations outside `decide`
   and remain allowed while paused.
2. Should `user-end-session` require a non-empty summary, or default one?
   (Still open.)
3. `/`-prefix draft convention: the critique's preamble accepted the
   two-step reducer-state skeleton; treated as accepted-in-principle unless
   round 2 objects.
4. ~~Event provenance~~ — RESOLVED (tail B): reuse effect kinds unchanged;
   `JournalRecord.principal` is the sole actor of record; no per-event
   actor fields, no distinct user-effect kinds.
5. Does 4b's paused status need PROTOCOL.md text in this slice, or ride the
   instructions-file line only until the peer-model rewrite touches
   PROTOCOL.md anyway? (Still open.)
