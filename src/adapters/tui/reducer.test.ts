import { describe, expect, test } from 'bun:test';
import type { LivenessDto, ObserverSnapshotDto } from '@app/ports/gateway.ts';
import type { StoredMessage } from '@app/ports/index.ts';
import type { SessionState } from '@core/types.ts';
import { initialWatchState, type WatchActivity } from './events.ts';
import { diffWatchFrame } from './frame.ts';
import { reduceWatch } from './reducer.ts';
import type { WatchViewModel } from './viewmodel.ts';

const active: SessionState = {
  task: 'event loop', agents: ['claude', 'codex'], driver: 'claude', turn: 'claude',
  status: 'active', started: '2026-07-14 19:00:00', grants: {},
};

const stored = (id: string, to = 'codex', sent = '2026-07-14 19:00:30'): StoredMessage => ({
  name: `${id}-claude-info.md`,
  header: { id, from: 'claude', to, type: 'info', turn: 'keep', sent },
  body: `body ${id}`,
  raw: '',
});

const userStored = (id: string, to: string, groupId: string): StoredMessage => ({
  ...stored(id, to),
  header: {
    ...stored(id, to).header,
    from: 'user',
    groupId,
    provenance: 'trusted_user_client',
  },
} as StoredMessage);

const liveness: LivenessDto = {
  broker: { pid: 10, epoch: 2, heartbeatAt: '2026-07-14 19:01:00' },
  agents: { codex: { connectedSince: '2026-07-14 19:00:00', lastActivity: '2026-07-14 19:00:45' } },
};

function snapshot(overrides: Partial<ObserverSnapshotDto> = {}): ObserverSnapshotDto {
  return {
    seq: 4,
    session: active,
    transcript: [{ message: stored('m1'), pending: true }],
    liveness,
    broker: { pid: 10, epoch: 2, endpoint: 'wire-endpoint', heartbeatAt: '2026-07-14 19:01:00' },
    ...overrides,
  };
}

function attached(value = snapshot()) {
  return reduceWatch(initialWatchState({ width: 100, tail: 10, now: '2026-07-14 19:01:00' }), {
    kind: 'attach', snapshot: value, endpoint: 'display-endpoint', now: '2026-07-14 19:01:00',
  }).state;
}

function activity(seq: number, session: SessionState = active): WatchActivity {
  return { seq, session, entries: [], ackedDeliveryIds: [], voidedDeliveryIds: [] };
}

describe('watch reducer attach and replacement', () => {
  test('attach rebuilds authoritative model and pending presence', () => {
    const step = reduceWatch(initialWatchState({ width: 80, tail: 5, now: 'old' }), {
      kind: 'attach', snapshot: snapshot(), endpoint: 'display-endpoint', now: '2026-07-14 19:01:00',
    });
    expect(step.effects).toEqual(['render']);
    expect(step.state.model?.source).toMatchObject({ kind: 'broker', endpoint: 'display-endpoint', headSeq: 4, connected: true });
    expect(step.state.model?.presence.find((p) => p.agent === 'codex')).toMatchObject({ listener: { state: 'live' }, pendingCount: 1 });
  });

  test('completed attach and fs replacement render before exit', () => {
    const completed = { ...active, status: 'completed' as const };
    const attach = reduceWatch(initialWatchState({ width: 80, tail: 5, now: 'now' }), {
      kind: 'attach', snapshot: snapshot({ session: completed }), endpoint: 'e', now: 'now',
    });
    expect(attach.effects).toEqual(['render', 'exit']);

    const fsModel: WatchViewModel = {
      source: { kind: 'fs-diagnostic', reason: 'legacy-session' }, session: completed,
      navigators: ['codex'], openGrants: [], transcript: [], presence: [], now: 'now', notices: [],
    };
    const replaced = reduceWatch(attach.state, { kind: 'replace-model', model: fsModel });
    expect(replaced.effects).toEqual(['render', 'exit']);
    expect(replaced.state.headSeq).toBe(0);
    expect(replaced.state.entries.size).toBe(0);
  });
});

