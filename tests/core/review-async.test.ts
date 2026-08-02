import { describe, expect, test } from 'bun:test';
import type { CommandEnvelope } from '../../src/core/commands.ts';
import type { Event } from '../../src/core/events.ts';
import { decide } from '../../src/core/decide.ts';
import { evolve, replay } from '../../src/core/evolve.ts';
import type { SessionState } from '../../src/core/types.ts';

/** T4 (THROUGHPUT-SPRINT): pipelined async review — request lifecycle,
 * HIGH/MED gates on handoff/end, lapse, and membership cleanup. */

const AT = '2026-08-02 12:00:00';
const env = (command: unknown, principal: string, id: string, at = AT): CommandEnvelope =>
  ({ command, meta: { id, at, principal } }) as CommandEnvelope;
const code = (r: ReturnType<typeof decide>) => (r.ok ? '' : (r.error as { code?: string }).code);
const apply = (s: SessionState, events: readonly Event[]): SessionState =>
  events.reduce<SessionState | undefined>((acc, e) => (acc ? (evolve(acc, e) ?? acc) : acc), s)!;

function pairSession(): SessionState {
  const init = decide(undefined, env({ kind: 'init-session', task: 't', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-r-0001' }, 'claude', 'init1'));
  if (!init.ok) throw init.error;
  return replay(init.value)!;
}

/** Run a command through decide and fold its events into the state. */
function step(s: SessionState, command: unknown, principal: string, id: string): SessionState {
  const r = decide(s, env(command, principal, id));
  if (!r.ok) throw new Error(`rejected: ${(r.error as { code?: string }).code}`);
  return apply(s, r.value);
}

describe('T4 async review request', () => {
  test('emits reviewAsync + lapseAt (default 900s, custom -LapseSec), registers in state, keeps the turn', () => {
    const s = pairSession();
    const r = decide(s, env({ kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'review inc A', reviewAsync: true }, 'claude', 'ask1'));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    const sent = r.value[0]!;
    expect(sent).toMatchObject({ kind: 'message-sent', reviewAsync: true, lapseAt: '2026-08-02 12:15:00' });
    const after = apply(s, r.value);
    expect(after.reviewRequests).toEqual({ ask1: { from: 'claude', to: 'codex', at: AT, lapseAt: '2026-08-02 12:15:00' } });
    expect(after.topology === 'pair' && after.turn).toBe('claude'); // turn NEVER moved

    const custom = decide(s, env({ kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'x', reviewAsync: true, lapseSec: 60 }, 'claude', 'ask2'));
    expect(custom.ok && (custom.value[0] as { lapseAt?: string }).lapseAt).toBe('2026-08-02 12:01:00');
  });

  test('rejections: async on non-ask, async with turn pass, bad lapseSec, severity off-review', () => {
    const s = pairSession();
    expect(code(decide(s, env({ kind: 'send-message', to: 'codex', type: 'info', turn: 'keep', body: 'x', reviewAsync: true }, 'claude', 'b1')))).toBe('invalid-review-request');
    expect(code(decide(s, env({ kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'x', reviewAsync: true }, 'claude', 'b2')))).toBe('invalid-review-request');
    expect(code(decide(s, env({ kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'x', reviewAsync: true, lapseSec: 0 }, 'claude', 'b3')))).toBe('invalid-review-request');
    expect(code(decide(s, env({ kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'x', lapseSec: 60 }, 'claude', 'b4')))).toBe('invalid-review-request');
    expect(code(decide(s, env({ kind: 'send-message', to: 'codex', type: 'info', turn: 'keep', body: 'x', severity: 'HIGH' }, 'claude', 'b5')))).toBe('invalid-review-request');
  });

  test('a tagged review closes the request; an untagged review settles the oldest', () => {
    let s = pairSession();
    s = step(s, { kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'r1', reviewAsync: true }, 'claude', 'ask1');
    s = step(s, { kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'r2', reviewAsync: true }, 'claude', 'ask2');
    expect(Object.keys(s.reviewRequests ?? {})).toEqual(['ask1', 'ask2']);
    s = step(s, { kind: 'send-message', to: 'claude', type: 'review', turn: 'keep', body: 'lgtm', replyTo: 'ask2', severity: 'LOW' }, 'codex', 'rev1');
    expect(Object.keys(s.reviewRequests ?? {})).toEqual(['ask1']);
    s = step(s, { kind: 'send-message', to: 'claude', type: 'review', turn: 'keep', body: 'lgtm too' }, 'codex', 'rev2');
    expect(Object.keys(s.reviewRequests ?? {})).toEqual([]);
    expect(s.reviewGates ?? {}).toEqual({}); // LOW/absent severity opens no gate
  });
});

describe('T4 review gates', () => {
  test('HIGH verdict gates handoff and end until a tagged answer clears it', () => {
    let s = pairSession();
    s = step(s, { kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'review', reviewAsync: true }, 'claude', 'ask1');
    s = step(s, { kind: 'send-message', to: 'claude', type: 'review', turn: 'keep', body: 'off-by-one in fold', replyTo: 'ask1', severity: 'HIGH' }, 'codex', 'rev1');
    expect(s.reviewGates).toEqual({ rev1: { severity: 'HIGH', from: 'codex', at: AT } });

    expect(code(decide(s, env({ kind: 'send-message', to: 'codex', type: 'handoff', turn: 'pass', body: 'take over' }, 'claude', 'h1')))).toBe('unresolved-review-findings');
    expect(code(decide(s, env({ kind: 'end-session', summary: 'done' }, 'claude', 'e1')))).toBe('unresolved-review-findings');
    expect(code(decide(s, env({ kind: 'send-message', to: 'codex', type: 'done', turn: 'keep', body: 'done' }, 'claude', 'd1')))).toBe('unresolved-review-findings');

    // An ordinary ask still flows — the gate blocks role transitions only.
    expect(decide(s, env({ kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' }, 'claude', 'q1')).ok).toBeTrue();

    s = step(s, { kind: 'send-message', to: 'codex', type: 'answer', turn: 'keep', body: 'fixed in abc123', replyTo: 'rev1' }, 'claude', 'ans1');
    expect(s.reviewGates ?? {}).toEqual({});
    expect(decide(s, env({ kind: 'send-message', to: 'codex', type: 'handoff', turn: 'pass', body: 'take over' }, 'claude', 'h2')).ok).toBeTrue();
    expect(decide(s, env({ kind: 'end-session', summary: 'done' }, 'claude', 'e2')).ok).toBeTrue();
  });

  test('review-lapsed clears the request; a kicked reviewer takes its requests and gates with it', () => {
    let s = pairSession();
    s = step(s, { kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'r', reviewAsync: true }, 'claude', 'ask1');
    const lapsed = evolve(s, { kind: 'review-lapsed', id: 'ask1', at: AT })!;
    expect(lapsed.reviewRequests ?? {}).toEqual({});

    s = step(s, { kind: 'send-message', to: 'claude', type: 'review', turn: 'keep', body: 'bad', replyTo: 'ask1', severity: 'MED' }, 'codex', 'rev1');
    s = step(s, { kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'r2', reviewAsync: true }, 'claude', 'ask2');
    const kicked = apply(s, [{ kind: 'agent-kicked', agent: 'codex', reason: 'stale', at: AT }]);
    expect(kicked.reviewGates ?? {}).toEqual({});
    expect(kicked.reviewRequests ?? {}).toEqual({});
  });
});
