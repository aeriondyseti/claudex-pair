import type { AgentMeta, AgentId, GrantId, MessageId, MessageType, Timestamp, TurnMode, Topology } from './types.ts';

/**
 * Ids, time, and the authenticated principal are produced at the edges and
 * arrive here — never inside core (ARCHITECTURE.md).
 */
export type CommandMeta = {
  readonly id: MessageId;
  readonly at: Timestamp;
  readonly principal: AgentId;
  /** 1B: broker-stamped exact UTF-8 accounting for content-carrying
   * commands (propose, draft-amend) — pure decide never computes crypto. */
  readonly contentHash?: string;
  readonly contentBytes?: number;
  /** 1C: broker-stamped CURRENT draft body for call-question (transport-
   * boundary stamping like contentHash — the broker reads
   * journal.planningArtifacts().draft.body so a caller cannot forge the
   * normative task block). Pure decide parses/validates it (JSON.parse is
   * pure). */
  readonly draftBody?: string;
};

export type Command =
  | { kind: 'init-session'; task: string; agents: readonly AgentId[]; driver: AgentId; sessionId?: string; meta?: Readonly<Record<AgentId, AgentMeta>>; topology?: Topology }
  // replyTo (ENHANCEMENTS item 7): optional causality — the MessageId this
  // message answers. Advisory metadata in the core; the broker derives the
  // awaiting-set from it. Never affects turn semantics.
  | { kind: 'send-message'; to: AgentId; type: MessageType; turn: TurnMode; body: string; replyTo?: MessageId }
  | { kind: 'end-session'; summary: string }
  | { kind: 'issue-grant'; grantId: GrantId; to: AgentId; task: string; scope: GrantScopeInput; agreedIn: MessageId | '' }
  | { kind: 'accept-grant'; grantId: GrantId }
  | { kind: 'complete-grant'; grantId: GrantId; result: string }
  | { kind: 'cancel-grant'; grantId: GrantId; reason: string }
  // ENHANCEMENTS 8a: driver reclaims the turn from an unresponsive holder.
  // Elapsed-time policy is CLI-side attestation (-ConfirmUnresponsive); the
  // broker contributes the liveness fact (live lease → partner-active).
  | { kind: 'revoke-turn'; reason: string }
  // ENHANCEMENTS 11: roster mutations — driver authority, uniformly.
  | { kind: 'leave-session' }
  | { kind: 'join-session'; agent: AgentId; meta?: AgentMeta }
  | { kind: 'kick-agent'; agent: AgentId; reason: string }
  // U1 slice 3 (U1-SLICE3-DESIGN.md, approved): INTERNAL shape only — the
  // authenticated user-channel handler allocates groupId (=== reqId) and
  // unique per-recipient messageIds BEFORE decide; the generic execute path
  // rejects this kind unconditionally. Advisory: never a turn mutation.
  | { kind: 'user-message'; groupId: string; recipients: readonly { to: AgentId; messageId: MessageId }[]; body: string }
  // U1 slice 3: journal-authoritative user-channel binding (TOFU, loud).
  | { kind: 'register-user-channel'; tokenHash: string }
  // U1 slice 4 (U1-SLICE4-DESIGN.md REV 6, approved): PRIVILEGED user
  // actions — INTERNAL shapes reachable only through the authenticated
  // user-action handler; the generic execute path fail-closes the entire
  // user-* namespace. The handler supplies groupId (=== reqId) and a
  // collision-proof noticeIdBase (`${id}-s${seq}`); decide computes the
  // per-verb recipients itself and derives notice ids `${base}-r${i}`.
  | { kind: 'user-end-session'; summary: string; groupId: string; noticeIdBase: string }
  | { kind: 'user-cancel-grant'; grantId: GrantId; reason: string; groupId: string; noticeIdBase: string }
  | { kind: 'user-kick-agent'; agent: AgentId; reason: string; groupId: string; noticeIdBase: string }
  // U1 slice 4b: the brake. Pause freezes agent mutations (allowlist:
  // leave, active-grant completion); resume restores ONLY the status.
  | { kind: 'user-pause-session'; reason: string; groupId: string; noticeIdBase: string }
  /** Peer 1A: post-init admission authorization (the agent still attaches
   * with its own credential; this only adds it to authorizedExpected). */
  | { kind: 'user-admit-agent'; agent: AgentId; groupId: string; noticeIdBase: string }
  /** Peer 1A: pending-new-binding — invalidates the old verifier, revokes
   * and wakes all old-version tags; the next attach TOFUs at version+1. */
  | { kind: 'user-rebind-agent'; agent: AgentId; groupId: string; noticeIdBase: string }
  /** Peer 1A: per-absentee admitting ruling — abstain drops the invitee
   * from expected (authorized pending observer); wait sets a new absolute
   * deadline. */
  | { kind: 'user-rule-absentee'; agent: AgentId; ruling: 'abstain' | 'wait'; newDeadlineAt?: Timestamp; groupId: string; noticeIdBase: string }
  /** 1B: sealed blind proposal (collecting substate). The body crosses
   * the wire in the command but is journaled ONLY in the record's sealed
   * field; meta.contentHash/contentBytes are broker-stamped. */
  | { kind: 'propose'; content: string }
  /** 1B-b: converging-substate draft amendment — holder-only, optimistic
   * concurrency via baseRevision (the revision the amender last read).
   * content is validated in decide (grammar/bounds); meta.contentHash/
   * contentBytes are broker-stamped, same as propose. */
  | { kind: 'draft-amend'; content: string; baseRevision: number }
  /** 1B-c: file a finding against a draft revision or a rival proposal
   * (converging, electorate member only). text validated in decide (grammar/
   * bounds); meta.contentHash/contentBytes are broker-stamped like propose. */
  | { kind: 'critique'; anchor: import('./types.ts').Finding['anchor']; severity: import('./types.ts').Finding['severity']; agreement: import('./types.ts').Finding['agreement']; text: string }
  /** 1B-c: the addressee answers an open finding. */
  | { kind: 'respond-critique'; findingId: string; disposition: 'resolve' | 'concede' | 'dispute'; text: string }
  /** 1B-c: the author confirms an answered finding. */
  | { kind: 'confirm-critique'; findingId: string; verdict: 'accept' | 'contest'; text: string; setDisputed?: boolean }
  /** 1B-c: the author withdraws or re-labels its own finding. */
  | { kind: 'amend-critique'; findingId: string; action: 'withdraw' | 'set-agreement'; agreement?: import('./types.ts').Finding['agreement']; text?: string }
  /** 1B-c: the convergence holder passes the turn (must-respond gate first). */
  | { kind: 'yield-turn' }
  /** 1C (§1c): call the question on the current draft — any electorate
   * member, converging, no open ballot. Carries NO block payload: the
   * broker stamps meta.draftBody from the journal and decide validates the
   * normative task block from it (a caller cannot forge it). */
  | { kind: 'call-question' }
  /** 1C: cast a ballot vote. approve+no reasons, or reject+non-blank reasons
   * ('vote-reject-without-reason'). revisionHash must equal the ballot's
   * frozen hash ('stale-ballot-revision'). */
  | { kind: 'vote'; approve: boolean; reasons?: string; revisionHash: string }
  /** 1C: mark a next-round agenda item addressed (any electorate member),
   * optionally linking the finding that addressed it. */
  | { kind: 'address-agenda'; agendaId: string; findingId?: string; note?: string }
  /** Round 2 #8: complete a durable attention item (loud TOFU etc.) —
   * without this the instruction can never be satisfied. */
  | { kind: 'user-clear-attention'; id: string; groupId: string; noticeIdBase: string }
  /** Peer 1A: bounded forced transition — planning->provisioning ONLY;
   * outcome is permanently 'forced', never unanimity. */
  | { kind: 'user-force-phase'; to: import('./types.ts').SessionPhase; reason: string; groupId: string; noticeIdBase: string }
  | { kind: 'user-resume-session'; groupId: string; noticeIdBase: string };

export type GrantScopeInput =
  | { mode: 'worktree'; worktree: string }
  | { mode: 'files'; files: readonly string[]; riskAccepted: boolean };

export type CommandEnvelope<C extends Command = Command> = {
  readonly command: C;
  readonly meta: CommandMeta;
};