describe('watch reducer stream continuity and projection', () => {
  test('drops duplicates and renders a gap notice before reattach', () => {
    const state = attached();
    expect(reduceWatch(state, { kind: 'activity', activity: activity(4) })).toEqual({ state, effects: [] });
    const gap = reduceWatch(state, { kind: 'activity', activity: activity(6) });
    expect(gap.effects).toEqual(['render', 'reattach']);
    expect(gap.state.connection).toBe('reattaching');
    expect(gap.state.model?.source).toMatchObject({ kind: 'broker', connected: false });
    expect(gap.state.model?.notices[0]).toContain('stream gap');
  });

  test('applies message, ack, and void transitions by delivery id', () => {
    let state = attached(snapshot({ transcript: [] }));
    const add: WatchActivity = {
      seq: 5, session: active,
      entries: [{ deliveryId: 'm2:codex', message: stored('m2') }, { deliveryId: 'm3:codex', message: stored('m3') }],
      ackedDeliveryIds: [], voidedDeliveryIds: [],
    };
    ({ state } = reduceWatch(state, { kind: 'activity', activity: add }));
    expect(state.model?.transcript.map((e) => [e.message.header.id, e.pending])).toEqual([['m2', true], ['m3', true]]);
    ({ state } = reduceWatch(state, {
      kind: 'activity', activity: { ...activity(6), ackedDeliveryIds: ['m2:codex'], voidedDeliveryIds: ['m3:codex'] },
    }));
    expect(state.model?.transcript[0]).toMatchObject({ pending: false });
    expect(state.model?.transcript[1]).toMatchObject({ pending: false, voided: true });
    expect(state.model?.presence.find((p) => p.agent === 'codex')?.pendingCount).toBe(0);
  });

  test('completed activity renders the final state before exit', () => {
    const completed = { ...active, status: 'completed' as const };
    const result = reduceWatch(attached(), { kind: 'activity', activity: activity(5, completed) });
    expect(result.effects).toEqual(['render', 'exit']);
    expect(result.state.model?.session.status).toBe('completed');
  });
});

describe('watch reducer terminal and time events', () => {
  test('presence refreshes real heartbeat and listener projection', () => {
    const nextLiveness: LivenessDto = {
      broker: { pid: 10, epoch: 2, heartbeatAt: '2026-07-14 19:02:00' }, agents: {},
    };
    const result = reduceWatch(attached(), { kind: 'presence', liveness: nextLiveness });
    expect(result.effects).toEqual(['render']);
    expect(result.state.model?.source).toMatchObject({ heartbeatAt: '2026-07-14 19:02:00' });
    expect(result.state.model?.presence.find((p) => p.agent === 'codex')?.listener).toEqual({ state: 'none' });
  });

  test('resize renders only on change; tick renders only when ages can change', () => {
    const state = attached();
    expect(reduceWatch(state, { kind: 'resize', width: 100 }).effects).toEqual([]);
    expect(reduceWatch(state, { kind: 'resize', width: 120 }).effects).toEqual(['render']);
    expect(reduceWatch(state, { kind: 'tick', now: '2026-07-14 19:01:01' }).effects).toEqual(['render']);

    const staticModel: WatchViewModel = {
      ...state.model!, transcript: [],
      presence: active.agents.map((agent) => ({ agent, listener: { state: 'none' as const }, pendingCount: 0 })),
    };
    const staticState = { ...state, model: staticModel };
    const tick = reduceWatch(staticState, { kind: 'tick', now: '2026-07-14 19:01:02' });
    expect(tick.effects).toEqual([]);
    expect(tick.state.model?.now).toBe('2026-07-14 19:01:02');
  });

  test('connection state renders explicit notice and ordered reattach effect', () => {
    const lost = reduceWatch(attached(), { kind: 'connection', state: 'lost' });
    expect(lost.effects).toEqual(['render', 'reattach']);
    expect(lost.state.model?.notices[0]).toContain('connection lost');
    const reattaching = reduceWatch(lost.state, { kind: 'connection', state: 'reattaching' });
    expect(reattaching.effects).toEqual(['render']);
    expect(reattaching.state.model?.notices[0]).toContain('broker unreachable');
    expect(reduceWatch(reattaching.state, { kind: 'key', key: 'quit' }).effects).toEqual(['exit']);
  });
});

