import type { AgentId, GrantId, GrantScope, MessageId, MessageType, Timestamp, TurnMode } from './types.ts';

/**
 * Events are the WAL vocabulary (ENHANCEMENTS.md rev 7): the future broker's
 * journal is a log of these; state is replay-derived via evolve().
 *
 * Provenance lives on the WRAPPER, not the event: transition events
 * (turn-passed, driver-changed, grant-*) deliberately carry no actor/id —
 * the journal stores every event as a JournalRecord, whose metadata is the
 * uniform source of idempotency (envelope id), provenance (principal), and
 * ordering (seq). Events stay minimal so replay stays minimal.
 */
export type JournalRecord = {
  /** Monotonic position in the journal; assigned by the Journal port on append. */
  readonly seq: number;
  /** The CommandEnvelope id that produced this event (idempotency key). */
  readonly envelopeId: MessageId;
  readonly principal: AgentId;
  readonly at: Timestamp;
  readonly event: Event;
};
export type Event =
  | { kind: 'session-initialized'; task: string; agents: readonly AgentId[]; driver: AgentId; at: Timestamp }
  | { kind: 'message-sent'; id: MessageId; from: AgentId; to: AgentId; type: MessageType; turn: TurnMode; body: string; at: Timestamp }
  | { kind: 'turn-passed'; to: AgentId }
  | { kind: 'driver-changed'; driver: AgentId }
  | { kind: 'session-ended'; by: AgentId; summary: string; at: Timestamp }
  | { kind: 'grant-issued'; grantId: GrantId; issuer: AgentId; assignee: AgentId; task: string; scope: GrantScope; agreedIn: MessageId | ''; at: Timestamp }
  | { kind: 'grant-accepted'; grantId: GrantId; at: Timestamp }
  | { kind: 'grant-completed'; grantId: GrantId; result: string; at: Timestamp }
  | { kind: 'grant-cancelled'; grantId: GrantId; reason: string; at: Timestamp }
  // ENHANCEMENTS 8a/11 — turn revocation + roster lifecycle. The revocation
  // notice and turn return travel in the SAME decided event list (one txn);
  // roster removals additionally void the agent's open deliveries at the
  // ledger layer (broker), never here.
  | { kind: 'turn-revoked'; from: AgentId; reason: string; at: Timestamp }
  | { kind: 'agent-left'; agent: AgentId; at: Timestamp }
  | { kind: 'agent-joined'; agent: AgentId; at: Timestamp }
  | { kind: 'agent-kicked'; agent: AgentId; reason: string; at: Timestamp };
