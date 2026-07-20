import { describe, expect, test } from 'bun:test';
import type { CommandEnvelope } from '../../src/core/commands.ts';
import { decide } from '../../src/core/decide.ts';
import type { Event } from '../../src/core/events.ts';
import { evolve, replay } from '../../src/core/evolve.ts';
import { MAX_AGENTS, type SessionState } from '../../src/core/types.ts';

/** M1 registry hardening (peer-model prerequisite 3): lifecycle records,
 * monotonic versioning, registry-updated provenance, ids-vs-display, and
 * the bounded roster — tests-first per the session task. */

const AT = '2026-07-20 14:00:00';
const env = (command: unknown, principal: string, id: string, at = AT): CommandEnvelope =>
  ({ command, meta: { id, at, principal } }) as CommandEnvelope;

function run(state: SessionState | undefined, command: unknown, principal: string, id: string, at = AT): Event[] {
  const d = decide(state, env(command, principal, id, at));
  if (!d.ok) throw d.error;
  return d.value;
}

function applyAll(state: SessionState, events: readonly Event[]): SessionState {
  return events.reduce<SessionState | undefined>(evolve, state)!;
}

function initEvents(agents: string[] = ['claude', 'codex'], meta?: Record<string, { display?: string; cliType?: string; role?: string }>): Event[] {
  return run(undefined, { kind: 'init-session', task: 't', agents, driver: agents[0]!, sessionId: 'session-0001', ...(meta ? { meta } : {}) }, agents[0]!, 'i1');
}

const registryUpdates = (events: readonly Event[]) => events.filter((e) => e.kind === 'registry-updated');

describe('M1: init builds the registry', () => {
  test('v1 with active records, display defaulting to id, full per-agent config honored', () => {
    const events = initEvents(['claude', 'codex'], { codex: { display: 'Codex CLI', cliType: 'codex', role: 'reviewer' } });
    const s = replay(events)!;
    expect(s.sessionId).toBe('session-0001');
    expect(s.registry.version).toBe(1);
    expect(s.registry.agents['claude']).toEqual({ id: 'claude', display: 'claude', status: 'active', joinedAt: AT });
    expect(s.registry.agents['codex']).toEqual({ id: 'codex', display: 'Codex CLI', cliType: 'codex', role: 'reviewer', status: 'active', joinedAt: AT });
    expect(registryUpdates(events)).toEqual([{ kind: 'registry-updated', version: 1, change: 'init', at: AT }]);
  });

  test('sessionId binds outgoing conversational message headers', () => {
    const s = replay(initEvents())!;
    const sent = run(s, { kind: 'send-message', to: 'codex', type: 'info', turn: 'keep', body: 'x' }, 'claude', 's1').find((e) => e.kind === 'message-sent');
    expect(sent).toMatchObject({ sessionId: 'session-0001' });
  });

  test('meta and sessionId are validated fail-closed', () => {
    const err = (command: unknown) => {
      const d = decide(undefined, env(command, 'claude', 'iv'));
      expect(d.ok).toBeFalse();
      return d.ok ? '' : (d.error as { code?: string }).code;
    };
    const base = { kind: 'init-session', task: 't', agents: ['claude', 'codex'], driver: 'claude' };
    expect(err({ ...base, sessionId: 'a b c' })).toBe('invalid-session-id');
    expect(err({ ...base, meta: { codex: { display: 'evil\u0000name' } } })).toBe('invalid-agents');
    expect(err({ ...base, meta: { codex: { cliType: 'Not Valid!' } } })).toBe('invalid-agents');
    expect(err({ ...base, meta: { stranger: { display: 'x' } } })).toBe('invalid-agents');
  });

  test('the M1 bound is enforced at init, fail-closed', () => {
    const nine = Array.from({ length: MAX_AGENTS + 1 }, (_, i) => `agent${i}`);
    const d = decide(undefined, env({ kind: 'init-session', task: 't', agents: nine, driver: 'agent0' }, 'agent0', 'i2'));
    expect(d.ok).toBeFalse();
    if (!d.ok) expect((d.error as { code?: string }).code).toBe('invalid-agents');
  });
});

