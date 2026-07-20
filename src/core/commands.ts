import type { AgentMeta, AgentId, GrantId, MessageId, MessageType, Timestamp, TurnMode } from './types.ts';

/**
 * Ids, time, and the authenticated principal are produced at the edges and
 * arrive here — never inside core (ARCHITECTURE.md).
 */
export type CommandMeta = {
  readonly id: MessageId;
  readonly at: Timestamp;
  readonly principal: AgentId;
};

export type Command =
  | { kind: 'init-session'; task: string; agents: readonly AgentId[]; driver: AgentId; sessionId?: string; meta?: Readonly<Record<AgentId, AgentMeta>> }
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
  | { kind: 'user-resume-session'; groupId: string; noticeIdBase: string };

export type GrantScopeInput =
  | { mode: 'worktree'; worktree: string }
  | { mode: 'files'; files: readonly string[]; riskAccepted: boolean };

export type CommandEnvelope<C extends Command = Command> = {
  readonly command: C;
  readonly meta: CommandMeta;
};
