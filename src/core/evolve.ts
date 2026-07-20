import type { Event } from './events.ts';
import type { AgentMeta, AgentRecord, Registry, SessionState } from './types.ts';

/**
 * Pure fold: state = events.reduce(evolve, undefined). Total over every
 * (state, event) pair decide can emit; unknown combinations return state
 * unchanged rather than throwing (journal replay must never fail here).
 */
export function evolve(state: SessionState | undefined, event: Event): SessionState | undefined {
  switch (event.kind) {
    case 'session-initialized': {
      const base = {
        task: event.task,
        status: 'active' as const,
        started: event.at,
        grants: {},
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        // M1 canonical transitions: init declares the roster at version 0;
        // every LATER version is set by a registry-updated event (the ONE
        // canonical registry transition) — the event's version IS the state
        // version, so provenance and state cannot drift.
        registry: {
          version: 0,
          agents: Object.fromEntries(event.agents.map((a) => [a, liveRecord(a, event.at, event.meta?.[a])])),
        },
      };
      // Peer 1A: peer sessions begin ADMITTING — the roster named at init
      // is authorizedExpected; only the initiator (bound in the init txn)
      // is a member. Legacy events lack topology → pair.
      if (event.topology === 'peer') {
        return {
          ...base,
          topology: 'peer' as const,
          agents: [event.driver],
          initiator: event.driver,
          phase: 'planning' as const,
          planning: { substate: 'admitting' as const, authorizedExpected: event.agents, admitted: [event.driver] },
        };
      }
      return { ...base, topology: 'pair' as const, agents: event.agents, driver: event.driver, turn: event.driver };
    }
    case 'turn-passed':
      // Peer sessions have no standing turn token (1A); the planning
      // convergence turn arrives as its own substate machinery in 1C.
      return state && state.topology === 'pair' ? { ...state, turn: event.to } : state;
    case 'driver-changed':
      return state && state.topology === 'pair' ? { ...state, driver: event.driver } : state;
    case 'session-ended':
      return state && { ...state, status: 'completed' };
    case 'session-paused':
      return state && { ...state, status: 'paused' };
    case 'session-resumed':
      // Resume changes ONLY the status: mutations legitimately committed
      // while paused (a turn-moving leave, a grant completion) are
      // preserved, never rolled back (design REV 6, tail A).
      return state && { ...state, status: 'active' };
    case 'grant-issued':
      return (
        state && {
          ...state,
          grants: {
            ...state.grants,
            [event.grantId]: {
              id: event.grantId,
              issuer: event.issuer,
              assignee: event.assignee,
              task: event.task,
              scope: event.scope,
              state: 'offered',
              agreedIn: event.agreedIn,
              result: '',
              revision: 0,
              created: event.at,
              updated: event.at,
            },
          },
        }
      );
    case 'grant-accepted':
      return updateGrant(state, event.grantId, event.at, (g) => ({ ...g, state: 'active' }));
    case 'grant-completed':
      return updateGrant(state, event.grantId, event.at, (g) => ({ ...g, state: 'done', result: event.result }));
    case 'grant-cancelled':
      return updateGrant(state, event.grantId, event.at, (g) => ({
        ...g,
        state: 'cancelled',
        result: event.reason || g.result,
      }));
    case 'turn-revoked':
      // The turn mutation itself travels as the paired turn-passed event;
      // the revocation event is the journaled provenance record.
      return state;
    case 'agent-left':
    case 'agent-kicked':
      // Membership events mutate the LIVE projection only; the paired
      // registry-updated event carries the canonical registry transition.
      return state && { ...state, agents: state.agents.filter((a) => a !== event.agent) };
    case 'agent-joined':
      return state && { ...state, agents: [...state.agents, event.agent] };
    case 'registry-updated':
      return state && { ...state, registry: applyRegistryUpdate(state.registry, event) };
    case 'message-sent':
      return state; // delivery is the Mailbox port's concern, not session state
    case 'user-channel-registered':
      // U1: journal-authoritative binding — replay restores it; mirrors can
      // never rebind (they are views of this, not sources).
      return state && { ...state, userChannelTokenHash: event.tokenHash };
  }
}

export function replay(events: readonly Event[]): SessionState | undefined {
  return events.reduce<SessionState | undefined>(evolve, undefined);
}

/** M1: the ONE canonical registry transition — shared by evolve and the
 * fs binding. event.version becomes the state version verbatim; a rejoin
 * is a NEW admission (fresh joinedAt, leftAt cleared) that inherits
 * display/cliType/role from the prior record unless the event overrides. */
export function applyRegistryUpdate(registry: Registry, event: Extract<Event, { kind: 'registry-updated' }>): Registry {
  const agents: Record<string, AgentRecord> = { ...registry.agents };
  if (event.agent !== undefined) {
    const prev = agents[event.agent];
    if (event.change === 'joined') {
      const display = event.meta?.display ?? prev?.display;
      const cliType = event.meta?.cliType ?? prev?.cliType;
      const role = event.meta?.role ?? prev?.role;
      agents[event.agent] = liveRecord(event.agent, event.at, {
        ...(display === undefined ? {} : { display }),
        ...(cliType === undefined ? {} : { cliType }),
        ...(role === undefined ? {} : { role }),
      });
    } else if (event.change === 'left' || event.change === 'kicked') {
      agents[event.agent] = { ...(prev ?? liveRecord(event.agent, event.at)), status: 'left', leftAt: event.at };
    }
  }
  return { version: event.version, agents };
}

function liveRecord(id: string, at: string, meta?: AgentMeta): AgentRecord {
  return {
    id,
    display: meta?.display ?? id,
    status: 'active',
    joinedAt: at,
    ...(meta?.cliType === undefined ? {} : { cliType: meta.cliType }),
    ...(meta?.role === undefined ? {} : { role: meta.role }),
  };
}

function updateGrant(
  state: SessionState | undefined,
  grantId: string,
  at: string,
  fn: (g: NonNullable<SessionState['grants'][string]>) => SessionState['grants'][string],
): SessionState | undefined {
  if (!state) return state;
  const g = state.grants[grantId];
  if (!g) return state;
  const updated = fn(g);
  return {
    ...state,
    grants: { ...state.grants, [grantId]: { ...updated, revision: g.revision + 1, updated: at } },
  };
}