describe('watch reducer composer', () => {
  function interactive() {
    return reduceWatch(attached(snapshot({ transcript: [] })), { kind: 'user-channel', state: 'registered' }).state;
  }

  test('always routes printable q/f as text and command chords separately', () => {
    let state = interactive();
    ({ state } = reduceWatch(state, { kind: 'text', text: 'qfé' }));
    expect(state.composer?.buffer).toBe('qfé');
    ({ state } = reduceWatch(state, { kind: 'key', key: 'backspace' }));
    expect(state.composer?.buffer).toBe('qf');
    ({ state } = reduceWatch(state, { kind: 'key', key: 'filter' }));
    expect(state.composer).toMatchObject({ buffer: 'qf', filter: 'dialogue' });
    expect(reduceWatch(state, { kind: 'key', key: 'quit' }).effects).toEqual(['exit']);
  });

  test('cycles broadcast and roster targets and normalizes a removed target', () => {
    let state = interactive();
    ({ state } = reduceWatch(state, { kind: 'key', key: 'tab' }));
    expect(state.composer?.target).toBe('claude');
    ({ state } = reduceWatch(state, { kind: 'key', key: 'tab' }));
    expect(state.composer?.target).toBe('codex');
    ({ state } = reduceWatch(state, { kind: 'key', key: 'tab' }));
    expect(state.composer?.target).toBe('*');

    state = { ...state, composer: { ...state.composer!, target: 'departed' } };
    ({ state } = reduceWatch(state, { kind: 'attach', snapshot: snapshot({ transcript: [] }), endpoint: 'e', now: state.now }));
    expect(state.composer?.target).toBe('*');
  });

  test('submits immutable snapshots, keeps success pending until commit, and reuses reqId on retry', () => {
    let state = interactive();
    ({ state } = reduceWatch(state, { kind: 'text', text: 'hello agents' }));
    const submit = reduceWatch(state, { kind: 'key', key: 'submit', reqId: 'request-1' });
    state = submit.state;
    expect(submit.effects).toEqual([
      'render',
      { kind: 'submit', reqId: 'request-1', target: '*', body: 'hello agents' },
    ]);
    expect(state.composer).toMatchObject({ buffer: '', pending: { reqId: 'request-1', state: 'sending' } });

    ({ state } = reduceWatch(state, { kind: 'submit-result', reqId: 'request-1', ok: true }));
    expect(state.composer?.pending?.reqId).toBe('request-1');
    ({ state } = reduceWatch(state, { kind: 'submit-result', reqId: 'request-1', ok: false, error: 'dropped' }));
    expect(state.composer?.pending).toMatchObject({ state: 'error', error: 'dropped' });

    const retry = reduceWatch(state, { kind: 'key', key: 'submit', reqId: 'fresh-id-must-be-ignored' });
    state = retry.state;
    expect(retry.effects[1]).toEqual({ kind: 'submit', reqId: 'request-1', target: '*', body: 'hello agents' });
    expect(state.composer?.pending).toMatchObject({ reqId: 'request-1', state: 'sending' });

    const committed: WatchActivity = {
      seq: 5,
      session: active,
      entries: [{ deliveryId: 'u1:claude', message: userStored('u1', 'claude', 'request-1') }],
      ackedDeliveryIds: [],
      voidedDeliveryIds: [],
    };
    ({ state } = reduceWatch(state, { kind: 'activity', activity: committed }));
    expect(state.composer?.pending).toBeUndefined();
  });

  test('escape discards a failed submit, while mismatched results are ignored', () => {
    let state = interactive();
    ({ state } = reduceWatch(state, { kind: 'text', text: 'body' }));
    ({ state } = reduceWatch(state, { kind: 'key', key: 'submit', reqId: 'r1' }));
    const unchanged = reduceWatch(state, { kind: 'submit-result', reqId: 'other', ok: false });
    expect(unchanged.state).toBe(state);
    ({ state } = reduceWatch(state, { kind: 'submit-result', reqId: 'r1', ok: false }));
    ({ state } = reduceWatch(state, { kind: 'key', key: 'escape' }));
    expect(state.composer?.pending).toBeUndefined();
  });

  test('scrolls by logical pages, preserves a scrolled viewport, and End follows', () => {
    const transcript = Array.from({ length: 5 }, (_, index) => ({ message: stored(`m${index}`), pending: false }));
    let state = reduceWatch(attached(snapshot({ transcript })), { kind: 'user-channel', state: 'registered' }).state;
    state = { ...state, tail: 2 };
    ({ state } = reduceWatch(state, { kind: 'key', key: 'page-up' }));
    expect(state.composer?.scrollOffset).toBe(2);
    ({ state } = reduceWatch(state, { kind: 'key', key: 'page-up' }));
    expect(state.composer?.scrollOffset).toBe(3);

    const add: WatchActivity = {
      seq: 5, session: active,
      entries: [{ deliveryId: 'new:codex', message: stored('new') }],
      ackedDeliveryIds: [], voidedDeliveryIds: [],
    };
    ({ state } = reduceWatch(state, { kind: 'activity', activity: add }));
    expect(state.composer?.scrollOffset).toBe(4);
    ({ state } = reduceWatch(state, { kind: 'key', key: 'end' }));
    expect(state.composer?.scrollOffset).toBe(0);
  });

  test('credential errors are local render state and fs projections cannot gain composer authority', () => {
    let state = attached(snapshot({ transcript: [] }));
    ({ state } = reduceWatch(state, { kind: 'user-channel', state: 'credential-error', detail: 'DPAPI failed' }));
    expect(state.composer).toMatchObject({ channel: 'credential-error', channelDetail: 'DPAPI failed' });

    const fsModel: WatchViewModel = {
      source: { kind: 'fs-diagnostic', reason: 'broker-unreachable' }, session: active,
      navigators: [], openGrants: [], transcript: [], presence: [], now: 'now', notices: [],
    };
    ({ state } = reduceWatch(state, { kind: 'replace-model', model: fsModel }));
    expect(state.composer).toBeUndefined();
    const attempted = reduceWatch(state, { kind: 'user-channel', state: 'registered' });
    expect(attempted.state.composer).toBeUndefined();
    expect(reduceWatch(attempted.state, { kind: 'text', text: 'forbidden' }).effects).toEqual([]);
  });
});

