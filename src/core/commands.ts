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
  | { kind: 'cancel-grant'; grantId: GrantId; reason: string };

export type GrantScopeInput =
  | { mode: 'worktree'; worktree: string }
  | { mode: 'files'; files: readonly string[]; riskAccepted: boolean };

export type CommandEnvelope<C extends Command = Command> = {
  readonly command: C;
  readonly meta: CommandMeta;
};
