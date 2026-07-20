import type { AgentPresence } from './viewmodel.ts';

export type DerivedPresence = {
  readonly agent: AgentPresence['agent'];
  readonly listener: AgentPresence['listener'];
  readonly listenerAgeSec?: number;
  readonly activityAgeSec?: number;
  readonly pendingCount: number;
  readonly pendingAgeSec?: number;
  readonly stalled: boolean;
};

/** Parse the protocol's timezone-less timestamp as a stable wall-clock value. */
function timestampMs(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  const [year, month, day, hour, minute, second] = parts as [number, number, number, number, number, number];
  const result = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(result);
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
    || check.getUTCHours() !== hour
    || check.getUTCMinutes() !== minute
    || check.getUTCSeconds() !== second
  ) return undefined;
  return result;
}

/** Whole elapsed seconds, clamped at zero for small clock skews. */
export function ageSeconds(now: string, then: string): number | undefined {
  const nowMs = timestampMs(now);
  const thenMs = timestampMs(then);
  if (nowMs === undefined || thenMs === undefined) return undefined;
  return Math.max(0, Math.floor((nowMs - thenMs) / 1_000));
}

export function formatAge(seconds: number | undefined): string {
  if (seconds === undefined) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
}

export function derivePresence(
  presence: AgentPresence,
  now: string,
  stalledAfterSec: number,
): DerivedPresence {
  const listenerAgeSec = presence.listener.state === 'live'
    ? ageSeconds(now, presence.listener.connectedSince)
    : undefined;
  const activityAgeSec = presence.listener.state === 'live'
    ? ageSeconds(now, presence.listener.lastActivity)
    : undefined;
  const pendingAgeSec = presence.oldestPendingSent === undefined
    ? undefined
    : ageSeconds(now, presence.oldestPendingSent);
  const threshold = Math.max(0, stalledAfterSec);

  return {
    agent: presence.agent,
    listener: presence.listener,
    ...(listenerAgeSec === undefined ? {} : { listenerAgeSec }),
    ...(activityAgeSec === undefined ? {} : { activityAgeSec }),
    pendingCount: presence.pendingCount,
    ...(pendingAgeSec === undefined ? {} : { pendingAgeSec }),
    stalled: presence.listener.state === 'none'
      && presence.pendingCount > 0
      && pendingAgeSec !== undefined
      && pendingAgeSec >= threshold,
  };
}