describe('deferred pre-attach user-channel events (close-out #2)', () => {
  const initial = () => initialWatchState({ width: 100, tail: 10, now: '2026-07-14 19:01:00' });

  test('local bootstrap credential-error before attach is deferred, then applied by the attach (corrupt-local path)', () => {
    let state = initial();
    ({ state } = reduceWatch(state, {
      kind: 'user-channel', state: 'credential-error',
      detail: 'user credential store unreadable (DPAPI decrypt failed) — repair or delete it; it cannot silently regenerate',
    }));
    expect(state.composer).toBeUndefined(); // deferral is not authority
    expect(state.pendingChannel).toMatchObject({ channel: 'credential-error' });

    const step = reduceWatch(state, { kind: 'attach', snapshot: snapshot({ transcript: [] }), endpoint: 'e', now: 'now' });
    expect(step.effects).toEqual(['render']);
    expect(step.state.composer).toMatchObject({ channel: 'credential-error' });
    expect(step.state.composer?.channelDetail).toContain('cannot silently regenerate');
    expect(step.state.pendingChannel).toBeUndefined(); // applied exactly once
  });

  test('auth-degrade (foreign binding) before attach is deferred and applied; input stays read-only in effect terms', () => {
    let state = initial();
    ({ state } = reduceWatch(state, {
      kind: 'user-channel', state: 'credential-error',
      detail: 'user channel is bound to another client. This pane is read-only.',
    }));
    const step = reduceWatch(state, { kind: 'attach', snapshot: snapshot({ transcript: [] }), endpoint: 'e', now: 'now' });
    expect(step.state.composer).toMatchObject({ channel: 'credential-error' });
    expect(step.state.composer?.channelDetail).toContain('bound to another client');
    // credential-error composer has no send path: submit is a no-op
    const submit = reduceWatch(step.state, { kind: 'key', key: 'submit', reqId: 'r1' });
    expect(submit.effects).toEqual([]);
    expect(submit.state.composer?.pending).toBeUndefined();
  });

  test('the latest deferred event wins and unavailable clears the stash', () => {
    let state = initial();
    ({ state } = reduceWatch(state, { kind: 'user-channel', state: 'credential-error', detail: 'stale' }));
    ({ state } = reduceWatch(state, { kind: 'user-channel', state: 'registered' })); // later event replaces the stash
    expect(state.pendingChannel).toMatchObject({ channel: 'registered' });
    ({ state } = reduceWatch(state, { kind: 'user-channel', state: 'unavailable' }));
    expect(state.pendingChannel).toBeUndefined();
    const step = reduceWatch(state, { kind: 'attach', snapshot: snapshot({ transcript: [] }), endpoint: 'e', now: 'now' });
    expect(step.state.composer).toBeUndefined(); // nothing left to apply
  });

  test('fs replace-model never applies the stash; a later broker attach does', () => {
    let state = initial();
    ({ state } = reduceWatch(state, { kind: 'user-channel', state: 'credential-error', detail: 'DPAPI failed' }));
    const fsModel: WatchViewModel = {
      source: { kind: 'fs-diagnostic', reason: 'broker-unreachable' }, session: active,
      navigators: [], openGrants: [], transcript: [], presence: [], now: 'now', notices: [],
    };
    ({ state } = reduceWatch(state, { kind: 'replace-model', model: fsModel }));
    expect(state.composer).toBeUndefined(); // fs never gains composer authority
    expect(state.pendingChannel).toMatchObject({ channel: 'credential-error' }); // but the stash survives
    const step = reduceWatch(state, { kind: 'attach', snapshot: snapshot({ transcript: [] }), endpoint: 'e', now: 'now' });
    expect(step.state.composer).toMatchObject({ channel: 'credential-error', channelDetail: 'DPAPI failed' });
  });

  test('a post-attach user-channel event clears any stale stash', () => {
    let state = initial();
    ({ state } = reduceWatch(state, { kind: 'user-channel', state: 'credential-error', detail: 'early' }));
    let step = reduceWatch(state, { kind: 'attach', snapshot: snapshot({ transcript: [] }), endpoint: 'e', now: 'now' });
    step = reduceWatch(step.state, { kind: 'user-channel', state: 'registered' });
    expect(step.state.composer).toMatchObject({ channel: 'registered' });
    expect(step.state.pendingChannel).toBeUndefined();
  });
});

