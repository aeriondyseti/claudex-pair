# TUI/watch upgrade handoff

Durable context for the user-led broker-mode `pair watch` session. Read this
with [ENHANCEMENTS.md](ENHANCEMENTS.md) U1 and [BROKER-SPEC.md](BROKER-SPEC.md).

## Starting point

- Start from main at or after `05017a1`. U3, broker W2, and W2c are complete:
  fused send+wait; durable broker delivery; revoke-turn; driver-only close;
  leave/join/kick; and Windows daemon detachment.
- The completion baseline was 88 tests / 851 assertions / 0 failures (two
  platform-specific skips on Windows).
- The user deliberately reserved all watch/TUI changes for a fresh session
  using the upgraded broker pair. Do not fold unrelated topology or agent
  adapter work into this slice.

## What watch does today

- `src/apps/cli/main.ts` explicitly excludes `watch` from broker routing. The
  command binds `bindFsDeps`, polls session/archive/inbox mirrors, clears the
  terminal, and redraws every `-RefreshSec`.
- `src/adapters/tui/watch.ts` is a small pure renderer. It receives a
  `SessionView`, archived/pending `StoredMessage` entries, terminal width,
  tail count, and refresh interval. Preserve this pure-rendering seam.
- The current view is read-only: status, driver/navigators/turn, open grants,
  transcript, and `[undelivered]` labels. It has no input model, focus state,
  resize/event loop, observer connection, or user identity.

## Non-negotiable protocol constraints

1. The broker journal is authoritative while the broker runs. Do not build the
   broker TUI by treating `.pair/session.json`, inbox, or archive mirrors as
   authoritative; mirrors are recoverable views and may lag.
2. Do **not** call `ProtocolGateway.subscribe()` as an agent to observe the
   transcript. That API creates delivery leases and its ack consumes the
   agent's delivery. Watch needs a non-consuming observer query/stream.
3. Keep command authority at the broker. The TUI submits commands or user
   actions; it never decides events or mutates projected state locally.
4. `user` is outside the agent roster. It cannot own a turn/grant or be a
   handoff target. Advisory user messages default to `turn: keep` and must be
   archived with explicit provenance and per-recipient acknowledgement.
5. Call the provenance `trusted_user_client`, not “human guaranteed.” The
   current `.pair/broker.token` is a shared repository capability readable by
   agents and is insufficient for U1. A user credential must be distinct and
   outside agent-readable repo/environment state (or the UI must run across a
   separately trusted boundary).
6. Privileged user actions (especially end, pause/resume, grant cancellation,
   and other authority changes) require explicit interactive confirmation.
   Piped/scripted stdin must not silently inherit interactive user authority.
7. Preserve delivery guarantees: open/unacked beats cursor, print/flush before
   agent ack, and request-id reuse on reconnect. An observer cursor must be
   separate from every agent delivery cursor and must never close deliveries.

## Recommended implementation sequence

### 1. Broker-native read-only watch

- Add a typed observer projection/API to the gateway and wire protocol. It
  should provide an authoritative session/status snapshot plus ordered
  transcript activity without leasing or acknowledging agent deliveries.
- Prefer an event-driven observer stream with a monotonic journal/observer
  cursor and reconnect/resume. A polling `status + log` bridge is acceptable
  only as a clearly marked first slice; current `log` reads archive mirrors
  and therefore is not an authoritative live transcript.
- Route `pair watch` through broker discovery by default while retaining the
  active-legacy-session fs guard. Ensure the observer connection participates
  honestly in broker idle/drain behavior.
- Adapt the pure renderer to a view model shared by broker and fs diagnostic
  modes. Show broker epoch/head and whether the view is authoritative or a
  potentially lagging fs projection.

### 2. Real terminal event loop

- Separate state reduction, rendering, terminal I/O, and broker transport.
- Handle resize, input, redraw, reconnect, broker stop/restart, completed
  sessions, and Ctrl+C cleanup without leaving cursor/ANSI state corrupted.
- Avoid fixed-interval full redraw as the final architecture. Coalesce events
  and redraw only when state, width, or input changes.

### 3. Advisory user channel

- Freeze the identity/credential design before adding the input box.
- Define direct-to-agent and broadcast semantics. Broadcast is one broker
  transaction with per-recipient delivery/ack state; it must not masquerade
  as several unrelated sends that can partially succeed without disclosure.
- Render user messages distinctly and show acknowledgement state. Agents need
  a normal wake/delivery for user instructions, but the user observer must not
  become a participant or move the turn.

### 4. Privileged user actions

- Add explicit broker command kinds and core authorization for each supported
  user action. Do not encode privileged actions as ordinary message text.
- Design confirmation UX and non-interactive rejection first, then implement
  end/pause/resume/cancel controls incrementally with audit events.

## Tests worth writing first

- Observer connection receives ordered committed activity but does not create
  a delivery lease, ack/void mail, change an agent cursor, or block revocation
  as `partner-active`.
- Disconnect/reconnect resumes an observer without duplicates or gaps; broker
  restart and epoch change are visible.
- Pending and archived transitions do not duplicate a transcript entry.
- Broker watch never trusts a deliberately stale/tampered fs mirror.
- Legacy active fs sessions still render and clearly identify fs diagnostic
  limitations.
- Resize/input/redraw tests exercise the reducer and renderer without a real
  terminal; one Windows live smoke covers ANSI cleanup and daemon persistence.
- Advisory user direct/broadcast messages have `trusted_user_client`
  provenance, remain `turn: keep`, wake intended agents, and record per-target
  ack state.
- Scripted stdin cannot invoke privileged actions; interactive confirmation
  can, and the resulting state change is journaled atomically.

## Decisions to make with the user at session start

- Is the first deliverable broker-native read-only parity, or should the
  session include the full interactive U1 user channel? The former is a much
  smaller reviewable slice and establishes the required observer transport.
- Which trusted boundary stores/presents the user credential on Windows?
  Decide this before claiming trusted provenance.
- Minimum interaction model: input-only, target picker, broadcast, scrolling,
  filtering, and which privileged actions belong in the first release.
- Whether fs mode remains read-only forever. The safest default is yes: do not
  offer privileged “trusted user” actions where there is no broker authority
  or separate credential boundary.

## Easy mistakes to avoid

- Reusing agent `subscribe/ack` for watch.
- Reading broker mirrors and labeling the result authoritative.
- Treating a shared token or OS username as proof a human typed a message.
- Letting `user` leak into `session.agents` or ordinary turn/grant logic.
- Combining observer cursor, journal commit sequence, and delivery sequence;
  they have different meanings.
- Starting with terminal widgets before freezing observer and user-authority
  contracts.
