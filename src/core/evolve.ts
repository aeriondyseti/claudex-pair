import type { Event } from './events.ts';
import { EMPTY_DRAFT_HASH, type AgentMeta, type AgentRecord, type Registry, type SessionState } from './types.ts';

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
      // is authorization, not membership: ONLY the initiator gets a
      // registry record (invitees get theirs at admission with a real
      // joinedAt — codex 1A round 2 #2). Legacy events lack topology → pair.
      if (event.topology === 'peer') {
        return {
          ...base,
          registry: {
            version: 0,
            agents: { [event.driver]: liveRecord(event.driver, event.at, event.meta?.[event.driver]) },
          },
          topology: 'peer' as const,
          agents: [event.driver],
          initiator: event.driver,
          phase: 'planning' as const,
          // Durable authorization (round 2 #3) lives OUTSIDE the substate.
          authorized: event.agents,
          planning: { substate: 'admitting' as const, authorizedExpected: event.agents, admitted: [event.driver] },
          attention: [],
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
    case 'agent-kicked': {
      if (!state) return state;
      const agents = state.agents.filter((a) => a !== event.agent);
      // Membership events mutate the LIVE projection only; the paired
      // registry-updated event carries the canonical registry transition.
      if (state.topology !== 'peer') return { ...state, agents };
      // Round 2 #6 churn rule: a departure during ADMITTING leaves both
      // the admitted set and the current completion set; a KICK also
      // revokes durable authorization (re-entry needs a fresh user admit),
      // while a voluntary leaver stays authorized and re-attaching
      // RE-ADMITS it.
      const authorized = event.kind === 'agent-kicked' ? state.authorized.filter((a) => a !== event.agent) : state.authorized;
      const planning = state.planning?.substate === 'admitting'
        ? {
            ...state.planning,
            admitted: state.planning.admitted.filter((a) => a !== event.agent),
            authorizedExpected: state.planning.authorizedExpected.filter((a) => a !== event.agent),
          }
        : state.planning;
      return { ...state, agents, authorized, ...(planning === undefined ? {} : { planning }) };
    }
    case 'agent-joined':
      return state && { ...state, agents: [...state.agents, event.agent] };
    case 'registry-updated':
      return state && { ...state, registry: applyRegistryUpdate(state.registry, event) };
    case 'message-sent':
      return state; // delivery is the Mailbox port's concern, not session state
    case 'agent-admitted':
      // Peer 1A: admission makes the authorized identity a MEMBER.
      return state && state.topology === 'peer'
        ? {
            ...state,
            agents: state.agents.includes(event.agent) ? state.agents : [...state.agents, event.agent],
            ...(state.planning?.substate === 'admitting'
              ? { planning: { ...state.planning, admitted: state.planning.admitted.includes(event.agent) ? state.planning.admitted : [...state.planning.admitted, event.agent] } }
              : {}),
          }
        : state;
    case 'admission-completed':
      // Superseded by the paired barrier-opened fact (round 2 #4); kept as
      // a provenance no-op for replay compatibility.
      return state;
    case 'barrier-opened':
      return state && state.topology === 'peer' && state.planning?.substate === 'admitting'
        ? { ...state, planning: { substate: 'collecting', barrier: { openedMembers: event.members, registryVersion: event.registryVersion, openedAt: event.at }, submitted: {}, abstained: [] } }
        : state;
    case 'proposal-submitted':
      return state && state.topology === 'peer' && state.planning?.substate === 'collecting'
        ? { ...state, planning: { ...state.planning, submitted: { ...state.planning.submitted, [event.author]: { contentHash: event.contentHash, bytes: event.bytes, at: event.at } } } }
        : state;
    case 'barrier-revealed': {
      if (!state || state.topology !== 'peer' || state.planning?.substate !== 'collecting') return state;
      const electorate = event.electorate;
      // Ruling B: the stored round order is the FULL frozen electorate
      // (rotated by starterIndex = 0 at reveal) — never live-filtered.
      // Holder = first LIVE member; none live -> convergence-blocked with
      // the complete unserved round-0 order retained.
      const holderIndex = electorate.findIndex((a) => state.registry.agents[a]?.status === 'active');
      const common = {
        barrier: state.planning.barrier,
        draft: { revision: 0, hash: EMPTY_DRAFT_HASH, author: null, at: event.at },
        revisionLog: [{ revision: 0, hash: EMPTY_DRAFT_HASH, author: null, at: event.at }],
        findings: {},
      };
      if (holderIndex === -1) {
        return { ...state, planning: { substate: 'convergence-blocked', rotation: { electorate, starterIndex: 0, round: 0, remaining: electorate }, ...common } };
      }
      return {
        ...state,
        planning: {
          substate: 'converging',
          rotation: { electorate, starterIndex: 0, round: 0, remaining: electorate.slice(holderIndex + 1), holder: electorate[holderIndex]! },
          ...common,
        },
      };
    }
    case 'admission-authorized': {
      if (!state || state.topology !== 'peer') return state;
      const authorized = state.authorized.includes(event.agent) ? state.authorized : [...state.authorized, event.agent];
      // During admitting the authorization also joins the CURRENT barrier
      // completion set; afterwards it is observer authorization only.
      const planning = state.planning?.substate === 'admitting'
        ? { ...state.planning, authorizedExpected: state.planning.authorizedExpected.includes(event.agent) ? state.planning.authorizedExpected : [...state.planning.authorizedExpected, event.agent] }
        : state.planning;
      return { ...state, authorized, ...(planning === undefined ? {} : { planning }) };
    }
    case 'absentee-ruled':
      if (!state || state.topology !== 'peer') return state;
      if (state.planning?.substate === 'collecting') {
        if (event.ruling === 'abstain') {
          return { ...state, planning: { ...state.planning, abstained: [...state.planning.abstained, event.agent] } };
        }
        return { ...state, planning: { ...state.planning, ...(event.newDeadlineAt === undefined ? {} : { deadlineAt: event.newDeadlineAt }) } };
      }
      if (state.planning?.substate !== 'admitting') return state;
      if (event.ruling === 'abstain') {
        return { ...state, planning: { ...state.planning, authorizedExpected: state.planning.authorizedExpected.filter((a) => a !== event.agent) } };
      }
      return { ...state, planning: { ...state.planning, ...(event.newDeadlineAt === undefined ? {} : { deadlineAt: event.newDeadlineAt }) } };
    case 'phase-transition': {
      if (!state || state.topology !== 'peer') return state;
      const { planning: _closed, ...rest } = state;
      // Leaving planning drops the planning substate wholesale; later
      // phases carry their own state (plan artifact arrives with 1C).
      return { ...rest, phase: event.to };
    }
    case 'attention-raised':
      return state && state.topology === 'peer'
        ? { ...state, attention: [...state.attention, { id: event.id, category: event.category, detail: event.detail, at: event.at }] }
        : state;
    case 'attention-cleared':
      return state && state.topology === 'peer'
        ? { ...state, attention: state.attention.filter((a) => a.id !== event.id) }
        : state;
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
    } else if (event.change === 'bound' && prev && event.binding) {
      agents[event.agent] = { ...prev, binding: event.binding };
    } else if (event.change === 'rebound' && prev) {
      const { binding: _revoked, ...rest } = prev;
      agents[event.agent] = rest;
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
