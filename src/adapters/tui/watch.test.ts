import { describe, expect, test } from 'bun:test';
import type { Grant, SessionState } from '@core/types.ts';
import type { StoredMessage } from '@app/ports/index.ts';
import { ageSeconds, derivePresence, formatAge } from './derive.ts';
import type { ComposerState } from './events.ts';
import { renderWatchFrame } from './watch.ts';
import type { WatchViewModel } from './viewmodel.ts';

const session: SessionState = {
  task: 'make watch truthful',
  agents: ['claude', 'codex'],
  driver: 'claude',
  turn: 'codex',
  status: 'active',
  started: '2026-07-14 18:00:00',
  grants: {},
};

const message = (overrides: Partial<StoredMessage['header']> = {}): StoredMessage => ({
  name: '0001-claude-ask.md',
  header: {
    id: '0001',
    from: 'claude',
    to: 'codex',
    type: 'ask',
    turn: 'pass',
    sent: '2026-07-14 18:09:00',
    ...overrides,
  },
  body: 'Please review the observer. This line is intentionally long.',
  raw: '',
});

const userMessage = (id: string, to: string, pending: boolean, groupId = 'request-1') => ({
  message: message({
    id,
    from: 'user',
    to,
    type: 'info',
    turn: 'keep',
    groupId,
    provenance: 'trusted_user_client',
  } as Partial<StoredMessage['header']>),
  pending,
});

const composer = (overrides: Partial<ComposerState> = {}): ComposerState => ({
  channel: 'registered', buffer: '', target: '*', scrollOffset: 0, filter: 'all', ...overrides,
});

const grant: Grant = {
  id: 'g1-codex',
  issuer: 'claude',
  assignee: 'codex',
  task: 'render the TUI',
  scope: { mode: 'files', files: ['src/adapters/tui/watch.ts'] },
  state: 'active',
  agreedIn: '0000',
  result: '',
  revision: 1,
  created: '2026-07-14 18:00:00',
  updated: '2026-07-14 18:01:00',
};

function model(overrides: Partial<WatchViewModel> = {}): WatchViewModel {
  return {
    source: {
      kind: 'broker',
      pid: 42,
      epoch: 3,
      endpoint: 'claudex-test',
      headSeq: 17,
      heartbeatAt: '2026-07-14 18:10:00',
      connected: true,
    },
    session,
    navigators: ['codex'],
    openGrants: [grant],
    transcript: [{ message: message(), pending: true }, { message: message({ id: '0002' }), pending: false, voided: true }],
    presence: [
      {
        agent: 'claude',
        listener: { state: 'live', connectedSince: '2026-07-14 18:05:00', lastActivity: '2026-07-14 18:09:30' },
        pendingCount: 0,
      },
      {
        agent: 'codex',
        listener: { state: 'none' },
        pendingCount: 1,
        oldestPendingSent: '2026-07-14 18:08:00',
      },
    ],
    now: '2026-07-14 18:10:00',
    notices: ['observer reconnected'],
    ...overrides,
  };
}

describe('watch derivation', () => {
  test('computes deterministic ages and rejects invalid wall-clock timestamps', () => {
    expect(ageSeconds('2026-07-14 18:10:00', '2026-07-14 18:08:30')).toBe(90);
    expect(ageSeconds('2026-07-14 18:10:00', '2026-07-14 18:11:00')).toBe(0);
    expect(ageSeconds('2026-02-30 18:10:00', '2026-02-28 18:10:00')).toBeUndefined();
    expect(formatAge(90)).toBe('1m 30s');
    expect(formatAge(7_440)).toBe('2h 4m');
  });

  test('stalled requires old pending mail and an explicitly absent listener', () => {
    const absent = derivePresence(model().presence[1]!, model().now, 90);
    expect(absent).toMatchObject({ pendingAgeSec: 120, stalled: true });
    const unknown = derivePresence({ ...model().presence[1]!, listener: { state: 'unknown' } }, model().now, 90);
    expect(unknown.stalled).toBeFalse();
    const recent = derivePresence({ ...model().presence[1]!, oldestPendingSent: '2026-07-14 18:09:00' }, model().now, 90);
    expect(recent.stalled).toBeFalse();
  });
});

