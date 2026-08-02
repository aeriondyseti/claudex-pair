import type { Event } from './events.ts';
import type { AgentId, MessageType, Timestamp } from './types.ts';
import { applyMessageToAwaiting, removeAgentFromAwaiting, type AwaitingEntry } from './awaiting.ts';

/**
 * Throughput sprint T1 — pure fold turning journal records into session
 * throughput metrics (docs/THROUGHPUT-SPRINT.md). Everything here derives
 * from the WAL vocabulary; nothing is measured that the journal does not
 * already record. Second-granularity timestamps bound the precision: turn
 * holds and ask latencies are honest at this scale, delivery latency is not
 * measurable here and deliberately not reported.
 */

/** The slice of a TxnRecord the fold needs (broker's TxnRecord satisfies it). */
export type StatsRecord = {
  readonly seq: number;
  readonly principal: string;
  readonly at: Timestamp;
  readonly events: readonly Event[];
};

export type HoldStats = {
  /** Total seconds this agent held the turn (pair turn or convergence rotation). */
  totalSec: number;
  holds: number;
};

export type ResolvedAsk = {
  readonly messageId: string;
  readonly from: AgentId;
  readonly to: AgentId;
  readonly latencySec: number | null;
};

export type SessionStats = {
  task: string | null;
  sessionId: string | null;
  topology: 'pair' | 'peer' | null;
  agents: AgentId[];
  /** Journal coverage — firstSeq > 1 means earlier history was trimmed into
   * a snapshot and these numbers cover a suffix of the session only. */
  coverage: { firstSeq: number; lastSeq: number; firstAt: Timestamp; lastAt: Timestamp; spanSec: number | null; complete: boolean };
  ended: boolean;
  messages: { total: number; byType: Record<string, number>; byFrom: Record<string, number> };
  turns: { passes: number; byAgent: Record<AgentId, HoldStats> };
  asks: {
    asked: number;
    /** T4: async review requests that resolved as recorded lapsed-consent.
     * A high rate means the consent window is too short or the reviewer is
     * overloaded — the safety signal for the async-review default. */
    lapsed: number;
    resolved: ResolvedAsk[];
    /** Asks still unresolved at the journal head, with age relative to the
     * last record (not wall-clock now — the fold is pure). */
    open: { messageId: string; from: AgentId; to: AgentId; ageSec: number | null }[];
  };
  attention: { raised: number; cleared: number; blockedSec: number; openIds: string[] };
  planning: {
    barrierOpenSec: number | null;
    rounds: number;
    findingsFiled: number;
    findingsSettled: number;
    ballots: { called: number; passed: number; rejected: number; voided: number };
  };
};

/** 'yyyy-MM-dd HH:mm:ss' → epoch ms (local), or null if unparseable. */
export function parseTimestamp(at: Timestamp): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(at);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

const spanSec = (from: Timestamp | null, to: Timestamp | null): number | null => {
  if (from === null || to === null) return null;
  const a = parseTimestamp(from);
  const b = parseTimestamp(to);
  return a === null || b === null ? null : Math.max(0, Math.round((b - a) / 1000));
};

