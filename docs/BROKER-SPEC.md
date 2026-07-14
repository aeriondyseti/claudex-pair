# claudex broker specification (rev 2 — post codex design review)

## Identity & discovery
- Pipe name: `\\.\pipe\claudex-<sha256(normalized repo root)[0..15]>-e<epoch>` (Windows);
  `$XDG_RUNTIME_DIR/claudex-<hash>-e<epoch>.sock` elsewhere. The epoch suffix makes the
  endpoint handshake part of election: clients discover the current endpoint (and epoch)
  from the lease record, so a deposed broker's stale pipe can never be confused with the
  incumbent's.
- **Election (endpoint-as-lock)**: the broker's lifetime lock is **binding the
  fixed election endpoint** `claudex-<hash>-lock` (named pipe on Windows, unix
  socket elsewhere) — libuv binds are first-instance-exclusive (losers get
  EADDRINUSE) and the bound handle dies with the process: held for the
  broker's entire lifetime, never stealable, released automatically on
  process death. (Node/Bun cannot hold a true OS-exclusive FILE lock —
  fs.open cannot reach Windows share modes — so the endpoint is the lock; see
  the W2 gateway contract section for the decision record.) Unix stale
  election sockets use the F13 probe/unlink flow; Windows pipe names are not
  filesystem entries and cannot go stale.
  `.pair/broker.lease` is **only the discovery/heartbeat record**, written by
  the lock winner via atomic replace: {processStartTime, pid, nonce, epoch,
  endpoint, heartbeatAt}.
  - Heartbeat: broker rewrites heartbeatAt every 10s.
  - **A held bind is never stolen.** A candidate that cannot bind but observes
    heartbeat older than 60s reports the incumbent as **hung** and performs
    **fencing by verified termination**: kill exactly the recorded
    {pid, processStartTime, nonce} identity (refusing if the identity no longer
    matches — PID reuse); the dead process's election binding vanishes with it,
    and the candidate acquires normally with epoch+1. If termination
    is not permitted, surface "broker hung" to the human instead of proceeding.
  - Every wire message carries the sender's expected epoch; requests bearing an old
    epoch are rejected with `stale-epoch` (client re-discovers and retries). Epochs
    protect clients from stale endpoints; the single-writer guarantee comes from the
    lifetime lock + fencing, never from epochs alone.
- `.pair/broker.token` — 32-byte random capability, user-only perms; **generated and
  written only by the process that holds the lease lock, immediately after
  acquisition** (racing spawns must never overwrite a live token). Clients read and
  present it. (U1 later: separate user-channel token outside repo.)

## Storage (journal is authoritative; legacy files are materialized views)
- `.pair/journal/segment-NNNNNN.jsonl` — one **transaction record** per line:
  `{seq, txn: {clientId, reqId}, envelopeId, principal, at, events: Event[],
  deliveries: DeliveryId[], outcome, crc32}` — fsync before ack. `outcome` is the
  serialized wire response (ok, seq, event summaries) so a replayed retry returns
  byte-equivalent results.
  - **Durable idempotency — committed successes only.** The (clientId, reqId) pair,
    committed seq, and outcome live in the record; recovery reconstructs the dedup
    index from the journal, so a retry after crash-before-ack replays the recorded
    outcome instead of re-appending (F2). **Rejections are not journaled**: a rejected
    command made no state change (decide is pure), so re-evaluating a retried
    rejection is safe by construction — and may legitimately return a different
    answer if state moved. The retry guarantee is therefore scoped: *effectful
    commits are exactly-once; rejections are re-evaluated.* Dedup eviction is
    snapshot-defined (last N txns per client + horizon seq); older reqIds answer
    `expired-request` rather than silently re-executing.
