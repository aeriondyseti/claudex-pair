# Throughput sprint — measure, cut wake latency, break the review serialization

> **Status: SHIPPED 2026-08-02** (T1–T5, five commits). Deviations from this
> design: none material — the wait drain (T3) was added beyond spec so a
> batch costs the recipient one wake; T4 review findings use a lightweight
> state-resident request/gate pair (`reviewRequests`/`reviewGates` on
> SessionBase) instead of extending the planning finding machine — one
> lifecycle rule, no cross-phase coupling; the planning-finding reuse
> remains open for the peer implementation phase (slice 4+).

Sprint goal: increase the speed of cooperative development by (A) making the
protocol's time costs measurable, (B) cutting per-exchange latency and
re-orientation cost, and (C) letting the driver keep working while reviews are
in flight. Slices are T1–T5. Anchors reference HEAD `1acea35`.

## Scoping discovery (changes the plan)

**Broker mode is already event-driven.** `pair wait` in broker mode blocks on a
socket-push subscription (`waitOnSubscription`, `src/apps/cli/brokerCli.ts:318-380`;
`BrokerCore.#push`, `src/broker/server.ts:547-564`) — there is no poll loop and
delivery latency is already sub-second. The only polling left is fs mode
(`waitForMessages`, `src/app/usecases.ts:139-158`, 2 s default) and the fs-mode
watch dashboard. Since broker is the default runtime (`src/apps/cli/main.ts:108-118`),
the "event-driven wake" idea from the brainstorm is **already shipped** for the
common path. The sprint therefore spends B's budget on the two latency costs
that remain: re-orientation on wake (T2) and round-trip count (T3). An fs-mode
`fs.watch` accelerator is a stretch item only (notification-only per the
"events accelerate, files decide" rule, ENHANCEMENTS.md).

## T1 — `pair stats`: WAL-derived session throughput metrics

Measure first; T2–T4 are judged by these numbers.

