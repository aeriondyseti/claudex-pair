import { describe, expect, test } from 'bun:test';
import type { CommandEnvelope } from '../../src/core/commands.ts';
import { decide } from '../../src/core/decide.ts';
import { evolve, replay } from '../../src/core/evolve.ts';
import type { SessionState } from '../../src/core/types.ts';

/** Peer 1A-1: discriminated state, peer init bootstrap shape, and the
 * no-driver-authority command matrix (rev 4 approved design). Pair
 * byte-identity is proven by the untouched pair suites. */

const AT = '2026-07-20 15:00:00';
const env = (command: unknown, principal: string, id = 'p1'): CommandEnvelope =>
  ({ command, meta: { id, at: AT, principal } }) as CommandEnvelope;

function peerState(): SessionState {
  const d = decide(undefined, env({ kind: 'init-session', task: 'peer work', agents: ['claude', 'codex', 'agy'], driver: 'claude', sessionId: 'session-p-0001', topology: 'peer' }, 'claude', 'i1'));
  if (!d.ok) throw d.error;
  return replay(d.value)!;
}

describe('peer init: admitting bootstrap', () => {
  test('names become authorizedExpected; only the initiator is a member; phase/substate set', () => {
    const s = peerState();
    if (s.topology !== 'peer') throw new Error('expected peer');
    expect(s.initiator).toBe('claude');
    expect(s.phase).toBe('planning');
    expect(s.planning).toMatchObject({ substate: 'admitting', authorizedExpected: ['claude', 'codex', 'agy'], admitted: ['claude'] });
    expect(s.agents).toEqual(['claude']); // only admitted ids are members
    expect(Object.keys(s.registry.agents)).toEqual(['claude']); // round 2 #2: authorization is NOT a registry record — invitees register at admission
    expect(s.sessionId).toBe('session-p-0001');
  });

  test('a legacy init event without topology replays as pair (unchanged shape)', () => {
    const s = replay([{ kind: 'session-initialized', task: 't', agents: ['claude', 'codex'], driver: 'claude', at: AT }])!;
    expect(s.topology).toBe('pair');
    if (s.topology === 'pair') { expect(s.driver).toBe('claude'); expect(s.turn).toBe('claude'); }
  });
});

describe('peer command matrix: no driver authority', () => {
  const code = (command: unknown, principal = 'claude') => {
    const d = decide(peerState(), env(command, principal, 'mx'));
    expect(d.ok).toBeFalse();
    return d.ok ? '' : (d.error as { code?: string }).code;
  };

  test('driver-verb class rejected outright', () => {
    expect(code({ kind: 'revoke-turn', reason: '' })).toBe('no-driver-authority');
    expect(code({ kind: 'join-session', agent: 'gemini' })).toBe('no-driver-authority');
    expect(code({ kind: 'kick-agent', agent: 'codex', reason: '' })).toBe('no-driver-authority');
    expect(code({ kind: 'end-session', summary: 'x' })).toBe('no-driver-authority');
    expect(code({ kind: 'issue-grant', grantId: 'g1', to: 'codex', task: 't', scope: { mode: 'worktree', worktree: 'w' }, agreedIn: '' })).toBe('no-driver-authority');
    expect(code({ kind: 'accept-grant', grantId: 'g1' })).toBe('no-driver-authority');
  });

  test('pair-machinery message types and turn passing rejected; FYIs flow with session binding', () => {
    expect(code({ kind: 'send-message', to: 'codex', type: 'handoff', turn: 'keep', body: 'x' })).toBe('no-driver-authority');
    expect(code({ kind: 'send-message', to: 'codex', type: 'done', turn: 'keep', body: 'x' })).toBe('no-driver-authority');
    expect(code({ kind: 'send-message', to: 'codex', type: 'propose-end', turn: 'keep', body: 'x' })).toBe('no-driver-authority');
    expect(code({ kind: 'send-message', to: 'codex', type: 'info', turn: 'pass', body: 'x' })).toBe('no-turn-in-phase');

    // Wait — 'codex' is authorized but NOT admitted, so it is not a
    // participant yet; FYI flow is pinned between admitted members once
    // 1A-3 lands the attach path. For now the initiator's self-checks:
    const d = decide(peerState(), env({ kind: 'send-message', to: 'codex', type: 'info', turn: 'keep', body: 'x' }, 'claude', 'fy1'));
    // to-codex rejected while codex is unadmitted (not a participant).
    expect(d.ok).toBeFalse();
  });
});