describe('watch frame equality gate', () => {
  test('emits only changed frames', () => {
    const state = attached();
    const first = diffWatchFrame(state);
    expect(first.frame).toBeDefined();
    const same = diffWatchFrame(state, first.current);
    expect(same.frame).toBeUndefined();
    const resized = reduceWatch(state, { kind: 'resize', width: 120 }).state;
    expect(diffWatchFrame(resized, first.current).frame).toBeDefined();
  });
});

describe('slice-4 action confirmation: freeze-then-mint (F-A7)', () => {
  const registered = () => {
    let state = attached(snapshot({ transcript: [] }));
    ({ state } = reduceWatch(state, { kind: 'user-channel', state: 'registered' }));
    return state;
  };
  const type = (s: ReturnType<typeof registered>, text: string) => reduceWatch(s, { kind: 'text', text }).state;

  test('first Enter freezes the immutable action with NO effect and NO reqId; second Enter mints the reqId and emits the action effect', () => {
    let state = type(registered(), '/kick codex wedged');
    const first = reduceWatch(state, { kind: 'key', key: 'submit', reqId: 'r-first' });
    expect(first.effects).toEqual(['render']); // no action effect yet
    expect(first.state.composer?.confirming).toMatchObject({ verb: 'kick', agent: 'codex', reason: 'wedged' });
    expect(first.state.composer?.pending).toBeUndefined();

    // Buffer edits after the freeze cannot mutate what executes.
    state = type(first.state, ' EDITED');
    const second = reduceWatch(state, { kind: 'key', key: 'submit', reqId: 'r-second' });
    const action = second.effects.find((e) => typeof e !== 'string' && e.kind === 'action');
    expect(action).toMatchObject({ kind: 'action', reqId: 'r-second', action: { verb: 'kick', agent: 'codex', reason: 'wedged' } });
    expect(second.state.composer?.pending).toMatchObject({ reqId: 'r-second', state: 'sending', action: true });
  });

  test('Esc on a frozen CONFIRM aborts back to the editable draft; the buffer survives', () => {
    const state = type(registered(), '/end all done');
    const frozen = reduceWatch(state, { kind: 'key', key: 'submit', reqId: 'r1' }).state;
    expect(frozen.composer?.confirming).toMatchObject({ verb: 'end', summary: 'all done' });
    const aborted = reduceWatch(frozen, { kind: 'key', key: 'escape' });
    expect(aborted.state.composer?.confirming).toBeUndefined();
    expect(aborted.state.composer?.buffer).toBe('/end all done'); // still editable
  });

  test('// escapes to an exact literal-slash advisory send (ruling Q3); unknown verbs hint without freezing', () => {
    const escaped = reduceWatch(type(registered(), '//end is a nice word'), { kind: 'key', key: 'submit', reqId: 'r2' });
    const submit = escaped.effects.find((e) => typeof e !== 'string' && e.kind === 'submit');
    expect(submit).toMatchObject({ kind: 'submit', body: '/end is a nice word' }); // exact, no leading space
    expect(escaped.state.composer?.confirming).toBeUndefined();

    const unknown = reduceWatch(type(registered(), '/frobnicate now'), { kind: 'key', key: 'submit', reqId: 'r3' });
    expect(unknown.effects).toEqual(['render']);
    expect(unknown.state.composer?.confirming).toBeUndefined();
    expect(unknown.state.composer?.actionHint).toContain('//frobnicate');
  });

  test('the pending slot serializes actions against sends, and a committed action notice clears the action pending by groupId', () => {
    let state = type(registered(), '/end ship it');
    ({ state } = reduceWatch(state, { kind: 'key', key: 'submit', reqId: 'rf' }));
    ({ state } = reduceWatch(state, { kind: 'key', key: 'submit', reqId: 'r-mint' }));
    expect(state.composer?.pending).toMatchObject({ reqId: 'r-mint', action: true });
    // While the action is in flight, a new submit is a no-op.
    const blocked = reduceWatch(type(state, 'hello'), { kind: 'key', key: 'submit', reqId: 'r-other' });
    expect(blocked.effects).toEqual([]);
    // The committed ACTION NOTICE (groupId === reqId) clears the pending.
    ({ state } = reduceWatch(state, {
      kind: 'activity',
      activity: {
        seq: 5, session: active,
        entries: [{ deliveryId: 'n1:claude', message: userStored('n1', 'claude', 'r-mint') }],
        ackedDeliveryIds: [], voidedDeliveryIds: [],
      },
    }));
    expect(state.composer?.pending).toBeUndefined();
    expect(state.composer?.confirming).toBeUndefined(); // frozen draft dropped with the clear
  });
});

