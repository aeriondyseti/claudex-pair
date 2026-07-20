# U1 slice 4 — privileged user actions (design, pre-code)

Status: REV 1 — DRAFT for codex design critique (2026-07-20). No code until
approved (slice-4 design gate, per the slice-3 close verdict
`20260720-113254-615`). Builds on slice 3 (advisory user channel: TOFU
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
`decide` rejects every agent-principal mutation while paused with a stable
`session-paused` code EXCEPT: `ack` of already-delivered mail (leases must
drain honestly), `leave-session` (an agent may still bail), and grant
completion `grant-done` for ACTIVE grants (edits already made should land
their completion record; new accepts are refused). User verbs and advisory
user messages remain allowed — pause is a brake on agents, not on the human.
Resume restores `active` verbatim; the turn holder is unchanged. `watch`
renders a loud PAUSED banner; agent CLIs surface `session-paused` with
"wait for the user to resume".

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
   — separate command kinds, separate invariants. Kick keeps its roster
   rules (cannot kick a non-member; kicking the last agent allowed for the
   user — the user may drain a session to empty, unlike a driver).
4. **Events**: `session-ended`/`grant-cancelled`/`agent-kicked` reuse the
   existing event vocabulary with `by: 'user'` provenance added to their
   payload (WAL-visible authority trail); 4b adds `session-paused` /
   `session-resumed` events. Mirrors: session.json reflects status; no new
   mirror files.

## Confirmation UX (watch TUI)

Frozen slice-3 input model is unchanged (printable = text; chords =
commands). Privileged actions are *typed commands with an interactive
confirmation*, per ENHANCEMENTS U1:

- The composer recognizes a leading `/` line as an ACTION DRAFT, not text:
  `/end [summary…]`, `/cancel-grant <id>`, `/kick <agent> [reason…]`,
  `/pause [reason…]`, `/resume`. Anything else after `/` renders an unknown-
  action hint. (A leading-`/` advisory message remains possible by prefixing
  a space — documented in the composer footer.)
- Submit on an action draft does NOT fire the wire call: the reducer enters
  a `confirming` composer state rendering `CONFIRM <verb …> — Enter to
  execute, Esc to abort`. A second submit executes (host allocates the
  reqId at CONFIRM time, reused on retries); Esc aborts to the drafted text
  for editing. Interactive confirmation therefore requires two distinct
  Enter presses on a TTY — piped stdin cannot reach the second one
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
- F-A8 real-wire: user `/kick` end-to-end — confirm, wire frame, broker
  commit, survivor notice delivery, kicked agent's next wait sees voided
  state (production handler wiring, like the slice-3 broadcast test).

## Open questions for critique

1. Pause scope: should `extend` (delivery-lease heartbeat) also be allowed
   while paused, so a mid-read navigator isn't lease-expired by the brake?
   (Draft answer: yes — add to the allowlist.)
2. Should `user-end-session` require a non-empty summary, or default one?
3. Is the `/`-prefix draft convention acceptable within the frozen "printable
   is text" model, or does critique prefer a chord to enter action mode?
4. `by: 'user'` on reused events vs. distinct `user-…` event kinds: reuse
   keeps evolve/mirrors untouched; distinct kinds make the WAL
   self-describing. Draft picks reuse+field; challenge welcome.
5. Does 4b's paused status need PROTOCOL.md text in this slice, or ride the
   instructions-file line only until the peer-model rewrite touches
   PROTOCOL.md anyway?
