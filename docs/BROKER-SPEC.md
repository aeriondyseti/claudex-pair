# claudex broker specification (draft for tri-review)

## Identity & discovery
- Pipe name: `\\.\pipe\claudex-<sha256(normalized repo root)[0..15]>` (Windows);
  `$XDG_RUNTIME_DIR/claudex-<hash>.sock` elsewhere.
- `.pair/broker.lease` — single-instance election: `open('wx')`, holds {pid, epoch, startedAt},
  heartbeat mtime; stale if pid dead → steal with epoch bump.
- `.pair/broker.token` — 32-byte random capability, user-only perms; clients read and present it.
  (U1 later: separate user-channel token outside repo.)

## Storage (journal is authoritative; legacy files become materialized views)
- `.pair/journal/segment-NNNNNN.jsonl` — one JournalRecord per line:
  {seq, envelopeId, principal, at, event, crc32}. fsync before ack.
- `.pair/journal/snapshot.json` — atomic-replace compaction (state + lastSeq).
- Legacy mirrors (session.json, inbox/*.md, archive/, grants/*.json) written by the broker
  AFTER commit — keeps watch/status/log file-native and humans able to read state.
  Journal wins on divergence; mirror rebuild on recovery. External edits to mirrors =
  tamper → read-only conflict state + doctor (rev-7 rule).

## Wire protocol (newline-delimited JSON over the pipe)
- Request: {reqId, token, clientId, as, kind:'execute', envelope} → {reqId, ok, seq, events | error{code,message}}.
- Idempotency: broker keeps (clientId, reqId)→response LRU; retried requests replay the response.
- Subscribe: {kind:'subscribe', as, afterSeq} → pushes {kind:'delivery', seq, message};
  client must {kind:'ack', seq} within lease (default 90s, extensible) or broker redelivers
  (at-least-once; consumers dedup by message id).
- Queries: {kind:'query', what:'status'|'log'|...} → DTO (includes liveness: per-agent
  connectedSince, lastActivity, broker pid/epoch).

## Lifecycle
- CLI: connect → on ECONNREFUSED/absent, spawn detached broker, await readiness
  (lease + endpoint ping) with bounded backoff, then retry once; two spawns race → loser
  connects to winner's pipe.
- Idle exit: no connections AND no in-flight txn AND no unacked delivery, sustained
  through grace (60s) → flush, release lease, exit. Restart is transparent.
- Recovery: acquire lease → load snapshot → replay tail (crc-validated; truncate invalid
  tail) → rebuild mirrors if inconsistent → open pipe. Commands during recovery: fail
  loudly ('broker recovering, retry').

## Commit path (single writer)
receive → authenticate token → decide(state, envelope) → append+fsync journal →
evolve in-memory → ack requester → mirror files → push deliveries.

## Failure test matrix (write these FIRST)
F1 kill -9 mid-append → restart truncates torn tail, state consistent
F2 crash after append before ack → client retry with same reqId gets replayed response, no double event
F3 double spawn race → exactly one lease holder; loser connects
F4 client dies with unacked delivery → redelivery after lease expiry to next wait
F5 duplicate wait (same identity, two connections) → each message delivered/acked exactly once
F6 journal crc corruption mid-history → refuse start with doctor guidance (not silent truncate — only torn TAIL truncates)
F7 stale lease (dead pid) → steal, epoch bump, old-epoch requests rejected
F8 external mirror edit → detected (mirror hash vs journal), read-only conflict state
F9 idle shutdown vs racing new connection → connection wins or clean respawn
F10 end-vs-grant-accept race (the grants-lite guard, now broker-serialized)

## Non-goals now
- No topology changes (still pair semantics), no user channel (U1), no multi-repo broker.
- Compaction beyond simple snapshot-on-threshold.

## Layer placement
- src/adapters/ipc/ — pipe transport client+server (ports: Transport)
- src/broker/ — journal, lease, server loop, mirrors (hosts app use-cases)
- src/apps/broker/main.ts — daemon composition root
- src/apps/cli/bind.ts → replaced by broker-client binding (spawn-on-demand); fs bind
  retained ONLY for read-only diagnostics path
