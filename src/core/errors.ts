/**
 * Protocol errors. `message` text is part of the CLI parity contract — agents
 * parse these strings; change them only with a golden-test update.
 */
export type ProtocolErrorCode =
  | 'session-exists'
  | 'session-not-active'
  | 'not-a-participant'
  | 'self-addressed'
  | 'not-your-turn'
  | 'handoff-not-driver'
  | 'ambiguous-recipient'
  | 'invalid-agents'
  | 'driver-not-agent'
  | 'grant-not-driver'
  | 'grant-to-self'
  | 'grant-scope-invalid'
  | 'grant-risk-unacknowledged'
  | 'grant-task-missing'
  | 'grant-id-collision'
  | 'grant-not-found'
  | 'grant-wrong-assignee'
  | 'grant-stale-transition'
  // ENHANCEMENTS 8a/11 (W2c)
  | 'revoke-not-driver'
  | 'revoke-own-turn'
  | 'partner-active'
  | 'end-not-driver'
  | 'init-not-driver'
  | 'driver-cannot-leave'
  | 'leave-with-grant'
  | 'join-not-driver'
  | 'already-participant'
  | 'kick-not-driver'
  | 'kick-driver'
  // U1 slice 3 — user channel (U1-SLICE3-DESIGN.md, approved)
  | 'reserved-identity'
  | 'user-not-addressable'
  | 'user-channel-required'
  | 'user-channel-unregistered'
  | 'user-channel-already-registered'
  | 'user-auth-failed'
  | 'invalid-recipient'
  | 'registry-full'
  | 'no-driver-authority'
  | 'not-peer-topology'
  | 'phase-unavailable'
  | 'admitting-closed'
  | 'not-an-absentee'
  | 'no-turn-in-phase'
  | 'invalid-session-id'
  | 'invalid-message-type'
  | 'invalid-reply-to'
  | 'session-paused'
  | 'session-already-paused'
  | 'session-not-paused';

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}
