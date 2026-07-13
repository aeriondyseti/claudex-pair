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
  - Heartbeat: broker rewrites heartbeatAt every 10s. A candidate that cannot acquire
    the lock but observes heartbeat older than 60s treats the incumbent as **hung**
    (alive-but-stuck brokers must not be immortal): it requests OS lock steal by
    breaking the handle via lease-file replace — atomic rename of a new lease written
    with epoch+1 — then verifies it now holds the exclusive lock on the new file.
  - Every wire message carries the sender's expected epoch; requests bearing an old
    epoch are rejected with `stale-epoch` (client re-discovers and retries).
- `.pair/broker.token` — 32-byte random capability, user-only perms; clients read and
  present it. (U1 later: separate user-channel token outside repo.)

## Storage (journal is authoritative; legacy files are materialized views)
- `.pair/journal/segment-NNNNNN.jsonl` — one **transaction record** per line:
  `{seq, txn: {clientId, reqId}, envelopeId, principal, at, events: Event[],
  deliveries: DeliveryId[], crc32}` — fsync before ack.
  - **Durable idempotency**: the (clientId, reqId) pair and the committed seq live in
    the record itself, so recovery reconstructs the dedup index from the journal; a
    retry after crash-before-ack replays the recorded outcome instead of re-appending
    (F2). Dedup eviction is snapshot-defined: the snapshot stores the retained dedup
    window (last N txns per client + horizon seq); anything older is answered
    `expired-request` rather than silently re-executed.
- **Delivery ledger (journaled, not in-memory)**: every message fan-out creates
  deliveries with stable identity `deliveryId = <messageId>:<recipient>`. Two event
  kinds in the same journal: `delivery-enqueued {deliveryId, seq}` (part of the commit
  txn) and `delivery-acked {deliveryId, by-clientId}` (its own txn). **Leases are
  ephemeral projections** — only enqueue/ack are durable; on restart every enqueued,
  un-acked delivery is redelivered (F4/F11). Subscription resume uses a **delivery
  cursor** (`afterDelivery`), not commit seq — one commit can fan out many deliveries.
- `.pair/journal/snapshot.json` — atomic-replace compaction: {state, lastSeq,
  dedupWindow, openDeliveries}. Segment rotation and snapshot writes must be
  crash-safe at every boundary (F12): write-new → fsync → rename → only then trim.
- **Mirrors** (session.json, inbox/*.md, archive/, grants/*.json) are broker-written
  views updated AFTER ack. `.pair/journal/mirror-manifest.json` records
  {mirroredSeq, per-file content hashes}. On recovery:
  - mirroredSeq < lastSeq with hashes matching the manifest → **expected lag**
    (normal crash ordering; silently rebuild mirrors forward);
  - hash mismatch at the same mirrored head → **content divergence = tamper** →
    read-only conflict state + doctor (rev-7 rule). Never conflate the two (F8).

## Wire protocol (newline-delimited JSON over the pipe)
- Request: {reqId, token, epoch, clientId, as, kind:'execute', envelope} →
  {reqId, ok, seq, events | error{code,message}}.
- Retry contract: same (clientId, reqId) always returns the original outcome (from the
  durable dedup index), never a second execution.
- Subscribe: {kind:'subscribe', as, afterDelivery} → pushes
  {kind:'delivery', deliveryId, message}; client acks {kind:'ack', deliveryId} within
  the lease (default 90s, extensible via {kind:'extend', deliveryId}) or the broker
  redelivers (at-least-once; consumers dedup by deliveryId).
- Queries: {kind:'query', what:'status'|'log'|...} → DTO (includes liveness: per-agent
  connectedSince, lastActivity, broker pid/epoch/heartbeatAt).

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
F7  hung broker (lock held, heartbeat stale) → steal via lease replace, epoch bump,
    old-epoch requests rejected; PID reuse cannot fake liveness (processStartTime+nonce)
F8  mirror states: journal-ahead lag → silent rebuild; content divergence at same
    mirrored head → read-only conflict state
F9  idle shutdown vs racing new connection → connection wins or clean respawn
F10 end-vs-grant-accept race → broker-serialized, grant mutation rejected post-end
F11 broker crash/restart with outstanding unacked deliveries → all redelivered from
    the durable ledger, none lost, none duplicated post-ack
F12 crash at snapshot/segment-rotation boundaries → recovery from either the old or
    new artifact, never a mixed state

## Non-goals now
- No topology changes (still pair semantics), no user channel (U1), no multi-repo broker.
- No compaction policy beyond snapshot-on-threshold + segment rotation.

## Layer placement
- src/adapters/ipc/ — pipe transport client+server (ports: Transport)
- src/broker/ — journal, election, delivery ledger, server loop, mirrors (hosts app use-cases)
- src/apps/broker/main.ts — daemon composition root
- src/apps/cli/bind.ts → replaced by broker-client binding (spawn-on-demand); fs bind
  retained ONLY for read-only diagnostics path