describe('watch renderer', () => {
  test('renders authoritative broker identity, distinct presence signals, grants, and transcript state', () => {
    const frame = renderWatchFrame({ model: model(), width: 100, tail: 10, stalledAfterSec: 90 });
    expect(frame).toContain('broker authoritative');
    expect(frame).toContain('epoch 3 | head 17 | pid 42 | connected');
    expect(frame).toContain('listener: live for 5m 0s | last activity: 30s ago | pending: 0');
    expect(frame).toContain('listener: none | last activity: unknown (no listener) | pending: 1, oldest 2m 0s ago');
    expect(frame).toContain('[stalled: pending mail, no listener]');
    expect(frame).toContain('[active] g1-codex: render the TUI');
    expect(frame).toContain('[pending]');
    expect(frame).toContain('[voided]');
    expect(frame).toContain('observer reconnected');
  });

  test('labels fs projections as possibly stale and presence as honestly unknown', () => {
    const frame = renderWatchFrame({
      model: model({
        source: { kind: 'fs-diagnostic', reason: 'legacy-session' },
        presence: [{ agent: 'claude', listener: { state: 'unknown' }, pendingCount: 1, oldestPendingSent: '2026-07-14 18:00:00' }],
      }),
      width: 80,
      tail: 0,
    });
    expect(frame).toContain('fs diagnostic (may lag)');
    expect(frame).toContain('| legacy session');
    expect(frame).toContain('listener: unknown (fs diagnostic)');
    expect(frame).not.toContain('[stalled:');
    expect(frame).toContain('(no messages yet)');
  });

  test('wraps transcript bodies using the supplied terminal width', () => {
    const frame = renderWatchFrame({ model: model({ transcript: [{ message: message(), pending: false }] }), width: 24, tail: 1 });
    expect(frame).toContain('   Please review the obs');
    expect(frame).toContain('   erver. This line is i');
  });

  test('groups trusted user deliveries and renders per-recipient ack badges', () => {
    const frame = renderWatchFrame({
      model: model({ transcript: [userMessage('u1', 'claude', false), userMessage('u2', 'codex', true)] }),
      width: 100,
      tail: 10,
      composer: composer(),
    });
    expect(frame.match(/Please review the observer/g)?.length).toBe(1);
    expect(frame).toContain('claude ✓ codex ○');
    expect(frame).toContain('to:*');
    expect(frame).toContain('filter:all');
  });

  test('renders filtering, scrollback, pending state, and credential guidance', () => {
    const transcript = [
      { message: message({ id: 'ask', type: 'ask' }), pending: false },
      { message: message({ id: 'notice', type: 'info' }), pending: false },
      userMessage('user-1', 'claude', true, 'group-1'),
      userMessage('user-2', 'claude', false, 'group-2'),
    ];
    const filtered = renderWatchFrame({
      model: model({ transcript }), width: 100, tail: 1,
      composer: composer({
        filter: 'user', scrollOffset: 1,
        pending: { reqId: 'request-2', target: 'codex', body: 'retry me', state: 'error', error: 'connection lost' },
      }),
    });
    expect(filtered).toContain('[scrollback]');
    expect(filtered).toContain('filter:user');
    expect(filtered).toContain('send failed: connection lost');

    const credentialError = renderWatchFrame({
      model: model(), width: 100, tail: 10,
      composer: composer({ channel: 'credential-error', channelDetail: 'DPAPI decrypt failed' }),
    });
    expect(credentialError).toContain('USER CREDENTIAL ERROR: DPAPI decrypt failed');
    expect(credentialError).toContain('cannot silently regenerate');
    expect(credentialError).not.toContain('to:*');
  });

  test('renders both credential-error guidance variants: corrupt local store and foreign binding (close-out #2)', () => {
    // Corrupt/unreadable local store — the local bootstrap path.
    const corruptLocal = renderWatchFrame({
      model: model(), width: 100, tail: 10,
      composer: composer({
        channel: 'credential-error',
        channelDetail: 'user credential store unreadable (DPAPI decrypt failed) — repair or delete .pair credential state',
      }),
    });
    expect(corruptLocal).toContain('USER CREDENTIAL ERROR: user credential store unreadable');
    expect(corruptLocal).toContain('cannot silently regenerate');
    expect(corruptLocal).not.toContain('to:*'); // no input affordance in error state

    // Foreign binding — the broker-side user-auth-failed degrade path.
    const foreignBinding = renderWatchFrame({
      model: model(), width: 100, tail: 10,
      composer: composer({
        channel: 'credential-error',
        channelDetail: 'user channel is bound to another client. This pane is read-only.',
      }),
    });
    expect(foreignBinding).toContain('USER CREDENTIAL ERROR: user channel is bound to another client');
    expect(foreignBinding).toContain('This pane is read-only.');
    expect(foreignBinding).not.toContain('to:*');
  });
});

describe('slice-4 action rendering', () => {
  test('CONFIRM banner, action hint, executing pending, and the ⚡ actionKind marker (keyed on the durable field, never provenance)', () => {
    const confirm = renderWatchFrame({
      model: model(), width: 100, tail: 10,
      composer: composer({ confirming: { verb: 'kick', agent: 'codex', reason: 'wedged', display: '/kick codex' } }),
    });
    expect(confirm).toContain('CONFIRM /kick codex — Enter to execute, Esc to abort');

    const hint = renderWatchFrame({
      model: model(), width: 100, tail: 10,
      composer: composer({ actionHint: 'usage: /kick <agent> [reason]' }),
    });
    expect(hint).toContain('usage: /kick <agent> [reason]');

    const executing = renderWatchFrame({
      model: model(), width: 100, tail: 10,
      composer: composer({ pending: { reqId: 'r', target: '*', body: '/end ship it', state: 'sending', action: true } }),
    });
    expect(executing).toContain('⚡ executing…');
    expect(executing).toContain('/end ship it');

    // ⚡ marker: an ADVISORY user message (same provenance+groupId shape)
    // must NOT get the marker; an actionKind-tagged notice must.
    const advisory = userMessage('adv-1', 'claude', false, 'g-adv');
    const notice = {
      ...userMessage('act-1', 'claude', false, 'g-act'),
      message: {
        ...userMessage('act-1', 'claude', false, 'g-act').message,
        header: { ...userMessage('act-1', 'claude', false, 'g-act').message.header, actionKind: 'end' as const },
      },
    };
    const frame = renderWatchFrame({ model: model({ transcript: [advisory, notice] }), width: 100, tail: 10, composer: composer({}) });
    expect(frame).toContain('⚡ user action: end');
    expect(frame.match(/⚡ user action/g)?.length).toBe(1); // advisory carries NO marker
  });
});
