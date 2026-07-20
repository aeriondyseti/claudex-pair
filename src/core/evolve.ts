import type { Event } from './events.ts';
import type { AgentRecord, SessionState } from './types.ts';

/**
 * Pure fold: state = events.reduce(evolve, undefined). Total over every
 * (state, event) pair decide can emit; unknown combinations return state
 * unchanged rather than throwing (journal replay must never fail here).
 */
export function evolve(state: SessionState | undefined, event: Event): SessionState | undefined {
  switch (event.kind) {
    case 'session-initialized':
      return {
        task: event.task,
        agents: event.agents,
        driver: event.driver,
        turn: event.driver,
        status: 'active',
        started: event.at,
        grants: {},
        registry: {
          version: 1,
          agents: Object.fromEntries(event.agents.map((a) => [a, liveRecord(a, event.at, event.displays?.[a])])),
        },
      };
    case 'turn-passed':
      return state && { ...state, turn: event.to };
    case 'driver-changed':
      return state && { ...state, driver: event.driver };
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
      return (
        state && {
          ...state,
          agents: state.agents.filter((a) => a !== event.agent),
          registry: {
            version: state.registry.version + 1,
            agents: {
              ...state.registry.agents,
              [event.agent]: {
                ...(state.registry.agents[event.agent] ?? liveRecord(event.agent, event.at)),
                status: 'left',
                leftAt: event.at,
              },
            },
          },
        }
      );
    case 'agent-joined':
      return (
        state && {
          ...state,
          agents: [...state.agents, event.agent],
          registry: {
            version: state.registry.version + 1,
            agents: {
              ...state.registry.agents,
              // Rejoin is a NEW admission: fresh joinedAt, leftAt cleared;
              // the display survives from the previous record.
              [event.agent]: liveRecord(event.agent, event.at, state.registry.agents[event.agent]?.display),
            },
          },
        }
      );
    case 'registry-updated':
      // Notification/provenance only — the membership event carries the
      // registry mutation, so pre-M1 journals replay correctly.
      return state;
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

function liveRecord(id: string, at: string, display?: string): AgentRecord {
  return { id, display: display ?? id, status: 'active', joinedAt: at };
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
