import type { AgentId, Grant, GrantScope, GrantState, MessageId, MessageType, Registry, Timestamp, TurnMode } from '@core/types.ts';

export type DiskSession = {
  task: string;
  agents: AgentId[];
  /** pair topology only (legacy files always have them). */
  driver?: AgentId;
  navigators?: AgentId[];
  turn?: AgentId;
  /** Peer 1A: absent means pair (legacy). */
  topology?: 'pair' | 'peer';
  initiator?: AgentId;
  phase?: string;
  status: 'active' | 'paused' | 'completed';
  started: Timestamp;
  /** M1: session identity (absent on legacy sessions). */
  sessionId?: string;
  /** M1: mirrored lifecycle registry. Optional — legacy sessions lack it
   * and consumers synthesize v0 from agents[]. */
  registry?: Registry;
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
  /** Item 7: serialized as `reply_to:` (optional, backward compatible). */
  replyTo?: MessageId;
  /** M1: serialized as `session_id:` (optional, backward compatible). */
  sessionId?: string;
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
