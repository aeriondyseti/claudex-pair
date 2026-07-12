import type { AgentId, GrantId, GrantScope, MessageId, MessageType, Timestamp, TurnMode } from './types.ts';

/**
 * Events are the WAL vocabulary (ENHANCEMENTS.md rev 7): the future broker's
 * journal is a log of these; state is replay-derived via evolve().
 */
export type Event =
  | { kind: 'session-initialized'; task: string; agents: readonly AgentId[]; driver: AgentId; at: Timestamp }
  | { kind: 'message-sent'; id: MessageId; from: AgentId; to: AgentId; type: MessageType; turn: TurnMode; body: string; at: Timestamp }
  | { kind: 'turn-passed'; to: AgentId }
  | { kind: 'driver-changed'; driver: AgentId }
  | { kind: 'session-ended'; by: AgentId; summary: string; at: Timestamp }
  | { kind: 'grant-issued'; grantId: GrantId; issuer: AgentId; assignee: AgentId; task: string; scope: GrantScope; agreedIn: MessageId | ''; at: Timestamp }
  | { kind: 'grant-accepted'; grantId: GrantId; at: Timestamp }
  | { kind: 'grant-completed'; grantId: GrantId; result: string; at: Timestamp }
  | { kind: 'grant-cancelled'; grantId: GrantId; reason: string; at: Timestamp };
