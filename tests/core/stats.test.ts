import { describe, expect, test } from 'bun:test';
import type { Event } from '../../src/core/events.ts';
import { foldStats, latencySummary, parseTimestamp, type StatsRecord } from '../../src/core/stats.ts';

/** T1 (docs/THROUGHPUT-SPRINT.md): the pure stats fold. Synthetic records
 * exercise the awaiting edge cases (tagged/untagged resolution, kick
 * cleanup), turn accounting across revoke, and the attention spans. */

const at = (m: number, s = 0) => `2026-08-01 10:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

let seq = 0;
const rec = (atStr: string, principal: string, ...events: Event[]): StatsRecord => ({ seq: ++seq, principal, at: atStr, events });

const msg = (id: string, from: string, to: string, type: string, atStr: string, extra: Record<string, unknown> = {}): Event =>
  ({ kind: 'message-sent', id, from, to, type, turn: 'keep', body: 'x', at: atStr, ...extra }) as Event;

function pairSession(): StatsRecord[] {
  seq = 0;
  return [
    rec(at(0), 'claude', { kind: 'session-initialized', task: 'ship the sprint', agents: ['claude', 'codex'], driver: 'claude', at: at(0), sessionId: 's-1' }),
    // claude works 5m, sends an ask passing the turn.
    rec(at(5), 'claude', msg('a1', 'claude', 'codex', 'ask', at(5), { turn: 'pass' }), { kind: 'turn-passed', to: 'codex' }),
    // codex answers (tagged) after 3m, passing back.
    rec(at(8), 'codex', msg('r1', 'codex', 'claude', 'answer', at(8), { turn: 'pass', replyTo: 'a1' }), { kind: 'turn-passed', to: 'claude' }),
    // claude asks again (untagged answer path) — 2m later.
    rec(at(10), 'claude', msg('a2', 'claude', 'codex', 'ask', at(10), { turn: 'pass' }), { kind: 'turn-passed', to: 'codex' }),
    // codex replies UNTAGGED after 6m — settles the oldest (only) open debt.
    rec(at(16), 'codex', msg('r2', 'codex', 'claude', 'answer', at(16), { turn: 'pass' }), { kind: 'turn-passed', to: 'claude' }),
    // an ask that never resolves, turn kept.
    rec(at(18), 'claude', msg('a3', 'claude', 'codex', 'ask', at(18))),
    // attention raised then cleared 4m later.
    rec(at(20), 'claude', { kind: 'attention-raised', id: 'att1', category: 'deadline-expired', detail: 'x', at: at(20) }),
    rec(at(24), 'claude', { kind: 'attention-cleared', id: 'att1', at: at(24) }),
    // end at minute 30.
    rec(at(30), 'claude', msg('d1', 'claude', 'codex', 'done', at(30)), { kind: 'session-ended', by: 'claude', summary: 'done', at: at(30) }),
  ];
}

describe('T1 stats fold', () => {
  test('turn holds, ask latencies, attention spans over a pair session', () => {
    const s = foldStats(pairSession());
    expect(s.task).toBe('ship the sprint');
    expect(s.topology).toBe('pair');
    expect(s.ended).toBeTrue();
    expect(s.coverage.complete).toBeTrue();
    expect(s.coverage.spanSec).toBe(30 * 60);

    // Holds: claude 0-5, 8-10, 16-30(end) = 5+2+14 = 21m; codex 5-8 + 10-16 = 9m.
    expect(s.turns.passes).toBe(4);
    expect(s.turns.byAgent['claude']).toEqual({ totalSec: 21 * 60, holds: 3 });
    expect(s.turns.byAgent['codex']).toEqual({ totalSec: 9 * 60, holds: 2 });

    // Asks: 3 asked, 2 resolved (3m tagged, 6m untagged), a3 cleared by session end.
    expect(s.asks.asked).toBe(3);
    expect(s.asks.resolved.map((r) => [r.messageId, r.latencySec])).toEqual([['a1', 180], ['a2', 360]]);
    expect(s.asks.open).toEqual([]);
    const lat = latencySummary(s.asks.resolved)!;
    expect(lat.count).toBe(2);
    expect(lat.meanSec).toBe(270);

    expect(s.attention).toEqual({ raised: 1, cleared: 1, blockedSec: 240, openIds: [] });
    expect(s.messages.byType).toEqual({ ask: 3, answer: 2, done: 1 });
  });

  test('an unresolved ask stays open with an age at the journal head', () => {
    const records = pairSession().slice(0, -1); // drop the session end
    const s = foldStats(records);
    expect(s.ended).toBeFalse();
    expect(s.asks.open).toEqual([{ messageId: 'a3', from: 'claude', to: 'codex', ageSec: 6 * 60 }]);
  });

  test('a kick drops the kicked agent from awaiting and closes its hold', () => {
    seq = 0;
    const records = [
      rec(at(0), 'claude', { kind: 'session-initialized', task: 't', agents: ['claude', 'codex'], driver: 'claude', at: at(0) }),
      rec(at(2), 'claude', msg('a1', 'claude', 'codex', 'ask', at(2), { turn: 'pass' }), { kind: 'turn-passed', to: 'codex' }),
      rec(at(6), 'claude', { kind: 'agent-kicked', agent: 'codex', reason: 'stale', at: at(6) }, { kind: 'turn-passed', to: 'claude' }),
    ];
    const s = foldStats(records);
    expect(s.asks.open).toEqual([]); // membership cleanup, not resolution
    expect(s.asks.resolved).toEqual([]);
    expect(s.turns.byAgent['codex']).toEqual({ totalSec: 4 * 60, holds: 1 });
  });

  test('turn revocation attributes the held time to the revoked holder', () => {
    seq = 0;
    const records = [
      rec(at(0), 'claude', { kind: 'session-initialized', task: 't', agents: ['claude', 'codex'], driver: 'claude', at: at(0) }),
      rec(at(1), 'claude', msg('a1', 'claude', 'codex', 'ask', at(1), { turn: 'pass' }), { kind: 'turn-passed', to: 'codex' }),
      rec(at(11), 'claude', { kind: 'turn-revoked', from: 'codex', reason: 'unresponsive', at: at(11) }, { kind: 'turn-passed', to: 'claude' }),
      rec(at(12), 'claude', msg('i1', 'claude', 'codex', 'info', at(12))),
    ];
    const s = foldStats(records);
    expect(s.turns.byAgent['codex']).toEqual({ totalSec: 600, holds: 1 });
    expect(s.turns.byAgent['claude']).toEqual({ totalSec: 120, holds: 2 });
  });

  test('peer planning: barrier span, convergence rounds and holds, ballot tallies', () => {
    seq = 0;
    const records = [
      rec(at(0), 'claude', { kind: 'session-initialized', task: 'peer', agents: ['claude', 'codex'], driver: 'claude', at: at(0), sessionId: 's-2', topology: 'peer' }),
      rec(at(1), 'claude', { kind: 'barrier-opened', members: ['claude', 'codex'], registryVersion: 1, at: at(1) }),
      rec(at(9), 'codex', { kind: 'barrier-revealed', electorate: ['claude', 'codex'], at: at(9) }),
      // claude (electorate[0]) holds 9-14, yields; codex 14-20, yields into round 2.
      rec(at(14), 'claude', { kind: 'convergence-turn-passed', from: 'claude', to: 'codex', round: 1, at: at(14) }),
      rec(at(20), 'codex', { kind: 'convergence-turn-passed', from: 'codex', to: 'claude', round: 2, at: at(20) }),
      rec(at(21), 'claude', { kind: 'finding-filed', id: 'f1', author: 'claude', addressedTo: 'codex', anchor: { kind: 'draft', revision: 1 }, severity: 'MED', agreement: 'partial', text: 'x', bytes: 1, textHash: 'h', at: at(21) }),
      rec(at(22), 'codex', { kind: 'finding-responded', id: 'f1', disposition: 'concede', text: 'y', bytes: 1, textHash: 'h', at: at(22) }),
      rec(at(23), 'claude', { kind: 'question-called', revision: 2, revisionHash: 'r', electorate: ['claude', 'codex'], taskBlock: { plan: { wip_cap: 1, verification: { fast_gate: 'bun test' } }, tasks: [] }, calledBy: 'claude', at: at(23) }),
      rec(at(24), 'codex', { kind: 'vote-cast', voter: 'codex', approve: false, reasons: 'no', at: at(24) }, { kind: 'ballot-closed', outcome: 'rejected', at: at(24) }),
    ];
    const s = foldStats(records);
    expect(s.topology).toBe('peer');
    expect(s.planning.barrierOpenSec).toBe(8 * 60);
    expect(s.planning.rounds).toBe(2);
    expect(s.planning.findingsFiled).toBe(1);
    expect(s.planning.findingsSettled).toBe(1);
    expect(s.planning.ballots).toEqual({ called: 1, passed: 0, rejected: 1, voided: 0 });
    // claude: 9-14 (yield), then 20 -> journal head 24 (ongoing hold closes at head).
    expect(s.turns.byAgent['claude']).toEqual({ totalSec: 9 * 60, holds: 2 });
    expect(s.turns.byAgent['codex']).toEqual({ totalSec: 6 * 60, holds: 1 });
    expect(s.turns.passes).toBe(2);
  });

  test('trimmed history is reported as partial coverage', () => {
    seq = 41;
    const records = [rec(at(50), 'claude', msg('i9', 'claude', 'codex', 'info', at(50)))];
    const s = foldStats(records);
    expect(s.coverage.complete).toBeFalse();
    expect(s.coverage.firstSeq).toBe(42);
    expect(s.task).toBeNull();
  });

  test('parseTimestamp round-trips the journal format and rejects junk', () => {
    expect(parseTimestamp('2026-08-01 10:30:00')).toBe(new Date(2026, 7, 1, 10, 30, 0).getTime());
    expect(parseTimestamp('not a time')).toBeNull();
  });
});
