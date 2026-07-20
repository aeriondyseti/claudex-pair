import { describe, expect, test } from 'bun:test';
import type { CommandEnvelope } from '../../src/core/commands.ts';
import { decide } from '../../src/core/decide.ts';
import { replay } from '../../src/core/evolve.ts';
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
    expect(Object.keys(s.registry.agents).sort()).toEqual(['agy', 'claude', 'codex']); // authorized identities are registered
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
