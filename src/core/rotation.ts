/** 1B-c convergence rotation (design rev 4 Ruling B). Pure, total,
 * deterministic — the ONE advance algorithm, shared by decide (yield +
 * departure), evolve (event recomputation), and the broker (rejoin holder).
 * Imports nothing but types, like all of core/. */
import type { AgentId, BlockedRotation, Registry, Rotation } from './types.ts';

/** electorate rotated left so index `start` becomes position 0. */
export function rotateFrom(electorate: readonly AgentId[], start: number): AgentId[] {
  const n = electorate.length;
  if (n === 0) return [];
  const s = ((start % n) + n) % n;
  return [...electorate.slice(s), ...electorate.slice(0, s)];
}

function isActive(registry: Registry, agent: AgentId | undefined, leaving?: AgentId): boolean {
  if (agent === undefined || agent === leaving) return false;
  return registry.agents[agent]?.status === 'active';
}

/** The outcome of advancing the rotation from the current holder. `passed`
 * seats a live successor (same round, or a rolled-over new round); `blocked`
 * retains the unserved order live-unfiltered (Ruling B). */
export type AdvanceOutcome =
  | { readonly kind: 'passed'; readonly holder: AgentId; readonly remaining: AgentId[]; readonly round: number; readonly starterIndex: number }
  | { readonly kind: 'blocked'; readonly remaining: AgentId[]; readonly round: number; readonly starterIndex: number };

/**
 * Advance past the current holder (yield, or holder departure — pass the
 * departing id as `leaving` so decide, whose registry has not yet applied the
 * departure, matches evolve, whose registry has). Skipped non-live members at
 * the FRONT of `remaining` are consumed as they are skipped; the successor
 * takes the turn. An empty remainder completes the round: the starter index
 * advances cyclically to the next LIVE frozen index (round+1); with no live
 * member anywhere it advances one FROZEN index and blocks with the full
 * rotated order retained.
 */
export function advanceRotation(rotation: Rotation, registry: Registry, leaving?: AgentId): AdvanceOutcome {
  const { electorate, starterIndex, round, remaining } = rotation;
  const rem = remaining.filter((a) => a !== leaving);
  const nextIdx = rem.findIndex((a) => isActive(registry, a, leaving));
  if (nextIdx >= 0) {
    return { kind: 'passed', holder: rem[nextIdx]!, remaining: rem.slice(nextIdx + 1), round, starterIndex };
  }
  if (rem.length > 0) {
    // Unserved slots remain but none is live — block, retaining them (Ruling B).
    return { kind: 'blocked', remaining: rem, round, starterIndex };
  }
  // Round completed: advance the starter cyclically to the next live index.
  const n = electorate.length;
  const newRound = round + 1;
  for (let k = 1; k <= n; k++) {
    const i = (starterIndex + k) % n;
    if (isActive(registry, electorate[i], leaving)) {
      const order = rotateFrom(electorate, i);
      return { kind: 'passed', holder: order[0]!, remaining: order.slice(1), round: newRound, starterIndex: i };
    }
  }
  // No live member at all — roll to the next FROZEN index and block with the
  // complete rotated order (never live-filtered; Ruling B).
  const nsi = n === 0 ? starterIndex : (starterIndex + 1) % n;
  return { kind: 'blocked', remaining: rotateFrom(electorate, nsi), round: newRound, starterIndex: nsi };
}

/** Rejoin: pick the holder a blocked convergence resumes with — the first
 * live member of the stored order (post-admission), else the rejoiner (the
 * round-completion path where the rejoiner already served or joined late).
 * evolve derives the resulting rotation from this holder deterministically. */
export function resumeHolder(rotation: BlockedRotation, registry: Registry, rejoiner: AgentId): AgentId {
  const live = (a: AgentId): boolean => a === rejoiner || registry.agents[a]?.status === 'active';
  return rotation.remaining.find(live) ?? rejoiner;
}
