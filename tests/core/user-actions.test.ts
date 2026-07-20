import { describe, expect, test } from 'bun:test';
import { decide, replay, type CommandEnvelope, type SessionState } from '../../src/core/index.ts';
import type { Event } from '../../src/core/events.ts';

/**
 * U1 slice 4 core (U1-SLICE4-DESIGN.md REV 6, approved): privileged user
 * actions. Human authority bypasses ROLE authorization, never STRUCTURAL
 * validity; every action txn carries durable actionKind-tagged notices
 * (groupId === reqId, trusted_user_client) — the pending-clear correlation
 * and ⚡ marker source.
 */

const env = (command: unknown, principal: string, id = 'm1'): CommandEnvelope =>
  ({ command, meta: { id, at: '2026-07-20 12:00:00', principal } }) as CommandEnvelope;

const base = { groupId: 'req-1', noticeIdBase: 'm1-s9' };

function session(agents: string[] = ['claude', 'codex'], driver = 'claude'): SessionState {
  const init = decide(undefined, env({ kind: 'init-session', task: 't', agents, driver }, driver));
  if (!init.ok) throw init.error;
  return replay(init.value)!;
}

function withGrant(s: SessionState, issuer = 'claude', assignee = 'codex', state: 'offered' | 'active' = 'active'): SessionState {
  const issued = decide(s, env({ kind: 'issue-grant', grantId: 'g1', to: assignee, task: 'work', scope: { mode: 'worktree', worktree: 'wt' }, agreedIn: '' }, issuer, 'gi'));
  if (!issued.ok) throw issued.error;
  let next = issued.value.reduce<SessionState | undefined>((acc, e) => replayOne(acc, e), s)!;
  if (state === 'active') {
    const accepted = decide(next, env({ kind: 'accept-grant', grantId: 'g1' }, assignee, 'ga'));
    if (!accepted.ok) throw accepted.error;
    next = accepted.value.reduce<SessionState | undefined>((acc, e) => replayOne(acc, e), next)!;
  }
  return next;
}

import { evolve } from '../../src/core/evolve.ts';
const replayOne = (s: SessionState | undefined, e: Event): SessionState | undefined => evolve(s, e);

const notices = (events: readonly Event[]) =>
  events.filter((e): e is Extract<Event, { kind: 'message-sent' }> => e.kind === 'message-sent');

describe('user-* principal gate (defense in depth behind the transport gate)', () => {
  test('every slice-4 verb rejects a non-user principal, even the driver', () => {
    const s = withGrant(session());
    for (const command of [
      { kind: 'user-end-session', summary: '', ...base },
      { kind: 'user-cancel-grant', grantId: 'g1', reason: '', ...base },
      { kind: 'user-kick-agent', agent: 'codex', reason: '', ...base },
    ]) {
      const r = decide(s, env(command, 'claude'));
      expect(r.ok).toBeFalse();
      if (!r.ok) expect(r.error.code).toBe('user-channel-required');
    }
  });
});

describe('user-end-session', () => {
  test('non-vetoable end from user; done notices to EVERY agent with actionKind + groupId + provenance; empty summary defaults', () => {
    const r = decide(session(), env({ kind: 'user-end-session', summary: '', ...base }, 'user'));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    const ended = r.value.find((e) => e.kind === 'session-ended');
    expect(ended).toMatchObject({ by: 'user', summary: 'Session ended by user.' }); // ruling Q2
    const ns = notices(r.value);
    expect(ns.map((n) => n.to).sort()).toEqual(['claude', 'codex']); // EVERY agent, driver included
    for (const n of ns) {
      expect(n).toMatchObject({ from: 'user', type: 'done', turn: 'keep', groupId: 'req-1', provenance: 'trusted_user_client', actionKind: 'end' });
    }
    expect(new Set(ns.map((n) => n.id)).size).toBe(ns.length); // distinct collision-proof ids
    expect(ns.every((n) => n.id.startsWith('m1-s9-r'))).toBeTrue();
    const final = r.value.reduce<SessionState | undefined>((acc, e) => replayOne(acc, e), session());
    expect(final?.status).toBe('completed');
  });
});

describe('user-cancel-grant', () => {
  test('cancels any open grant regardless of issuer role; notices to issuer+assignee deduplicated-ready', () => {
    const s = withGrant(session());
    const r = decide(s, env({ kind: 'user-cancel-grant', grantId: 'g1', reason: 'stuck', ...base }, 'user'));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    expect(r.value.find((e) => e.kind === 'grant-cancelled')).toMatchObject({ grantId: 'g1', reason: 'stuck' });
    const ns = notices(r.value);
    expect(ns.map((n) => n.to).sort()).toEqual(['claude', 'codex']); // issuer + assignee
    for (const n of ns) expect(n).toMatchObject({ actionKind: 'cancel-grant', groupId: 'req-1', provenance: 'trusted_user_client' });
  });

  test('completed grant is a stale transition; unknown grant is not-found', () => {
    const s = session();
    const missing = decide(s, env({ kind: 'user-cancel-grant', grantId: 'nope', reason: '', ...base }, 'user'));
    expect(missing.ok).toBeFalse();
    if (!missing.ok) expect(missing.error.code).toBe('grant-not-found');
  });
});

