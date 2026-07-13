# claudex broker specification (rev 2 — post codex design review)

## Identity & discovery
- Pipe name: `\\.\pipe\claudex-<sha256(normalized repo root)[0..15]>-e<epoch>` (Windows);
  `$XDG_RUNTIME_DIR/claudex-<hash>-e<epoch>.sock` elsewhere. The epoch suffix makes the
  endpoint handshake part of election: clients discover the current endpoint (and epoch)
  from the lease record, so a deposed broker's stale pipe can never be confused with the
  incumbent's.
- **Election** (`.pair/broker.lease`): the broker opens the lease file with an
  **OS-exclusive lock held for its entire lifetime** — the open handle, not the file's
  existence, is the lease (survives PID reuse; releases automatically on process death).
  The record holds {processStartTime, pid, nonce, epoch, endpoint, heartbeatAt}.
  - Heartbeat: broker rewrites heartbeatAt every 10s.
  - **A held lock is never stolen.** (Renaming a file out from under an exclusive
    holder is not sound: Windows rejects it, and on POSIX the deposed broker keeps
    writing under the old inode — two writers.) A candidate that cannot acquire the
    lock but observes heartbeat older than 60s reports the incumbent as **hung** and
    performs **fencing by verified termination**: kill exactly the recorded
    {pid, processStartTime, nonce} identity (refusing if the identity no longer
    matches — PID reuse), then acquire the lock normally with epoch+1. If termination
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
  (messageId:recipient) is identity for ack/dedup, not ordering. Client acks
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

## Failure test matrix (write these FIRST)
F1  kill -9 mid-append → restart truncates torn tail, state consistent
F2  crash after fsync before ack → retry with same (clientId, reqId) replays recorded
    outcome from the journal-rebuilt dedup index; no double event
F3  double spawn race → OS lock yields exactly one holder; loser connects
F4  client dies with unacked delivery → lease expiry → redelivery to next wait
F5  duplicate wait (same identity, two connections) → each delivery acked exactly once
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
    stdout write+flush returns

## Non-goals now
- No topology changes (still pair semantics), no user channel (U1), no multi-repo broker.
- No compaction policy beyond snapshot-on-threshold + segment rotation.

## Layer placement
- src/adapters/ipc/ — pipe transport client+server (ports: Transport)
- src/broker/ — journal, election, delivery ledger, server loop, mirrors (hosts app use-cases)
- src/apps/broker/main.ts — daemon composition root
- src/apps/cli/bind.ts → replaced by broker-client binding (spawn-on-demand); fs bind
  retained ONLY for read-only diagnostics path
