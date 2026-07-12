/** Pure domain types. This module (like all of core/) imports nothing. */

export type AgentId = string;
export type GrantId = string;
export type MessageId = string;
/** 'yyyy-MM-dd HH:mm:ss' — formatted at the edges, opaque here. */
export type Timestamp = string;

export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,15}$/;

export type MessageType =
  | 'ask'
  | 'answer'
  | 'review'
  | 'handoff'
  | 'info'
  | 'done'
  | 'grant'
  | 'grant-done'
  | 'grant-cancel';

export type TurnMode = 'pass' | 'keep';

export type GrantScope =
  | { mode: 'worktree'; worktree: string }
  | { mode: 'files'; files: readonly string[] };

export type GrantState = 'offered' | 'active' | 'done' | 'cancelled';

export type Grant = {
  readonly id: GrantId;
  readonly issuer: AgentId;
  readonly assignee: AgentId;
  readonly task: string;
  readonly scope: GrantScope;
  readonly state: GrantState;
  readonly agreedIn: MessageId | '';
  readonly result: string;
  readonly revision: number;
  readonly created: Timestamp;
  readonly updated: Timestamp;
};

export type SessionStatus = 'active' | 'completed';

export type SessionState = {
  readonly task: string;
  readonly agents: readonly AgentId[];
  readonly driver: AgentId;
  readonly turn: AgentId;
  readonly status: SessionStatus;
  readonly started: Timestamp;
  readonly grants: Readonly<Record<GrantId, Grant>>;
};

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T, E = never>(value: T): Result<T, E> => ({ ok: true, value });
export const err = <E, T = never>(error: E): Result<T, E> => ({ ok: false, error });