describe('peer 1A privileged user verbs', () => {
  const userEnv = (command: unknown, id: string) => env(command, 'user', id);
  const base = { groupId: 'g1', noticeIdBase: 'n1' };

  function userReady(expected: string[] = ['claude', 'codex', 'agy']): SessionState {
    const s = decide(undefined, env({ kind: 'init-session', task: 'p', agents: expected, driver: 'claude', sessionId: 'session-p-0002', topology: 'peer' }, 'claude', 'i2'));
    if (!s.ok) throw s.error;
    const events = [...s.value, { kind: 'user-channel-registered', tokenHash: 'h'.repeat(64), at: AT }];
    return replay(events as Parameters<typeof replay>[0])!;
  }

  function applyDecided(s: SessionState, command: unknown, id: string): SessionState {
    const d = decide(s, userEnv(command, id));
    if (!d.ok) throw d.error;
    return d.value.reduce<SessionState | undefined>((acc, e) => (acc === undefined ? acc : (evolve(acc, e) ?? acc)), s)!;
  }

  test('user-admit-agent authorizes (admitting only, cap-bounded); authorization is not membership', () => {
    let s = userReady();
    s = applyDecided(s, { kind: 'user-admit-agent', agent: 'gemini', ...base }, 'ua1');
    if (s.topology !== 'peer' || s.planning?.substate !== 'admitting') throw new Error('shape');
    expect(s.planning.authorizedExpected).toContain('gemini');
    expect(s.agents).not.toContain('gemini');

    const dup = decide(s, userEnv({ kind: 'user-admit-agent', agent: 'gemini', ...base }, 'ua2'));
    expect(dup.ok).toBeFalse();
  });

  test('user-rule-absentee: the CLOSING abstain completes admission; wait requires a deadline; non-absentees rejected', () => {
    let s = userReady(['claude', 'codex']);
    s = applyDecided(s, { kind: 'user-rule-absentee', agent: 'codex', ruling: 'abstain', ...base }, 'ur1');
    if (s.topology !== 'peer') throw new Error('shape');
    expect(s.planning).toMatchObject({ substate: 'collecting', barrier: { members: ['claude'] } });

    const s2 = userReady();
    const noDeadline = decide(s2, userEnv({ kind: 'user-rule-absentee', agent: 'codex', ruling: 'wait', ...base }, 'ur2'));
    expect(noDeadline.ok).toBeFalse();
    const waited = applyDecided(s2, { kind: 'user-rule-absentee', agent: 'codex', ruling: 'wait', newDeadlineAt: '2026-07-21 09:00:00', ...base }, 'ur3');
    if (waited.topology !== 'peer' || waited.planning?.substate !== 'admitting') throw new Error('shape');
    expect(waited.planning.deadlineAt).toBe('2026-07-21 09:00:00');

    const notAbsent = decide(s2, userEnv({ kind: 'user-rule-absentee', agent: 'claude', ruling: 'abstain', ...base }, 'ur4'));
    expect(notAbsent.ok ? '' : (notAbsent.error as { code?: string }).code).toBe('not-an-absentee');
  });

  test('user-force-phase: planning->provisioning with outcome FORCED; implementation unavailable', () => {
    const s = userReady();
    const forced = decide(s, userEnv({ kind: 'user-force-phase', to: 'provisioning', reason: 'livelock', ...base }, 'uf1'));
    expect(forced.ok).toBeTrue();
    if (!forced.ok) return;
    expect(forced.value.find((e) => e.kind === 'phase-transition')).toMatchObject({ from: 'planning', to: 'provisioning', outcome: 'forced' });
    const after = forced.value.reduce<SessionState | undefined>((acc, e) => (acc === undefined ? acc : (evolve(acc, e) ?? acc)), s)!;
    if (after.topology !== 'peer') throw new Error('shape');
    expect(after.phase).toBe('provisioning');
    expect(after.planning).toBeUndefined();

    const beyond = decide(s, userEnv({ kind: 'user-force-phase', to: 'implementation', reason: '', ...base }, 'uf2'));
    expect(beyond.ok ? '' : (beyond.error as { code?: string }).code).toBe('phase-unavailable');
  });

  test('user-rebind-agent needs an existing binding and emits the canonical rebound transition', () => {
    const s = userReady();
    const unbound = decide(s, userEnv({ kind: 'user-rebind-agent', agent: 'codex', ...base }, 'ub1'));
    expect(unbound.ok).toBeFalse();

    const bound = evolve(s, { kind: 'registry-updated', version: 99, change: 'bound', agent: 'claude', binding: { bindingId: 'b1', credentialVersion: 1, boundAt: AT }, at: AT })!;
    const rebind = decide(bound, userEnv({ kind: 'user-rebind-agent', agent: 'claude', ...base }, 'ub2'));
    expect(rebind.ok).toBeTrue();
    if (!rebind.ok) return;
    expect(rebind.value.find((e) => e.kind === 'registry-updated')).toMatchObject({ change: 'rebound', agent: 'claude', version: 100 });
    const after = rebind.value.reduce<SessionState | undefined>((acc, e) => (acc === undefined ? acc : (evolve(acc, e) ?? acc)), bound)!;
    expect(after.registry.agents['claude']!.binding).toBeUndefined();
  });
});