describe('user-kick-agent', () => {
  test('kicks a navigator: grants cancel in-txn, stop-notice to kicked, actionKind notices to survivors, held turn returns to DRIVER', () => {
    let s = session(['claude', 'codex', 'agy'], 'claude');
    s = withGrant(s, 'claude', 'codex');
    // Pass the turn to codex so the kick must return it to the driver.
    const pass = decide(s, env({ kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' }, 'claude', 'mp'));
    if (!pass.ok) throw pass.error;
    s = pass.value.reduce<SessionState | undefined>((acc, e) => replayOne(acc, e), s)!;
    expect(s.turn).toBe('codex');

    const r = decide(s, env({ kind: 'user-kick-agent', agent: 'codex', reason: 'wedged', ...base }, 'user'));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    expect(r.value.find((e) => e.kind === 'agent-kicked')).toMatchObject({ agent: 'codex' });
    expect(r.value.find((e) => e.kind === 'grant-cancelled')).toMatchObject({ grantId: 'g1' });
    const ns = notices(r.value);
    const stop = ns.find((n) => n.to === 'codex')!;
    expect(stop).toMatchObject({ type: 'kick', actionKind: 'kick' });
    const survivors = ns.filter((n) => n.to !== 'codex');
    expect(survivors.map((n) => n.to).sort()).toEqual(['agy', 'claude']);
    for (const n of survivors) expect(n).toMatchObject({ type: 'info', actionKind: 'kick', groupId: 'req-1' });
    expect(new Set(ns.map((n) => n.id)).size).toBe(ns.length);
    const turnReturn = r.value.find((e) => e.kind === 'turn-passed');
    expect(turnReturn).toMatchObject({ to: 'claude' }); // to the DRIVER, same txn
    const final = r.value.reduce<SessionState | undefined>((acc, e) => replayOne(acc, e), s);
    expect(final?.agents).toEqual(['claude', 'agy']);
    expect(final?.turn).toBe('claude');
  });

  test('the driver CANNOT be kicked — structural validity outranks human authority; error directs to /end', () => {
    const r = decide(session(), env({ kind: 'user-kick-agent', agent: 'claude', reason: '', ...base }, 'user'));
    expect(r.ok).toBeFalse();
    if (!r.ok) {
      expect(r.error.code).toBe('kick-driver');
      expect(r.error.message).toContain('/end');
    }
  });

  test('reserved identity and non-members are rejected', () => {
    const forUser = decide(session(), env({ kind: 'user-kick-agent', agent: 'user', reason: '', ...base }, 'user'));
    expect(forUser.ok).toBeFalse();
    if (!forUser.ok) expect(forUser.error.code).toBe('reserved-identity');
    const stranger = decide(session(), env({ kind: 'user-kick-agent', agent: 'ghost', reason: '', ...base }, 'user'));
    expect(stranger.ok).toBeFalse();
    if (!stranger.ok) expect(stranger.error.code).toBe('not-a-participant');
  });
});

describe('slice 4b: the paused-status matrix (F-A5/A6/A9)', () => {
  const paused = (): SessionState => {
    const s = withGrant(session(['claude', 'codex'], 'claude'));
    const r = decide(s, env({ kind: 'user-pause-session', reason: 'lunch', ...base }, 'user', 'mp'));
    if (!r.ok) throw r.error;
    return r.value.reduce<SessionState | undefined>((acc, e) => replayOne(acc, e), s)!;
  };

  test('pause: status flips, actionKind pause notices to every agent; agent mutations reject stable session-paused', () => {
    const s = paused();
    expect(s.status).toBe('paused');
    for (const command of [
      { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' },
      { kind: 'issue-grant', grantId: 'g2', to: 'codex', task: 'w', scope: { mode: 'worktree', worktree: 'wt' }, agreedIn: '' },
      { kind: 'accept-grant', grantId: 'g1' },
      { kind: 'end-session', summary: 'x' },
      { kind: 'kick-agent', agent: 'codex', reason: '' },
      { kind: 'cancel-grant', grantId: 'g1', reason: '' },
      { kind: 'revoke-turn', reason: '' },
      { kind: 'join-session', agent: 'agy' },
    ]) {
      const r = decide(s, env(command, 'claude', `c-${command.kind}`));
      expect(r.ok).toBeFalse();
      if (!r.ok) expect(r.error.code).toBe('session-paused');
    }
  });

  test('leave-with-grant rejects for the GRANT reason while paused (never session-paused); grant completion commits; then leave commits', () => {
    let s = paused();
    const blocked = decide(s, env({ kind: 'leave-session' }, 'codex', 'lv1'));
    expect(blocked.ok).toBeFalse();
    if (!blocked.ok) expect(blocked.error.code).toBe('leave-with-grant');
    const done = decide(s, env({ kind: 'complete-grant', grantId: 'g1', result: 'landed' }, 'codex', 'gd'));
    expect(done.ok).toBeTrue();
    if (!done.ok) return;
    s = done.value.reduce<SessionState | undefined>((acc, e) => replayOne(acc, e), s)!;
    expect(s.status).toBe('paused'); // completion never resumes
    const leave = decide(s, env({ kind: 'leave-session' }, 'codex', 'lv2'));
    expect(leave.ok).toBeTrue();
  });

  test('EVERY user verb stays valid while paused: message, cancel-grant, kick, and END (F-A6)', () => {
    const s = paused();
    const msg = decide(s, env({ kind: 'user-message', groupId: 'g', recipients: [{ to: 'claude', messageId: 'um1' }], body: 'still here' }, 'user', 'um'));
    expect(msg.ok).toBeTrue();
    const cancel = decide(s, env({ kind: 'user-cancel-grant', grantId: 'g1', reason: 'braked', ...base }, 'user', 'uc'));
    expect(cancel.ok).toBeTrue(); // user cancel unaffected by the brake
    const kick = decide(s, env({ kind: 'user-kick-agent', agent: 'codex', reason: 'stuck', ...base }, 'user', 'uk'));
    expect(kick.ok).toBeTrue(); // user kick unaffected by the brake
    const end = decide(s, env({ kind: 'user-end-session', summary: '', ...base }, 'user', 'ue'));
    expect(end.ok).toBeTrue(); // the user outranks the brake
  });

  test('turn-holding leave WHILE PAUSED returns the turn to the driver; resume preserves that turn change (resume-only-status proper)', () => {
    // No grant: leave must be free to commit. Pass the turn to codex first.
    let s = session(['claude', 'codex'], 'claude');
    const pass = decide(s, env({ kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' }, 'claude', 'tp'));
    if (!pass.ok) throw pass.error;
    s = pass.value.reduce<SessionState | undefined>((acc, e) => replayOne(acc, e), s)!;
    const pausedR = decide(s, env({ kind: 'user-pause-session', reason: '', ...base }, 'user', 'up'));
    if (!pausedR.ok) throw pausedR.error;
    s = pausedR.value.reduce<SessionState | undefined>((acc, e) => replayOne(acc, e), s)!;
    expect([s.status, s.turn]).toEqual(['paused', 'codex']);

    const leave = decide(s, env({ kind: 'leave-session' }, 'codex', 'lv'));
    expect(leave.ok).toBeTrue();
    if (!leave.ok) return;
    expect(leave.value.find((e) => e.kind === 'turn-passed')).toMatchObject({ to: 'claude' }); // same txn
    s = leave.value.reduce<SessionState | undefined>((acc, e) => replayOne(acc, e), s)!;
    expect([s.status, s.turn, [...s.agents]]).toEqual(['paused', 'claude', ['claude']]);

    const resume = decide(s, env({ kind: 'user-resume-session', ...base }, 'user', 'ur'));
    expect(resume.ok).toBeTrue();
    if (!resume.ok) return;
    s = resume.value.reduce<SessionState | undefined>((acc, e) => replayOne(acc, e), s)!;
    // Resume changed ONLY the status: the paused-time turn return SURVIVES.
    expect([s.status, s.turn, [...s.agents]]).toEqual(['active', 'claude', ['claude']]);
  });

  test('F-A9: pause-while-paused and resume-while-active are STABLE distinct errors; resume restores active', () => {
    const s = paused();
    const again = decide(s, env({ kind: 'user-pause-session', reason: '', ...base }, 'user', 'p2'));
    expect(again.ok).toBeFalse();
    if (!again.ok) expect(again.error.code).toBe('session-already-paused');
    const resume = decide(s, env({ kind: 'user-resume-session', ...base }, 'user', 'r1'));
    expect(resume.ok).toBeTrue();
    if (!resume.ok) return;
    const active = resume.value.reduce<SessionState | undefined>((acc, e) => replayOne(acc, e), s)!;
    expect(active.status).toBe('active');
    const notPaused = decide(active, env({ kind: 'user-resume-session', ...base }, 'user', 'r2'));
    expect(notPaused.ok).toBeFalse();
    if (!notPaused.ok) expect(notPaused.error.code).toBe('session-not-paused');
  });

  test('init rejects over a PAUSED session exactly as over active (paused is live)', () => {
    const r = decide(paused(), env({ kind: 'init-session', task: 't2', agents: ['claude', 'codex'], driver: 'claude' }, 'claude', 'i2'));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error.code).toBe('session-exists');
  });
});
