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
const env = (command: unknown, principal: string, id: string): CommandEnvelope =>
  ({ command, meta: { id, at: AT, principal } }) as CommandEnvelope;

function run(state: SessionState | undefined, command: unknown, principal: string, id: string): Event[] {
  const d = decide(state, env(command, principal, id));
  if (!d.ok) throw d.error;
  return d.value;
}

function applyAll(state: SessionState, events: readonly Event[]): SessionState {
  return events.reduce<SessionState | undefined>(evolve, state)!;
}

function initEvents(agents: string[] = ['claude', 'codex'], displays?: Record<string, string>): Event[] {
  return run(undefined, { kind: 'init-session', task: 't', agents, driver: agents[0]!, ...(displays ? { displays } : {}) }, agents[0]!, 'i1');
}

const registryUpdates = (events: readonly Event[]) => events.filter((e) => e.kind === 'registry-updated');

describe('M1: init builds the registry', () => {
  test('v1 with active records, display defaulting to id, explicit displays honored', () => {
    const events = initEvents(['claude', 'codex'], { codex: 'Codex CLI' });
    const s = replay(events)!;
    expect(s.registry.version).toBe(1);
    expect(s.registry.agents['claude']).toEqual({ id: 'claude', display: 'claude', status: 'active', joinedAt: AT });
    expect(s.registry.agents['codex']).toEqual({ id: 'codex', display: 'Codex CLI', status: 'active', joinedAt: AT });
    expect(registryUpdates(events)).toEqual([{ kind: 'registry-updated', version: 1, change: 'init', at: AT }]);
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

  test('a rejoining agent keeps its display name', () => {
    let s = replay(initEvents(['claude', 'codex'], { codex: 'Codex CLI' }))!;
    s = applyAll(s, run(s, { kind: 'leave-session' }, 'codex', 'l2'));
    s = applyAll(s, run(s, { kind: 'join-session', agent: 'codex' }, 'claude', 'j3'));
    expect(s.registry.agents['codex']!.display).toBe('Codex CLI');
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
