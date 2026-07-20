import type { AgentMeta, AgentId, GrantId, GrantScope, MessageId, MessageType, Timestamp, TurnMode, Topology } from './types.ts';

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
/** U1 slice 4: durable discriminator on ACTION notices — provenance+groupId
 * alone are indistinguishable from advisory user messages (design REV 6,
 * round-2 B). Renderers key the ⚡ marker on this, never on provenance. */
export type UserActionKind = 'end' | 'cancel-grant' | 'kick' | 'pause' | 'resume' | 'admit' | 'rebind' | 'rule-absentee' | 'force-phase';

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
  /** M1: registry-change notification (provenance for subscribers; the
   * membership event itself mutates the registry in evolve, so replaying
   * pre-M1 journals still builds a correct registry). version is the
   * POST-change registry version. */
  | { kind: 'registry-updated'; version: number; change: 'init' | 'joined' | 'left' | 'kicked' | 'bound' | 'rebound'; agent?: AgentId; meta?: AgentMeta; binding?: { bindingId: string; credentialVersion: number; boundAt: Timestamp }; at: Timestamp }
  /** Peer 1A: attach admitted this agent (authorizedExpected -> member). */
  | { kind: 'agent-admitted'; agent: AgentId; at: Timestamp }
  /** Peer 1A: the last expected admission (or closing ruling) — planning
   * leaves 'admitting' atomically in the same txn. */
  | { kind: 'admission-completed'; at: Timestamp }
  | { kind: 'admission-authorized'; agent: AgentId; at: Timestamp }
  | { kind: 'absentee-ruled'; agent: AgentId; ruling: 'abstain' | 'wait'; newDeadlineAt?: Timestamp; at: Timestamp }
  /** Peer 1A: outcome provenance is permanent — 'forced' can never read
   * as 'ballot-passed' (codex rev 3). */
  | { kind: 'phase-transition'; from: import('./types.ts').SessionPhase; to: import('./types.ts').SessionPhase; outcome: 'forced' | 'ballot-passed'; reason?: string; at: Timestamp }
  | { kind: 'attention-raised'; id: string; category: 'tofu-bind'; detail: string; at: Timestamp }
  | { kind: 'attention-cleared'; id: string; at: Timestamp }
  | { kind: 'session-initialized'; task: string; agents: readonly AgentId[]; driver: AgentId; at: Timestamp; sessionId?: string; meta?: Readonly<Record<AgentId, AgentMeta>>; topology?: Topology }
  | { kind: 'message-sent'; id: MessageId; from: AgentId; to: AgentId; type: MessageType; turn: TurnMode; body: string; at: Timestamp; groupId?: string; provenance?: 'trusted_user_client'; actionKind?: UserActionKind; replyTo?: MessageId; sessionId?: string }
  | { kind: 'turn-passed'; to: AgentId }
  | { kind: 'driver-changed'; driver: AgentId }
  | { kind: 'session-ended'; by: AgentId; summary: string; at: Timestamp }
  | { kind: 'session-paused'; reason: string; at: Timestamp }
  | { kind: 'session-resumed'; at: Timestamp }
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
  | { kind: 'agent-kicked'; agent: AgentId; reason: string; at: Timestamp }
  // U1 slice 3 — user channel. message-sent gains OPTIONAL groupId +
  // provenance below (user sends only); the binding event is what makes the
  // journal authoritative for the registered credential hash.
  | { kind: 'user-channel-registered'; tokenHash: string; at: Timestamp };
