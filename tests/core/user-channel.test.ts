import { describe, expect, test } from 'bun:test';
import { decide, replay, type CommandEnvelope, type SessionState } from '../../src/core/index.ts';
import { evolve } from '../../src/core/evolve.ts';

const replayOne = (s: SessionState | undefined, e: Parameters<typeof evolve>[1]): SessionState | undefined => evolve(s, e);

/**
 * U1 slice 3 core guards (U1-SLICE3-DESIGN.md, approved): reserved user
 * identity, advisory user-message semantics (never a turn mutation),
 * journal-authoritative registration with loud fan-out, and the principal
 * gate that backs the broker's transport gate.
 */

const env = (command: unknown, principal: string, id = 'm1'): CommandEnvelope =>
  ({ command, meta: { id, at: '2026-07-14 20:30:00', principal } }) as CommandEnvelope;

function activeSession(): SessionState {
  const init = decide(undefined, env({ kind: 'init-session', task: 't', agents: ['claude', 'codex'], driver: 'claude' }, 'claude'));
  if (!init.ok) throw init.error;
  return replay(init.value)!;
}

describe('reserved user identity', () => {
  test('init with user in the roster is rejected', () => {
    const r = decide(undefined, env({ kind: 'init-session', task: 't', agents: ['claude', 'user'], driver: 'claude' }, 'claude'));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error.code).toBe('reserved-identity');
  });

  test('join of user is rejected', () => {
    const r = decide(activeSession(), env({ kind: 'join-session', agent: 'user' }, 'claude'));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error.code).toBe('reserved-identity');
  });

  test('kick of user is rejected reserved-identity (not not-a-participant)', () => {
    const r = decide(activeSession(), env({ kind: 'kick-agent', agent: 'user', reason: '' }, 'claude'));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error.code).toBe('reserved-identity');
  });

  test('sending TO user is rejected user-not-addressable (v1)', () => {
    const r = decide(activeSession(), env({ kind: 'send-message', to: 'user', type: 'info', turn: 'keep', body: 'hi' }, 'claude'));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error.code).toBe('user-not-addressable');
  });
});

describe('user-message (advisory, internal shape)', () => {
  const message = { kind: 'user-message', groupId: 'req-1', recipients: [{ to: 'claude', messageId: 'u1-claude' }, { to: 'codex', messageId: 'u1-codex' }], body: 'focus on tests' };

  test('non-user principal is rejected even if forged as user-message (defense in depth)', () => {
    const r = decide(activeSession(), env(message, 'claude'));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error.code).toBe('user-channel-required');
  });

  test('broadcast emits one turn:keep message per recipient with groupId + provenance and NEVER moves the turn', () => {
    const state = activeSession(); // turn: claude
    const r = decide(state, env(message, 'user'));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    const sent = r.value.filter((e) => e.kind === 'message-sent');
    expect(sent.length).toBe(2);
    for (const m of sent) {
      if (m.kind !== 'message-sent') continue;
      expect(m.from).toBe('user');
      expect(m.turn).toBe('keep');
      expect(m.groupId).toBe('req-1');
      expect(m.provenance).toBe('trusted_user_client');
    }
    expect(new Set(sent.map((m) => (m.kind === 'message-sent' ? m.id : ''))).size).toBe(2); // unique ids
    expect(r.value.some((e) => e.kind === 'turn-passed')).toBeFalse();
    const after = r.value.reduce<SessionState | undefined>(replayOne, state);
    expect(after?.turn).toBe('claude'); // advisory: turn untouched
  });

  test('duplicate per-recipient ids and unknown recipients are rejected', () => {
    const dup = { ...message, recipients: [{ to: 'claude', messageId: 'x' }, { to: 'codex', messageId: 'x' }] };
    const rd = decide(activeSession(), env(dup, 'user'));
    expect(rd.ok).toBeFalse();
    if (!rd.ok) expect(rd.error.code).toBe('invalid-recipient');
    const unknown = { ...message, recipients: [{ to: 'agy', messageId: 'y' }] };
    const ru = decide(activeSession(), env(unknown, 'user'));
    expect(ru.ok).toBeFalse();
    if (!ru.ok) expect(ru.error.code).toBe('not-a-participant');
    // Duplicate recipients: one delivery per agent per logical send.
    const dupTo = { ...message, recipients: [{ to: 'codex', messageId: 'a' }, { to: 'codex', messageId: 'b' }] };
    const rt = decide(activeSession(), env(dupTo, 'user'));
    expect(rt.ok).toBeFalse();
    if (!rt.ok) expect(rt.error.code).toBe('invalid-recipient');
  });
});

describe('register-user-channel (journal-authoritative TOFU)', () => {
  test('first registration binds and fans out loud notices with distinct ids; replay restores the binding', () => {
    const state = activeSession();
    const r = decide(state, env({ kind: 'register-user-channel', tokenHash: 'abc123' }, 'user'));
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    expect(r.value[0]).toMatchObject({ kind: 'user-channel-registered', tokenHash: 'abc123' });
    const notices = r.value.filter((e) => e.kind === 'message-sent');
    expect(notices.length).toBe(2); // one per agent, inbox deliveries
    expect(new Set(notices.map((n) => (n.kind === 'message-sent' ? n.id : ''))).size).toBe(2);
    const after = r.value.reduce<SessionState | undefined>(replayOne, state);
    expect(after?.userChannelTokenHash).toBe('abc123');

    // Second registration rejected — no reset path in slice 3, regardless
    // of any mirror-file manipulation.
    const again = decide(after, env({ kind: 'register-user-channel', tokenHash: 'other' }, 'user'));
    expect(again.ok).toBeFalse();
    if (!again.ok) expect(again.error.code).toBe('user-channel-already-registered');
  });

  test('non-user principal cannot register', () => {
    const r = decide(activeSession(), env({ kind: 'register-user-channel', tokenHash: 'abc' }, 'codex'));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error.code).toBe('user-channel-required');
  });
});
