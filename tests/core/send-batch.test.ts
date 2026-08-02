import { describe, expect, test } from 'bun:test';
import type { CommandEnvelope } from '../../src/core/commands.ts';
import { decide } from '../../src/core/decide.ts';
import { replay } from '../../src/core/evolve.ts';
import type { SessionState } from '../../src/core/types.ts';

/** T3 (THROUGHPUT-SPRINT): the atomic batch send — n message-sent events in
 * one txn, derived ids, shared groupId, turn on the LAST item only. */

const AT = '2026-08-02 09:00:00';
const env = (command: unknown, principal: string, id = 'batch1'): CommandEnvelope =>
  ({ command, meta: { id, at: AT, principal } }) as CommandEnvelope;
const code = (r: ReturnType<typeof decide>) => (r.ok ? '' : (r.error as { code?: string }).code);

function pairSession(): SessionState {
  const init = decide(undefined, env({ kind: 'init-session', task: 't', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-b-0001' }, 'claude', 'init1'));
  if (!init.ok) throw init.error;
  return replay(init.value)!;
}

const items = (...bodies: string[]) => bodies.map((body) => ({ body }));

describe('T3 send-batch', () => {
  test('a 3-item ask batch emits 3 message-sent + turn-passed; ids derive from the envelope, turn rides the last item', () => {
    const r = decide(pairSession(), env({ kind: 'send-batch', to: 'codex', type: 'ask', turn: 'pass', items: items('## q1\nfirst', '## q2\nsecond', '## q3\nthird') }, 'claude'));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    expect(r.value).toHaveLength(4);
    const sent = r.value.filter((e) => e.kind === 'message-sent');
    expect(sent.map((e) => (e as { id: string }).id)).toEqual(['batch1-b1', 'batch1-b2', 'batch1-b3']);
    expect(sent.map((e) => (e as { turn: string }).turn)).toEqual(['keep', 'keep', 'pass']);
    expect(sent.every((e) => (e as { groupId?: string }).groupId === 'batch1')).toBeTrue();
    expect(r.value[3]).toEqual({ kind: 'turn-passed', to: 'codex' });
  });

  test('turn keep emits no turn-passed and keeps every item keep', () => {
    const r = decide(pairSession(), env({ kind: 'send-batch', to: 'codex', type: 'ask', turn: 'keep', items: items('## a', '## b') }, 'claude'));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    expect(r.value.every((e) => e.kind === 'message-sent' && e.turn === 'keep')).toBeTrue();
  });

  test('an answer batch requires a reply target on every item', () => {
    const s = pairSession();
    const missing = decide(s, env({ kind: 'send-batch', to: 'codex', type: 'answer', turn: 'pass', items: [{ body: 'a1', replyTo: 'ask-1' }, { body: 'a2' }] }, 'claude'));
    expect(code(missing)).toBe('invalid-batch');
    const tagged = decide(s, env({ kind: 'send-batch', to: 'codex', type: 'answer', turn: 'pass', items: [{ body: 'a1', replyTo: 'ask-1' }, { body: 'a2', replyTo: 'ask-2' }] }, 'claude'));
    expect(tagged.ok).toBeTrue();
    if (tagged.ok) expect(tagged.value.filter((e) => e.kind === 'message-sent').map((e) => (e as { replyTo?: string }).replyTo)).toEqual(['ask-1', 'ask-2']);
  });

  test('bounds and authority: 1 item, 17 items, wrong type, empty body, not-your-turn', () => {
    const s = pairSession();
    expect(code(decide(s, env({ kind: 'send-batch', to: 'codex', type: 'ask', turn: 'pass', items: items('only') }, 'claude')))).toBe('invalid-batch');
    expect(code(decide(s, env({ kind: 'send-batch', to: 'codex', type: 'ask', turn: 'pass', items: items(...Array.from({ length: 17 }, (_, i) => `item ${i}`)) }, 'claude')))).toBe('invalid-batch');
    expect(code(decide(s, env({ kind: 'send-batch', to: 'codex', type: 'info', turn: 'keep', items: items('a', 'b') }, 'claude')))).toBe('invalid-batch');
    expect(code(decide(s, env({ kind: 'send-batch', to: 'codex', type: 'ask', turn: 'pass', items: items('a', '   ') }, 'claude')))).toBe('invalid-batch');
    expect(code(decide(s, env({ kind: 'send-batch', to: 'claude', type: 'ask', turn: 'pass', items: items('a', 'b') }, 'codex')))).toBe('not-your-turn');
    expect(code(decide(s, env({ kind: 'send-batch', to: 'claude', type: 'ask', turn: 'keep', items: items('a', 'b') }, 'codex')))).toBe(''); // FYI batch off-turn is legal
  });
});