**Shape.** A read-only diagnostic verb like `status`/`log` (permitted to read
`.pair/` directly per the broker architecture's diagnostics rule). It replays
the journal client-side and folds events into a report; no broker changes, no
new events, no `decide` involvement.

- New pure module `src/core/stats.ts`: `foldStats(records: JournalRecord[]) → SessionStats`.
- CLI verb `pair stats [-Json] [-Session <id>]` wired as a read-only branch in
  `brokerCli.ts` (beside `log`, line 260) with fs fallthrough that reports
  "journal required" (fs mode has no WAL — `bind.ts` applies events directly).

**Metrics (v1).**

| metric | source |
|---|---|
| turn-hold duration per agent, per turn + distribution | `turn-passed` carries no `at` (`events.ts:104`) — use the enclosing `JournalRecord.at` (`journal.ts:19-49`); hold = gap between consecutive turn-moving records |
| ask → resolution latency | awaiting entries' `sentAt` (`awaiting.ts:31-54`) vs the resolving record's `at`; ms precision available from message-id prefixes where needed (`clock/index.ts:14-16`) |
| round-trips per session / per hour; messages by type | `message-sent` fold |
| wait-vs-work ratio per agent | share of wall-clock holding the turn vs waiting (planning phase: convergence-turn events) |
| time blocked on human | `attention-raised` → `attention-cleared` spans |
| planning cost | barrier open→reveal span, rounds to ballot, findings filed/resolved counts |
| open-ask ages right now | live awaiting set (already surfaced in `StatusDto`) |

**Known precision limit.** `formatTimestamp` is second-granularity local time
with no timezone (`clock/index.ts:9-11`). Fine for turn holds and review
latency; do NOT try to measure delivery latency with it. Changing the timestamp
format is out of scope (it's load-bearing across the codec); note it as debt.

**Acceptance.** Run `pair stats` against a real archived session journal from
the peer-slice development sessions and get a correct wait-vs-work report;
golden-file test over a synthetic journal covering turn revoke, kick, and
thread-tagged asks (the awaiting edge cases in `awaiting.ts:35-48`).

**Size:** M. No protocol surface, pure fold + rendering.

## T2 — Wake packets: orientation digest at delivery

Cut the cost of the waking agent's first minutes: today `INCOMING` prints name +
raw body (`printDeliveryThenAck`, `src/apps/cli/brokerWait.ts:13-20`) and
`renderTurn` prints turn/role/status (`brokerCli.ts:414-424`). Everything else
is archaeology the agent repeats on every wake.

**Content of the digest (rendered under the delivery, before the turn line):**

1. **Protocol orientation** — open asks you owe / are owed (awaiting set with
   ages), session phase/substate, whose turn, unresolved HIGH/MED findings
   count. All already available server-side (`StatusDto`, `server.ts:1155`).
2. **Sender-declared git context** — this is ENHANCEMENTS item 16 (git-aware
   review requests), folded into this slice: `pair send`/`ask` gains
   `-Base <ref> -Head <ref>` (plus optional `-Paths a,b,c`) carried as header
   fields; the digest renders them as a "review scope" line. Sender-declared,
   never broker-computed — the broker does not run git (keeps it out of
   workspace business per the architecture's "coordination ≠ workspace safety").
3. **Memory pointer** — memory.md byte length + mtime delta since your last
   activity ("memory.md grew since you last held the turn"), so re-reading is
   triggered only when needed.

**Where it attaches.** Server computes (1) per-recipient at push time
(`#push`, `server.ts:547`) and rides the envelope built in `#toStored`
(`server.ts:1172-1189` — the single wire-envelope constructor); client renders
in `printDeliveryThenAck`/`renderTurn`. Header codec change is
backward-compatible (same pattern as `reply_to`/`session_id`).

**Acceptance.** A resumed wait after 30 minutes idle prints a digest that lets
the agent act without running `pair status`, `pair log`, or re-reading an
unchanged memory.md; e2e test asserts digest fields on a two-agent exchange;
codec round-trip tests for the new headers.

**Size:** M. Touches codec, server push, CLI render; no `decide`/`evolve` change
except the pass-through of the new optional headers.

## T3 — Batched asks: n questions, one wake

The threading layer already supports n asks in flight with deterministic
resolution (`awaiting.ts`, `reply_to`). What's missing is ergonomics and the
wait-exit rule, not protocol:

- **Batch send.** `pair ask -Batch <file|- >` — a markdown file with `##`-headed
  items becomes n `ask` messages committed in one broker txn (one delivery
  each, shared `groupId` header), the last one carrying the turn pass, earlier
  ones `turn: keep`. Mechanically each is an ordinary ask; no new event kinds.
- **All-threads fused wait.** The fused wait currently exits when *the one*
  `fusedThread` resolves (`brokerCli.ts:93-100, 362-377`). Batch send fuses
  with the full id set and exits only when the journal's awaiting set clears
  all of them (`-Threads a,b,c` on standalone `wait` for re-arm; timeout hints
  preserve the set).
- **Batch answer.** `pair send -Type answer -ReplyTo <id>` already targets one
  item; add `pair answer -Batch <file>` symmetric to batch send (items map to
  `reply_to` ids in order, validated against the open set — a count mismatch is
  a hard error, not a guess).

**Guardrail.** The "one decision per ask" conduct rule becomes "one decision
per *item*" — update PROTOCOL.md's rules of conduct in this slice.

**Acceptance.** Two agents exchange a 3-item batch as exactly two wakes
(one per side); e2e test; awaiting-set invariants covered for partial answers
(answer 2 of 3 → wait keeps blocking, status shows the remaining debt).

**Size:** M.

## T4 — Pipelined review: async review requests with a consent window

The structural fix. Today a review checkpoint is a full stop: the fused send
blocks the driver until the verdict lands. The block is **CLI control flow, not
protocol** — turn enforcement only rejects *turn-passing* sends from
non-holders (`decide.ts:1513-1520`); `-Turn keep` traffic is legal from anyone.
So the mechanics are nearly free; the slice's substance is the review
lifecycle, the gate rules, and the lapse timer.

**Model.**

- **`pair ask -Review -Async`** sends the review request `turn: keep` and does
  not fuse: the driver keeps the turn and keeps working. The request registers
  in the awaiting set as today, flagged as a review thread (new optional header
  `review: async`, pass-through codec).
- **The navigator's verdict** comes back as `review`, `turn: keep`, carrying
  **structured findings**: reuse the severity × agreement finding vocabulary
  from planning (`types.ts:223-246`) with a new anchor form
  `{kind: 'code', base, head, path?}` alongside the existing draft/proposal
  anchors. Findings are journaled via the existing `finding-filed` family so
  the settled/unsettled machinery (`isFindingSettled`, `decide.ts:609-613`)
  works unchanged.
- **The gate.** Async review is consent-based: LOW findings never block; the
  driver must resolve HIGH/MED findings before the session's next *gate point*
  — `handoff`, `end`, and (when peer slices land) merge-request. Enforced in
  `decide` (same pattern as the planning yield gate `unanswered-findings`,
  `decide.ts:586-591`): `handoff`/`end` rejected while unresolved HIGH/MED
  code-anchored findings exist. A driver who wants a hard stop uses today's
  fused blocking ask — blocking review remains available and is still the
  right call for risky changes.
- **The consent window (lapse timer).** An async review request unanswered
  past a deadline (default 15 min, set per-request `-LapseSec`) fires a
  broker-authored `review-lapsed` event via the existing deadline watcher
  (`server.ts:593-629`, built for barrier deadlines): the ask resolves as
  **lapsed-consent, recorded with policy provenance** — never a silent drop.
  It appears in the transcript and in `pair stats` (T1 counts lapse rate; a
  high lapse rate means the navigator is overloaded or the window is too
  short). The user-channel can veto a lapse resolution retroactively by
  raising it as an ordinary message — no new privileged verb.

**New protocol surface** (full verb-wiring path per
`args.ts` → `brokerCli.ts` → `commands.ts` → `decide.ts` → `events.ts` →
`evolve.ts` → `COMMAND_KINDS` allowlist `server.ts:42-49` → HELP): the
`review: async` header, code-anchored findings, `review-lapsed` event, and the
two gate checks. No new turn semantics — the turn token is untouched; pipelining
falls out of `turn: keep` + the gate.

**Acceptance.** E2e: driver sends async review request, immediately performs
another edit-and-commit increment, navigator files one MED finding, driver's
`handoff` is rejected until the finding is resolved, then passes. Second e2e:
request lapses → `review-lapsed` journaled with provenance → `handoff` passes.
Unit coverage for gate interaction with revoke/kick (findings survive holder
changes — they key on the session, not the turn).

**Size:** L. The one slice with real `decide`/`evolve` surface; sequence it
after T1 so its effect is measurable and after T2/T3 only if capacity requires
serialization (no hard dependency).

## T5 — Instruction + conduct refresh (ships with T3/T4, not after)

The instruction files are hand-written prose, read by the agent harnesses at
runtime, with no drift tooling (`instructions/*.md`; the `/pair` skills that
point at them live *outside* this repo and must be updated in the same pass).

- Update `claude-pairing.md`, `codex-pairing.md`, `agy-pairing.md`, and
  PROTOCOL.md for: batch asks, wake-packet reading ("trust the digest; don't
  re-run status on every wake"), async review + gate rules, and the blocking
  fallback.
- **Standing-work menu for waiters** — new conduct section: while blocked on
  `wait`, a navigator runs the test suite, pre-reads the announced area,
  drafts the review checklist against the declared `-Base/-Head` scope. Zero
  code; converts paid-for idle tokens into review prep.
- Note (not fix) the existing debt: instruction files still document the
  PowerShell shim invocation; no version/drift check exists.

**Size:** S, but gate T3/T4's "done" on it — a protocol feature the
instructions don't teach effectively doesn't exist.

## Explicitly deferred

- **Claims-first pair mode** (both agents claiming disjoint tasks by default)
  — depends on the claims board, which is peer slice 3; revisit after it lands.
- **fs-mode `fs.watch` accelerator** — stretch only; broker mode already
  pushes, and fs mode is a legacy/fallback path.
- **Millisecond timestamps in the WAL** — codec-wide change; T1 works around
  it and records the debt.

## Sequencing

```
T1 (stats) ──────────────► T4 (async review)  [measure before/after]
T2 (wake packets) ──┐
T3 (batch asks) ────┴────► T5 (instructions; ships WITH T3+T4)
```

T1 first and alone (it also produces the baseline numbers from existing
session archives). T2 and T3 are independent of each other and of T4. T5 is
not a trailing slice — its instruction updates land in the same commits as the
features they describe.

## Rulings taken as defaults (flag if you disagree)

1. **Lapse default 15 min, lapsed-consent recorded with provenance** — chosen
   over "lapse pages the human" to keep humans off the critical path; stats
   watches the lapse rate.
2. **Git context is sender-declared, never broker-computed** — the broker
   stays out of the workspace.
3. **Async review reuses the planning finding machinery** (new anchor kind)
   rather than a parallel lightweight severity header — one state machine, one
   settled/unsettled rule, already tested.
4. **fs mode gets stats/wake-packets as "broker required" errors**, not
   degraded reimplementations.