- **Delivery ledger (journaled, not in-memory)**: every message fan-out creates
  deliveries with stable identity `deliveryId = <messageId>:<recipient>`. Two event
  kinds in the same journal: `delivery-enqueued {deliveryId, deliverySeq}` (part of the commit
  txn) and `delivery-acked {deliveryId, by-clientId}` (its own txn). **Leases are
  ephemeral projections** — only enqueue/ack are durable; on restart every enqueued,
  un-acked delivery is redelivered (F4/F11). Subscription resume uses a **delivery
  cursor** (`afterDeliverySeq`), not commit seq — one commit can fan out many deliveries.
- `.pair/journal/snapshot.json` — atomic-replace compaction: {state, lastSeq,
  dedupWindow, openDeliveries}. Segment rotation and snapshot writes must be
  crash-safe at every boundary (F12): write-new → fsync → rename → only then trim.
- **Mirrors** (session.json, inbox/*.md, archive/, grants/*.json) are broker-written
  views updated AFTER ack. A journaled `delivery-acked` is what moves a message's
  mirror from `inbox/` to `archive/` — the ack IS the consume event, so `watch`
  and `status` mirrors never show already-claimed messages as pending.
  `.pair/journal/mirror-manifest.json` records {mirroredSeq, per-file content hashes}.
  Recovery rule (ordered — a crashed broker's own partial mirror update is LAG,
  never tamper):
  - **manifest.mirroredSeq < journal head → full mirror rebuild, unconditionally.**
    Hashes are not consulted: a crash between mirror writes and the manifest replace
    legitimately leaves mismatched hashes behind. (Implementation may instead use
    generation directories + an atomic pointer swap.)
  - **Tamper is only judged at parity**: manifest head == journal head AND hashes
    mismatch → content divergence → read-only conflict state + doctor (rev-7 rule).

## Wire protocol (newline-delimited JSON over the pipe)
- Request: {reqId, token, epoch, clientId, as, kind:'execute', envelope} →
  {reqId, ok, seq, events | error{code,message}}.
- Retry contract: a retried **committed** request replays its recorded outcome (never
  a second execution); a retried **rejected** request is re-evaluated against current
  state (safe: rejections made no state change).
- Subscribe: {kind:'subscribe', as, afterDeliverySeq} → pushes
  {kind:'delivery', deliverySeq, deliveryId, message}. `deliverySeq` is a monotonic
  ledger offset assigned at enqueue — the ordered cursor; `deliveryId`
  (messageId:recipient) is identity for ack/dedup, not ordering.
  `afterDeliverySeq` is the client's last ACKED cursor (never merely
  observed — print-then-crash must redeliver, F14). **Open/unacked beats
  cursor**: on subscribe the broker ALWAYS first redelivers every open
  delivery for the agent regardless of cursor (out-of-order acks can leave
  seq 9 open while seq 10 is acked — a cursor of 10 must not suppress 9),
  then streams new deliveries after the cursor; the cursor suppresses only
  already-closed history. A fresh client passes 0. Client acks
  {kind:'ack', deliveryId} within the lease (default 90s, extensible via
  {kind:'extend', deliveryId}) or the broker redelivers (at-least-once; consumers
  dedup by deliveryId).
- Queries: {kind:'query', what:'status'|'log'|...} → DTO (includes liveness: per-agent
  connectedSince, lastActivity, broker pid/epoch/heartbeatAt).
- **Client ack contract (implementer trap)**: `pair wait` must write the delivered
  message to stdout AND flush before sending `ack` — ack-then-crash-before-print
  would lose the message to the agent forever, defeating at-least-once end to end.

## Lifecycle
- CLI: connect → on ECONNREFUSED/absent, spawn detached broker, await readiness
  (lease + endpoint ping) with bounded backoff, then retry once; two spawns race → the
  OS lock picks the winner, loser connects to the winner's endpoint (F3).
- Idle exit: no connections AND no in-flight txn AND no enqueued-unacked delivery,
  sustained through grace (60s) → flush, release lock, exit. Restart is transparent (F9).
- Recovery: acquire lock → load snapshot → replay tail (crc-validated; a torn TAIL
  truncates, corruption mid-history refuses start with doctor guidance, F1/F6) →
  rebuild dedup index + open-delivery set → reconcile mirrors via manifest → open pipe.
  Commands during recovery fail loudly ('broker recovering, retry').

## Commit path (single writer)
receive → authenticate token+epoch → dedup check → decide(state, envelope) →
append txn record (events + delivery enqueues) + fsync → evolve in-memory →
ack requester → update mirrors + manifest → push deliveries to subscribers.

## Turn revocation (ENHANCEMENTS 8a — in scope)
- `revoke-turn` is an ordinary execute envelope through the single-writer commit
  path; `decide` authorizes it (principal == driver, partner holds the turn, session
  active). The broker contributes the liveness fact the pure core cannot know:
  revocation is admitted only when the navigator has **no live delivery lease** —
  an active lease/heartbeat means "still working" and rejects with `partner-active`;
  a missing listener or expired lease admits it. The elapsed-since-turn-pass timeout
  is CLI-side policy (when the driver *offers* to revoke); the broker/core check is
  the authorization.
- Serialization answers the race for free: a navigator reply and a driver
  `revoke-turn` are two envelopes through the same commit path — first commit wins,
  the loser is decided against post-commit state. A reply bearing a revoked turn is
  rejected as a turn mutation and archived as advisory (`stale-turn`), so there is
  never a double turn holder.
- The `turn_revoked` event fans out as a normal delivery to the navigator (same
  ledger, same at-least-once semantics) and lands in the archive mirror — no silent
  turn theft.

## Session end & roster lifecycle (ENHANCEMENTS 11 — in scope)
- **End is driver authority**: `decide` authorizes `end-session` — and the raw
  `send -Type done` completion path — as principal == driver, rejecting otherwise
  with `end-not-driver`. This supersedes the pair.ps1 parity behavior (any
  participant could complete the session); a navigator signals completion via
  propose-end, never done-send. End fan-out and the F10 end-vs-grant race are
  unchanged.
- **Leave / join / kick are journaled roster mutations** (user rule — the roster
  itself changes; there is no presence flag): `agent-left` / `agent-joined` /
  `agent-kicked` events. Voluntary leave is rejected while the agent holds an
  offered/active grant (`leave-with-grant`); leaving while holding the turn
  returns the turn to the driver **in the same committed txn**. Kick is
  driver-only forced removal: the same txn cancels the kicked agent's open
  grants, and the driver reassigns by reissue. **Roster authority is the
  driver's uniformly**: `pair init` must be issued as the agent that becomes
  driver (`init-not-driver` otherwise — new guard; decideInit currently checks
  no principal), and every later join is driver-admitted — membership is
  driver-chosen at every point in the session's life. The driver can neither
  leave nor be kicked; handoff first. A kick that empties the navigator roster
  leaves a valid solo session (leave-to-reset-and-rejoin is a supported
  recovery flow); the CLI prompts the driver to end unless a rejoin is
  expected.
- **Removal voids undelivered deliveries**: enqueued deliveries for a removed
  agent are closed to the archive in the same txn — never delivered to a
  non-participant, never held for a possible return. A rejoined agent is a fresh
  roster entry with a fresh delivery cursor; context catch-up is rehydrate
  (ENHANCEMENTS item 10), not redelivery.
- Pair-scope roster lives in the session.json `agents[]` mirror; M1's registry
  versioning / `registry_updated` generalization stays deferred.

## Failure test matrix (write these FIRST)
F1  kill -9 mid-append → restart truncates torn tail, state consistent
F2  crash after fsync before ack → retry with same (clientId, reqId) replays recorded
    outcome from the journal-rebuilt dedup index; no double event
F3  double spawn race → OS lock yields exactly one holder; loser connects
F4  client dies with unacked delivery → lease expiry → redelivery to next wait
F5  duplicate wait (same identity, two connections) → each delivery acked exactly
    once; out-of-order ack (10 acked, 9 open) then resubscribe with cursor 10 →
    open seq 9 is redelivered (open/unacked beats cursor)
F6  journal crc corruption mid-history → refuse start with doctor guidance
F7  hung broker (lock held, heartbeat stale) → fencing by verified termination of the
    exact {pid, startTime, nonce} identity, then normal acquisition with epoch bump;
    identity mismatch (PID reuse) → refuse and report; termination unavailable →
    "broker hung" surfaced, no takeover
F8  mirror states: manifest behind journal head (incl. mismatched hashes from the
    broker's own partial update) → unconditional rebuild; divergence AT parity →
    read-only conflict state
F9  idle shutdown vs racing new connection → connection wins or clean respawn
F10 end-vs-grant-accept race → broker-serialized, grant mutation rejected post-end
F11 broker crash/restart with outstanding unacked deliveries → all redelivered from
    the durable ledger, none lost, none duplicated post-ack
F12 crash at snapshot/segment-rotation boundaries → recovery from either the old or
    new artifact, never a mixed state
F13 stale Unix socket after kill -9 → bind gets EADDRINUSE → probe: connection
    refused ⇒ unlink dead socket and bind; connection accepted ⇒ live broker, back off
F14 client ack-ordering, both boundaries: (a) wait crashes after receiving a delivery
    but before printing → no ack was sent → redelivery, nothing lost; (b) wait crashes
    after stdout flush but before ack → redelivery produces a duplicate print →
    consumer dedups by deliveryId; the invariant under test: ack is sent only after
    stdout write+flush returns; (c) resume after either crash serves every still-open
    delivery regardless of the presented cursor (open/unacked beats cursor)
F15 revoke-vs-reply race → broker-serialized: whichever envelope commits first wins;
    the late reply is archived advisory (`stale-turn`), never a turn mutation — at no
    point do two agents hold the turn
F16 revoke attempt while the navigator holds a live delivery lease (heartbeating) →
    rejected `partner-active`; after lease expiry with no ack, the same revoke commits
F17 navigator leaves while holding the turn → turn returns to the driver in the same
    committed txn; a post-rejoin reply bearing the old turn is stale (per F15)
F18 leave/kick with enqueued undelivered deliveries → voided to the archive in the
    same committed txn; nothing is ever delivered to a removed agent; a later
    rejoin starts from a fresh delivery cursor (no stale redelivery)
F19 navigator end-session or done-send → rejected `end-not-driver`; the rejection
    makes no state change and is not journaled (retried rejections re-evaluate per
    the retry contract)
F20 voluntary leave while holding an offered/active grant → rejected
    `leave-with-grant`; after grant-done or a driver cancel, the same leave commits
F21 kick of a grant-holding navigator → open grants cancelled in the same committed
    txn (the stop-notice to the kicked agent is voided with its other deliveries);
    grant scope/worktree ownership released; driver reissues to reassign
F22 init issued by a principal other than the declared driver → rejected
    `init-not-driver` (roster authority is uniform from session creation onward)

## W2 gateway contract (frozen 2026-07-14, claude+codex, pre-branch checkpoint)
- **The authority boundary is the COMMAND, never client-decided events.**
  `src/app/ports/gateway.ts` (ProtocolGateway) is the single mutation surface:
  execute(command + principal + RequestIdentity) → authoritative outcome
  (post-commit session, events, receipt, seq); query DTOs (StatusDto, log);
  subscribe(as, afterDeliverySeq)/ack/extend. The broker stamps envelope meta
  (id, at) and runs decide+commit itself; an IPC ProtocolStore shipping
  client-decided events would be a stale-state TOCTOU and is forbidden. File
  mode adapts the same gateway to local use-cases; core untouched.
- **Response is the read.** Execute/query responses are authoritative; the CLI
  never reads `.pair/` mirror CONTENT after an ack to produce output. Two
  defined exceptions: findRoot may probe for `.pair/session.json` EXISTENCE
  (root discovery, content untrusted), and read-only diagnostics (`status`,
  `log`, `watch`, `doctor` in fs-diagnostic mode) report the journal
  head/epoch they saw and may lag.
- **Discovery/spawn**: client resolves the daemon entry the same way the shim
  resolves the CLI — `bun run src/apps/broker/main.ts` when bun exists, else
  `dist/pair-broker.exe` — spawns detached with stdio ignored, then awaits
  readiness (lease record present + endpoint ping ok) with bounded backoff
  (100ms doubling, 5s deadline), retries the connect once. Double-spawn: the
  OS lease lock picks the winner; the loser's spawn idles out or exits on
  lock-acquire failure, and the client connects to the recorded endpoint.
- **Client identity**: clientId = crypto.randomUUID() once per CLI process;
  reqId unique per logical request and reused verbatim across reconnect
  retries. Dedup scope is the journal's per-client window; expired reqIds
  answer `expired-request`.
- **Broker stop semantics**: `pair broker stop` is a clean shutdown at any
  time, as a DRAIN transition: stop accepting new execute/subscribe → finish
  the in-flight txn (fsync) → respond to the stop requester → close
  connections → release the lease → exit. Unacked deliveries are NOT a
  blocker: the ledger is durable and redelivers on next start (F11).
  `pair broker status` reports lease/epoch/pid/heartbeat + connection count
  without mutating anything. Control surface is `BrokerControl`
  (gateway.ts) — separate from ProtocolGateway because it exists
  pre-session.
- **Election primitive (approved revision of Identity & discovery's
  file-lock wording)**: Node/Bun expose no true lifetime OS file lock
  (fs.open cannot reach Windows share modes), so **the endpoint IS the
  lock**: election = binding the fixed election name
  `claudex-<hash>-lock` (named pipe on Windows, unix socket elsewhere).
  libuv pipe binds are first-instance-exclusive (EADDRINUSE for losers) and
  the handle dies with the process — exactly the "held handle, never stolen,
  released on death" semantics the spec requires, with zero new
  dependencies. Unix stale-socket staleness uses the existing F13
  probe/unlink flow; Windows pipes are not filesystem entries and cannot go
  stale. The lease RECORD (.pair/broker.lease: {pid, processStartTime,
  nonce, epoch, endpoint, heartbeatAt}) remains a plain JSON file written by
  the lock winner via atomic replace; the serving endpoint keeps its
  epoch-suffixed name. Fencing is unchanged: a candidate that cannot bind
  but observes a stale heartbeat performs verified termination of the exact
  recorded identity, after which the dead process's election binding has
  vanished and normal acquisition proceeds with epoch+1.
- **Config injection**: the composition root takes a BrokerConfig
  {idleGraceMs=60000, heartbeatMs=10000, deliveryLeaseMs=90000}. Env override
  CLAUDEX_BROKER_IDLE_GRACE_MS is accepted only if it parses to an integer in
  [1000, 60000] — tests may only SHORTEN idle grace, never extend it. Tests
  must stop/await the daemon in finally; leaked daemons are test bugs.
- **F9 joint spec (decisive race is server-side)**: idle-exit must stop
  accepting atomically BEFORE the final no-connections/no-unacked check; a
  connection landing after the check finds the endpoint closed and triggers
  the client's normal spawn-on-demand retry (connection wins or clean
  respawn — never a hung client, never two brokers). Codex owns the
  client-driven storm test; the server-side ordering is claude's to
  implement per this clause.

## Non-goals now
- No topology changes (still pair semantics), no user channel (U1), no multi-repo broker.
- No compaction policy beyond snapshot-on-threshold + segment rotation.

## Layer placement
- src/adapters/ipc/ — pipe transport client+server (ports: Transport)
- src/broker/ — journal, election, delivery ledger, server loop, mirrors (hosts app use-cases)
- src/apps/broker/main.ts — daemon composition root
- src/apps/cli/bind.ts → replaced by broker-client binding (spawn-on-demand); fs bind
  retained ONLY for read-only diagnostics path
