import type { AgentId, Grant, GrantScope, GrantState, MessageId, MessageType, Timestamp, TurnMode } from '@core/types.ts';

export type DiskSession = {
  task: string;
  agents: AgentId[];
  driver: AgentId;
  navigators: AgentId[];
  turn: AgentId;
  status: 'active' | 'completed';
  started: Timestamp;
};

export type DiskGrant = {
  id: string;
  issuer: AgentId;
  assignee: AgentId;
  task: string;
  scope: GrantScope;
  state: GrantState;
  agreed_in: MessageId | '';
  result: string;
  revision: number;
  created: Timestamp;
  updated: Timestamp;
};

export type PairMessage = {
  id: MessageId;
  from: AgentId;
  to: AgentId;
  type: MessageType;
  turn: TurnMode;
  sent: Timestamp;
  body: string;
};

export const toDiskGrant = (grant: Grant): DiskGrant => ({
  id: grant.id, issuer: grant.issuer, assignee: grant.assignee, task: grant.task,
  scope: grant.scope, state: grant.state, agreed_in: grant.agreedIn,
  result: grant.result, revision: grant.revision, created: grant.created, updated: grant.updated,
});

export const fromDiskGrant = (grant: DiskGrant): Grant => ({
  id: grant.id, issuer: grant.issuer, assignee: grant.assignee, task: grant.task,
  scope: grant.scope, state: grant.state, agreedIn: grant.agreed_in,
  result: grant.result, revision: grant.revision, created: grant.created, updated: grant.updated,
});