describe('action retry survives a recovery re-push (codex step-5 audit B)', () => {
  test('pending:error action + user-channel registered re-push preserves the frozen draft; Enter re-emits with the SAME reqId', () => {
    let state = attached(snapshot({ transcript: [] }));
    ({ state } = reduceWatch(state, { kind: 'user-channel', state: 'registered' }));
    ({ state } = reduceWatch(state, { kind: 'text', text: '/end wrap up' }));
    ({ state } = reduceWatch(state, { kind: 'key', key: 'submit', reqId: 'rf' })); // freeze
    ({ state } = reduceWatch(state, { kind: 'key', key: 'submit', reqId: 'r-mint' })); // mint + effect
    ({ state } = reduceWatch(state, { kind: 'submit-result', reqId: 'r-mint', ok: false, error: 'IPC connection closed' }));
    expect(state.composer?.pending).toMatchObject({ reqId: 'r-mint', state: 'error', action: true });

    // Recovery adoptSession re-pushes attach + registered; the rebuild must
    // NOT orphan the frozen draft.
    ({ state } = reduceWatch(state, { kind: 'attach', snapshot: snapshot({ transcript: [] }), endpoint: 'e', now: 'later' }));
    ({ state } = reduceWatch(state, { kind: 'user-channel', state: 'registered' }));
    expect(state.composer?.confirming).toMatchObject({ verb: 'end', summary: 'wrap up' });
    expect(state.composer?.pending).toMatchObject({ reqId: 'r-mint', state: 'error' });

    // Enter retries: SAME reqId, action effect re-emitted — never a no-op.
    const retry = reduceWatch(state, { kind: 'key', key: 'submit', reqId: 'r-fresh-candidate' });
    const effect = retry.effects.find((e) => typeof e !== 'string' && e.kind === 'action');
    expect(effect).toMatchObject({ kind: 'action', reqId: 'r-mint', action: { verb: 'end', summary: 'wrap up' } });
    expect(retry.state.composer?.pending).toMatchObject({ reqId: 'r-mint', state: 'sending' });
  });
});
