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
