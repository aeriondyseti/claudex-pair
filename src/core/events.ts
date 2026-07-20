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
  /** Round 2 #4: the durable atomic barrier-open fact. */
  | { kind: 'barrier-opened'; members: AgentId[]; registryVersion: number; at: Timestamp }
  /** 1B: public submission STATUS — the body is protocol-sealed in the
   * TxnRecord, never in any event. */
  | { kind: 'proposal-submitted'; author: AgentId; contentHash: string; bytes: number; at: Timestamp }
  /** 1B: the atomic reveal — electorate = openedMembers minus abstained. */
  | { kind: 'barrier-revealed'; electorate: AgentId[]; at: Timestamp }
  /** 1B-b: a converging-substate draft amendment. content is PUBLIC (post-
   * reveal there are no secrets) — this event is the durable content
   * carrier the journal's artifacts_.draft.body is derived from. */
  | { kind: 'draft-amended'; revision: number; hash: string; author: AgentId; content: string; bytes: number; at: Timestamp }
  | { kind: 'admission-authorized'; agent: AgentId; at: Timestamp }
  | { kind: 'absentee-ruled'; agent: AgentId; ruling: 'abstain' | 'wait'; newDeadlineAt?: Timestamp; at: Timestamp }
  /** Peer 1A: outcome provenance is permanent — 'forced' can never read
   * as 'ballot-passed' (codex rev 3). */
  | { kind: 'phase-transition'; from: import('./types.ts').SessionPhase; to: import('./types.ts').SessionPhase; outcome: 'forced' | 'ballot-passed'; reason?: string; at: Timestamp }
  | { kind: 'attention-raised'; id: string; category: 'tofu-bind' | 'findings-blocked'; detail: string; at: Timestamp }
  /** 1B-c: a finding is filed against a draft revision or a rival proposal
   * (converging only). text is PUBLIC post-reveal — the durable carrier the
   * artifacts findingTexts entry derives from; bytes/textHash are broker-
   * stamped. lifecycle starts 'open'. */
  | { kind: 'finding-filed'; id: string; author: AgentId; addressedTo: AgentId; anchor: { kind: 'draft'; revision: number } | { kind: 'proposal'; author: AgentId }; severity: 'HIGH' | 'MED' | 'LOW'; agreement: 'agreed' | 'partial' | 'disputed'; text: string; bytes: number; textHash: string; at: Timestamp }
  /** 1B-c: the addressee answers an open finding (resolve/concede/dispute).
   * text always carries (self-verifying artifacts entry). */
  | { kind: 'finding-responded'; id: string; disposition: 'resolve' | 'concede' | 'dispute'; text: string; bytes: number; textHash: string; at: Timestamp }
  /** 1B-c: the author confirms an answered finding (accept -> resolved;
   * contest -> open, optionally flipping agreement to disputed). */
  | { kind: 'finding-confirmed'; id: string; verdict: 'accept' | 'contest'; text: string; bytes: number; textHash: string; at: Timestamp; setDisputed?: boolean }
  /** 1B-c: the author amends its own finding (withdraw -> terminal, or
   * set-agreement while open). text OPTIONAL (a bare withdraw carries none). */
  | { kind: 'finding-amended'; id: string; action: 'withdraw' | 'set-agreement'; agreement?: 'agreed' | 'partial' | 'disputed'; text?: string; bytes?: number; textHash?: string; at: Timestamp }
  /** 1B-c: the convergence turn advances (yield or holder departure). evolve
   * recomputes remaining/round/starterIndex deterministically via the shared
   * advance algorithm and seats event.to. */
  | { kind: 'convergence-turn-passed'; from: AgentId; to: AgentId; round: number; at: Timestamp }
  /** 1B-c: no live successor — converging -> convergence-blocked. Payload-
   * free: evolve recomputes the blocked rotation from state+registry. */
  | { kind: 'convergence-halted'; at: Timestamp }
  /** 1B-c: an electorate member rejoined a blocked convergence — blocked ->
   * converging, seating the rejoiner (or the round-completion starter). */
  | { kind: 'convergence-resumed'; holder: AgentId; at: Timestamp }
  | { kind: 'attention-cleared'; id: string; at: Timestamp }
  | { kind: 'session-initialized'; task: string; agents: readonly AgentId[]; driver: AgentId; at: Timestamp; sessionId?: string; meta?: Readonly<Record<AgentId, AgentMeta>>; topology?: Topology }
  | { kind: 'message-sent'; id: MessageId; from: AgentId; to: AgentId; type: MessageType; turn: TurnMode; body: string; at: Timestamp; groupId?: string; provenance?: 'trusted_user_client' | 'broker'; actionKind?: UserActionKind; replyTo?: MessageId; sessionId?: string }
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
