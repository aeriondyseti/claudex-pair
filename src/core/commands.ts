import type { AgentId, GrantId, MessageId, MessageType, Timestamp, TurnMode } from './types.ts';

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
  | { kind: 'init-session'; task: string; agents: readonly AgentId[]; driver: AgentId }
  | { kind: 'send-message'; to: AgentId; type: MessageType; turn: TurnMode; body: string }
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
  | { kind: 'join-session'; agent: AgentId }
  | { kind: 'kick-agent'; agent: AgentId; reason: string }
  // U1 slice 3 (U1-SLICE3-DESIGN.md, approved): INTERNAL shape only — the
  // authenticated user-channel handler allocates groupId (=== reqId) and
  // unique per-recipient messageIds BEFORE decide; the generic execute path
  // rejects this kind unconditionally. Advisory: never a turn mutation.
  | { kind: 'user-message'; groupId: string; recipients: readonly { to: AgentId; messageId: MessageId }[]; body: string }
  // U1 slice 3: journal-authoritative user-channel binding (TOFU, loud).
  | { kind: 'register-user-channel'; tokenHash: string };

export type GrantScopeInput =
  | { mode: 'worktree'; worktree: string }
  | { mode: 'files'; files: readonly string[]; riskAccepted: boolean };

export type CommandEnvelope<C extends Command = Command> = {
  readonly command: C;
  readonly meta: CommandMeta;
};