describe('M1: membership changes version the registry', () => {
  test('join/leave/rejoin/kick: monotonic versions, lifecycle transitions', () => {
    let s = replay(initEvents())!;

    const joined = run(s, { kind: 'join-session', agent: 'agy' }, 'claude', 'j1');
    expect(registryUpdates(joined)).toEqual([{ kind: 'registry-updated', version: 2, change: 'joined', agent: 'agy', at: AT }]);
    s = applyAll(s, joined);
    expect(s.registry.version).toBe(2);
    expect(s.agents).toContain('agy');
    expect(s.registry.agents['agy']).toMatchObject({ status: 'active', joinedAt: AT });

    const left = run(s, { kind: 'leave-session' }, 'agy', 'l1');
    expect(registryUpdates(left)).toEqual([{ kind: 'registry-updated', version: 3, change: 'left', agent: 'agy', at: AT }]);
    s = applyAll(s, left);
    expect(s.agents).not.toContain('agy');
    expect(s.registry.agents['agy']).toMatchObject({ status: 'left', leftAt: AT });

    // Rejoin: a NEW admission — active again, leftAt cleared.
    s = applyAll(s, run(s, { kind: 'join-session', agent: 'agy' }, 'claude', 'j2'));
    expect(s.registry.version).toBe(4);
    expect(s.registry.agents['agy']!.status).toBe('active');
    expect('leftAt' in s.registry.agents['agy']!).toBeFalse();

    const kicked = run(s, { kind: 'kick-agent', agent: 'agy', reason: 'test' }, 'claude', 'k1');
    expect(registryUpdates(kicked)).toEqual([{ kind: 'registry-updated', version: 5, change: 'kicked', agent: 'agy', at: AT }]);
    s = applyAll(s, kicked);
    expect(s.registry.agents['agy']!.status).toBe('left');
    expect(s.registry.version).toBe(5);
  });

  test('changed-time rejoin: NEW admission gets the new joinedAt, clears leftAt, keeps config', () => {
    const LATER = '2026-07-20 15:30:00';
    let s = replay(initEvents(['claude', 'codex'], { codex: { display: 'Codex CLI', cliType: 'codex' } }))!;
    s = applyAll(s, run(s, { kind: 'leave-session' }, 'codex', 'l2'));
    expect(s.registry.agents['codex']).toMatchObject({ status: 'left', leftAt: AT, joinedAt: AT });
    s = applyAll(s, run(s, { kind: 'join-session', agent: 'codex' }, 'claude', 'j3', LATER));
    expect(s.registry.agents['codex']).toMatchObject({ display: 'Codex CLI', cliType: 'codex', status: 'active', joinedAt: LATER });
    expect('leftAt' in s.registry.agents['codex']!).toBeFalse();
  });

  test('join-time meta overrides the prior record (validated)', () => {
    let s = replay(initEvents())!;
    s = applyAll(s, run(s, { kind: 'leave-session' }, 'codex', 'l4'));
    s = applyAll(s, run(s, { kind: 'join-session', agent: 'codex', meta: { role: 'tester' } }, 'claude', 'j6'));
    expect(s.registry.agents['codex']).toMatchObject({ role: 'tester', status: 'active' });
    const d = decide(s, env({ kind: 'join-session', agent: 'agy', meta: { role: 'BAD ROLE' } }, 'claude', 'j7'));
    expect(d.ok).toBeFalse();
  });

  test('the registry-updated event is CANONICAL: its version becomes the state version verbatim', () => {
    const s = replay(initEvents())!;
    const forced = evolve(s, { kind: 'registry-updated', version: 7, change: 'joined', agent: 'ghost', at: AT })!;
    expect(forced.registry.version).toBe(7);
    expect(forced.registry.agents['ghost']).toMatchObject({ status: 'active' });
  });

  test('join at the live cap is rejected with registry-full', () => {
    const eight = Array.from({ length: MAX_AGENTS }, (_, i) => `agent${i}`);
    const s = replay(initEvents(eight))!;
    const d = decide(s, env({ kind: 'join-session', agent: 'ninth' }, 'agent0', 'j4'));
    expect(d.ok).toBeFalse();
    if (!d.ok) expect((d.error as { code?: string }).code).toBe('registry-full');
  });

  test('a departed member frees a cap slot (LIVE members bound, not lifetime records)', () => {
    const eight = Array.from({ length: MAX_AGENTS }, (_, i) => `agent${i}`);
    let s = replay(initEvents(eight))!;
    s = applyAll(s, run(s, { kind: 'leave-session' }, 'agent7', 'l3'));
    const d = decide(s, env({ kind: 'join-session', agent: 'ninth' }, 'agent0', 'j5'));
    expect(d.ok).toBeTrue();
  });

  test('a USER kick versions the registry exactly like a driver kick', () => {
    const withUser = [...initEvents(), { kind: 'user-channel-registered', tokenHash: 'h', at: AT } as Event];
    const s = replay(withUser)!;
    const kicked = run(s, { kind: 'user-kick-agent', agent: 'codex', reason: '', groupId: 'g1', noticeIdBase: 'n1' }, 'user', 'uk1');
    expect(registryUpdates(kicked)).toEqual([{ kind: 'registry-updated', version: 2, change: 'kicked', agent: 'codex', at: AT }]);
    expect(applyAll(s, kicked).registry.agents['codex']).toMatchObject({ status: 'left', leftAt: AT });
  });
});
