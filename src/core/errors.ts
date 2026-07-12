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
  | 'grant-stale-transition';

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}
