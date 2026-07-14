import { describe, expect, test } from 'bun:test';
import { decide, replay, type CommandEnvelope, type SessionState } from '../../src/core/index.ts';

/**
 * Event-shape assertions for W2c (8a/11) — the same-transaction guarantees
 * the transition table cannot express: F17 (leave returns the turn in the
 * same decided list), F21 (kick cancels grants in the same list), and 8a's
 * revoke emitting the navigator notice WITH the turn return (codex's
 * integration requirement: no broker-only side channel).
 */

const base: SessionState = {
  task: 'w2c',
  agents: ['claude', 'codex'],
  driver: 'claude',
  turn: 'codex',
  status: 'active',
  started: 't0',
  grants: {},
};

const env = (principal: string, command: unknown): CommandEnvelope =>
  ({ command, meta: { id: 'm1', at: 't1', principal } }) as CommandEnvelope;

describe('8a revoke-turn event shape', () => {
  test('notice to the revoked holder and turn return travel in ONE decided list', () => {
    const r = decide(base, env('claude', { kind: 'revoke-turn', reason: 'no reply' }));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    const kinds = r.value.map((e) => e.kind);
    expect(kinds).toEqual(['turn-revoked', 'message-sent', 'turn-passed']);
    const msg = r.value.find((e) => e.kind === 'message-sent');
    expect(msg && msg.kind === 'message-sent' ? { to: msg.to, type: msg.type, turn: msg.turn } : undefined)
      .toEqual({ to: 'codex', type: 'turn-revoked', turn: 'keep' });
    const post = replay([
      { kind: 'session-initialized', task: 'w2c', agents: ['claude', 'codex'], driver: 'claude', at: 't0' },
      { kind: 'turn-passed', to: 'codex' },
      ...r.value,
    ]);
    expect(post?.turn).toBe('claude');
  });
});

describe('F17 leave returns the turn in the same txn', () => {
  test('turn-holding navigator leaves → agent-left + notice + turn-passed(driver) in one list', () => {
    const r = decide(base, env('codex', { kind: 'leave-session' }));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    expect(r.value.map((e) => e.kind)).toEqual(['agent-left', 'message-sent', 'turn-passed']);
    const turn = r.value.find((e) => e.kind === 'turn-passed');
    expect(turn && turn.kind === 'turn-passed' ? turn.to : undefined).toBe('claude');
    const post = replay([
      { kind: 'session-initialized', task: 'w2c', agents: ['claude', 'codex'], driver: 'claude', at: 't0' },
      { kind: 'turn-passed', to: 'codex' },
      ...r.value,
    ]);
    expect(post?.agents).toEqual(['claude']);
    expect(post?.turn).toBe('claude');
  });

  test('non-turn-holding navigator leaves → no turn mutation', () => {
    const r = decide({ ...base, turn: 'claude' }, env('codex', { kind: 'leave-session' }));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    expect(r.value.some((e) => e.kind === 'turn-passed')).toBeFalse();
  });
});

describe('F21 kick cancels open grants in the same txn', () => {
  test('kick of a grant-holding, turn-holding navigator → cancellations + notice + turn return, one list', () => {
    const state: SessionState = {
      ...base,
      grants: {
        g1: { id: 'g1', issuer: 'claude', assignee: 'codex', task: 't', scope: { mode: 'worktree', worktree: 'wt' }, state: 'active', agreedIn: '', result: '', revision: 1, created: 't0', updated: 't0' },
        g2: { id: 'g2', issuer: 'claude', assignee: 'codex', task: 't2', scope: { mode: 'worktree', worktree: 'wt2' }, state: 'done', agreedIn: '', result: 'r', revision: 2, created: 't0', updated: 't0' },
      },
    };
    const r = decide(state, env('claude', { kind: 'kick-agent', agent: 'codex', reason: 'wedged' }));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    const kinds = r.value.map((e) => e.kind);
    expect(kinds).toEqual(['agent-kicked', 'grant-cancelled', 'message-sent', 'turn-passed']);
    // Only the OPEN grant is cancelled; the done one is untouched.
    const cancelled = r.value.filter((e) => e.kind === 'grant-cancelled');
    expect(cancelled.map((e) => (e.kind === 'grant-cancelled' ? e.grantId : ''))).toEqual(['g1']);
    const post = replay([
      { kind: 'session-initialized', task: 'w2c', agents: ['claude', 'codex'], driver: 'claude', at: 't0' },
      { kind: 'turn-passed', to: 'codex' },
      { kind: 'grant-issued', grantId: 'g1', issuer: 'claude', assignee: 'codex', task: 't', scope: { mode: 'worktree', worktree: 'wt' }, agreedIn: '', at: 't0' },
      { kind: 'grant-accepted', grantId: 'g1', at: 't0' },
      ...r.value,
    ]);
    expect(post?.agents).toEqual(['claude']);
    expect(post?.grants['g1']?.state).toBe('cancelled');
    expect(post?.turn).toBe('claude');
  });
});

describe('join is driver-admitted and produces a welcome delivery', () => {
  test('driver join → agent-joined + join notice addressed to the new agent', () => {
    const r = decide(base, env('claude', { kind: 'join-session', agent: 'agy' }));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    expect(r.value.map((e) => e.kind)).toEqual(['agent-joined', 'message-sent']);
    const msg = r.value.find((e) => e.kind === 'message-sent');
    expect(msg && msg.kind === 'message-sent' ? { to: msg.to, type: msg.type } : undefined).toEqual({ to: 'agy', type: 'join' });
    const post = replay([
      { kind: 'session-initialized', task: 'w2c', agents: ['claude', 'codex'], driver: 'claude', at: 't0' },
      ...r.value,
    ]);
    expect(post?.agents).toEqual(['claude', 'codex', 'agy']);
  });
});
