import type { AgentId, SessionState } from './types.ts';

/** Derived views. Pure. */

export function navigators(s: SessionState): readonly AgentId[] {
  return s.agents.filter((a) => a !== s.driver);
}

/**
 * Default recipient: unambiguous only when exactly one other agent exists
 * (n = 2 is the regular case, not a special one).
 */
export function resolveRecipient(s: SessionState, from: AgentId): AgentId | undefined {
  const others = s.agents.filter((a) => a !== from);
  return others.length === 1 ? others[0] : undefined;
}

export function openGrants(s: SessionState) {
  return Object.values(s.grants)
    .filter((g) => g.state === 'offered' || g.state === 'active')
    .sort((a, b) => a.id.localeCompare(b.id));
}