export function foldStats(records: readonly StatsRecord[]): SessionStats {
  const ordered = [...records].sort((a, b) => a.seq - b.seq);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const stats: SessionStats = {
    task: null, sessionId: null, topology: null, agents: [],
    coverage: {
      firstSeq: first?.seq ?? 0, lastSeq: last?.seq ?? 0,
      firstAt: first?.at ?? '', lastAt: last?.at ?? '',
      spanSec: first && last ? spanSec(first.at, last.at) : null,
      complete: (first?.seq ?? 1) === 1,
    },
    ended: false,
    messages: { total: 0, byType: {}, byFrom: {} },
    turns: { passes: 0, byAgent: {} },
    asks: { asked: 0, lapsed: 0, resolved: [], open: [] },
    attention: { raised: 0, cleared: 0, blockedSec: 0, openIds: [] },
    planning: { barrierOpenSec: null, rounds: 0, findingsFiled: 0, findingsSettled: 0, ballots: { called: 0, passed: 0, rejected: 0, voided: 0 } },
  };

  // Turn accounting: the holder and when it acquired the turn. turn-passed
  // carries no `at` by design (events.ts) — the enclosing record's `at` is
  // the transition time; convergence events carry their own.
  let holder: AgentId | null = null;
  let holderSince: Timestamp | null = null;
  const closeHold = (upTo: Timestamp): void => {
    if (holder === null || holderSince === null) return;
    const held = spanSec(holderSince, upTo);
    const entry = (stats.turns.byAgent[holder] ??= { totalSec: 0, holds: 0 });
    entry.holds += 1;
    if (held !== null) entry.totalSec += held;
  };
  const moveTurn = (to: AgentId | null, at: Timestamp): void => {
    closeHold(at);
    holder = to;
    holderSince = to === null ? null : at;
  };

  const awaiting = new Map<string, AwaitingEntry>();
  const attentionOpen = new Map<string, Timestamp>();
  let barrierOpenedAt: Timestamp | null = null;

  for (const record of ordered) {
    for (const event of record.events) {
      switch (event.kind) {
        case 'session-initialized': {
          stats.task = event.task;
          stats.sessionId = event.sessionId ?? null;
          stats.topology = event.topology ?? 'pair';
          stats.agents = [...event.agents];
          if (stats.topology === 'pair') { holder = event.driver; holderSince = event.at; }
          break;
        }
        case 'registry-updated': {
          if (event.change === 'joined' && event.agent && !stats.agents.includes(event.agent)) stats.agents.push(event.agent);
          break;
        }
        case 'message-sent': {
          stats.messages.total += 1;
          stats.messages.byType[event.type] = (stats.messages.byType[event.type] ?? 0) + 1;
          stats.messages.byFrom[event.from] = (stats.messages.byFrom[event.from] ?? 0) + 1;
          if (event.type === 'ask') stats.asks.asked += 1;
          // Resolution detection: diff the awaiting set around the shared rule
          // (awaiting.ts is the ONE resolution rule; stats must never re-derive it).
          const before = new Map(awaiting);
          applyMessageToAwaiting(awaiting, { id: event.id, from: event.from, to: event.to, type: event.type, sent: event.at, ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }) });
          for (const [id, entry] of before) {
            if (!awaiting.has(id)) stats.asks.resolved.push({ messageId: id, from: entry.from, to: entry.to, latencySec: spanSec(entry.sentAt, event.at) });
          }
          break;
        }
        case 'turn-passed': {
          stats.turns.passes += 1;
          moveTurn(event.to, record.at);
          break;
        }
        case 'convergence-turn-passed': {
          stats.turns.passes += 1;
          stats.planning.rounds = Math.max(stats.planning.rounds, event.round);
          if (holder === null) { holder = event.from; holderSince = event.at; }
          moveTurn(event.to, event.at);
          break;
        }
        case 'convergence-halted': { moveTurn(null, record.at); break; }
        case 'convergence-resumed': { holder = event.holder; holderSince = event.at; break; }
        case 'barrier-opened': { barrierOpenedAt = event.at; break; }
        case 'barrier-revealed': {
          stats.planning.barrierOpenSec = spanSec(barrierOpenedAt, event.at);
          // The rotation seats the first electorate member at reveal.
          holder = event.electorate[0] ?? null;
          holderSince = holder === null ? null : event.at;
          break;
        }
        case 'review-lapsed': { awaiting.delete(event.id); stats.asks.lapsed += 1; break; }
        case 'attention-raised': { stats.attention.raised += 1; attentionOpen.set(event.id, event.at); break; }
        case 'attention-cleared': {
          stats.attention.cleared += 1;
          const raisedAt = attentionOpen.get(event.id);
          if (raisedAt !== undefined) {
            attentionOpen.delete(event.id);
            stats.attention.blockedSec += spanSec(raisedAt, event.at) ?? 0;
          }
          break;
        }
        case 'finding-filed': { stats.planning.findingsFiled += 1; break; }
        case 'finding-responded': { if (event.disposition === 'concede') stats.planning.findingsSettled += 1; break; }
        case 'finding-confirmed': { if (event.verdict === 'accept') stats.planning.findingsSettled += 1; break; }
        case 'finding-amended': { if (event.action === 'withdraw') stats.planning.findingsSettled += 1; break; }
        case 'question-called': { stats.planning.ballots.called += 1; break; }
        case 'ballot-passed': { stats.planning.ballots.passed += 1; break; }
        case 'ballot-closed': {
          if (event.outcome === 'rejected') stats.planning.ballots.rejected += 1;
          else stats.planning.ballots.voided += 1;
          break;
        }
        case 'agent-left':
        case 'agent-kicked': {
          removeAgentFromAwaiting(awaiting, event.agent);
          if (holder === event.agent) moveTurn(null, event.at);
          break;
        }
        case 'session-ended': {
          stats.ended = true;
          awaiting.clear();
          moveTurn(null, event.at);
          break;
        }
        default: break;
      }
    }
  }
  if (!stats.ended && last) closeHold(last.at);
  stats.attention.openIds = [...attentionOpen.keys()];
  for (const entry of awaiting.values()) {
    stats.asks.open.push({ messageId: entry.messageId, from: entry.from, to: entry.to, ageSec: last ? spanSec(entry.sentAt, last.at) : null });
  }
  return stats;
}

/** Latency distribution over the resolved asks that have a measurable latency. */
export function latencySummary(resolved: readonly ResolvedAsk[]): { count: number; meanSec: number; p50Sec: number; p90Sec: number } | null {
  const xs = resolved.map((r) => r.latencySec).filter((s): s is number => s !== null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
  return { count: xs.length, meanSec: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), p50Sec: at(0.5), p90Sec: at(0.9) };
}

/** Message-type sort order for rendering: protocol conversation first. */
export const MESSAGE_TYPE_ORDER: readonly MessageType[] = ['ask', 'answer', 'review', 'handoff', 'info', 'proposal', 'propose-end', 'grant', 'grant-done', 'grant-cancel', 'turn-revoked', 'join', 'leave', 'kick', 'done'];
