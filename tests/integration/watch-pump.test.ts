import { describe, expect, test } from 'bun:test';
import type { ObserverPush } from '@app/ports/gateway.ts';
import { decodePush, WatchEventQueue } from '../../src/apps/cli/watchPump.ts';

/** Host-lane pump decode: wire pushes → frozen WatchEvent shapes (slice 2). */

const session = { topology: 'pair' as const, task: 't', agents: ['claude', 'codex'], driver: 'claude', turn: 'codex', status: 'active', started: 's', grants: {}, registry: { version: 1, agents: {} } } as const;

describe('watch pump decode', () => {
  test('activity push decodes message-sent events to stored entries keyed by deliveryId', () => {
    const push: ObserverPush = {
      kind: 'activity',
      seq: 7,
      at: '2026-07-14 19:30:00',
      principal: 'claude',
      events: [
        { kind: 'message-sent', id: 'm1', from: 'claude', to: 'codex', type: 'ask', turn: 'pass', body: 'hi', at: '2026-07-14 19:30:00' },
        { kind: 'turn-passed', from: 'claude', to: 'codex', at: '2026-07-14 19:30:00' } as never, // non-message events pass through untranslated
      ],
      session,
      ackedDeliveryIds: ['m0:claude'],
      voidedDeliveryIds: [],
    };
    const event = decodePush(push);
    expect(event.kind).toBe('activity');
    if (event.kind !== 'activity') return;
    expect(event.activity.seq).toBe(7);
    expect(event.activity.entries.length).toBe(1);
    expect(event.activity.entries[0]!.deliveryId).toBe('m1:codex');
    expect(event.activity.entries[0]!.message.header.from).toBe('claude');
    expect(event.activity.entries[0]!.message.body).toBe('hi');
    expect(event.activity.entries[0]!.message.name).toContain('m1');
    expect(event.activity.ackedDeliveryIds).toEqual(['m0:claude']);
  });

  test('presence push decodes to a presence event', () => {
    const liveness = { agents: { codex: { connectedSince: 'now' } } };
    const event = decodePush({ kind: 'presence', liveness });
    expect(event).toEqual({ kind: 'presence', liveness });
  });
});

describe('watch event queue', () => {
  test('delivers in order, and push after close is a no-op', async () => {
    const queue = new WatchEventQueue();
    queue.push({ kind: 'tick', now: 't1' });
    queue.push({ kind: 'resize', width: 80 });
    const first = await queue.next();
    const second = await queue.next();
    expect(first.value).toEqual({ kind: 'tick', now: 't1' });
    expect(second.value).toEqual({ kind: 'resize', width: 80 });
    queue.close();
    queue.push({ kind: 'tick', now: 't2' }); // late transport callback
    expect((await queue.next()).done).toBeTrue();
  });

  test('a blocked consumer wakes on push and ends on close', async () => {
    const queue = new WatchEventQueue();
    const pending = queue.next();
    queue.push({ kind: 'key', key: 'quit' });
    expect((await pending).value).toEqual({ kind: 'key', key: 'quit' });
    const closed = queue.next();
    queue.close();
    expect((await closed).done).toBeTrue();
  });
});

describe('push → reducer pending reconciliation (close-out #1)', () => {
  test('a committed user activity decoded from the wire clears the composer pending with the matching reqId', async () => {
    const { reduceWatch } = await import('@adapters/tui/reducer.ts');
    const { initialWatchState } = await import('@adapters/tui/events.ts');
    const session = { topology: 'pair' as const, task: 't', agents: ['claude', 'codex'], driver: 'claude', turn: 'claude', status: 'active', started: 's', grants: {}, registry: { version: 1, agents: {} } } as const;
    const snapshot = {
      seq: 4, session, transcript: [],
      liveness: { broker: { pid: 1, epoch: 1, heartbeatAt: 'h' }, agents: {} },
      broker: { pid: 1, epoch: 1, endpoint: 'e', heartbeatAt: 'h' },
    };

    // Attach, gain a registered composer, and put a submit in flight.
    let state = initialWatchState({ width: 100, tail: 10, now: 'now' });
    ({ state } = reduceWatch(state, { kind: 'attach', snapshot, endpoint: 'e', now: 'now' }));
    ({ state } = reduceWatch(state, { kind: 'user-channel', state: 'registered' }));
    ({ state } = reduceWatch(state, { kind: 'text', text: 'ship it' }));
    ({ state } = reduceWatch(state, { kind: 'key', key: 'submit', reqId: 'req-9' }));
    expect(state.composer?.pending).toMatchObject({ reqId: 'req-9', state: 'sending' });
    // A successful wire result alone must NOT clear pending (commit is truth).
    ({ state } = reduceWatch(state, { kind: 'submit-result', reqId: 'req-9', ok: true }));
    expect(state.composer?.pending).toMatchObject({ reqId: 'req-9' });

    // The committed activity arrives on the WIRE and flows through decodePush
    // — the real pump path — carrying groupId === reqId.
    const wirePush = {
      kind: 'activity', seq: 5, at: 'later', principal: 'user-client',
      session,
      events: [{
        kind: 'message-sent', id: 'u1', from: 'user', to: 'claude', type: 'info', turn: 'keep',
        body: 'ship it', at: 'later', groupId: 'req-9', provenance: 'trusted_user_client',
      }],
      ackedDeliveryIds: [], voidedDeliveryIds: [],
    } as unknown as ObserverPush;
    const decoded = decodePush(wirePush);
    expect(decoded.kind).toBe('activity');
    const step = reduceWatch(state, decoded);
    expect(step.state.composer?.pending).toBeUndefined(); // reconciled by commit, not by wire ack
    expect(step.effects).toContain('render');

    // Determinism guard: an activity with a DIFFERENT groupId must not clear.
    let other = state;
    const otherPush = { ...(wirePush as unknown as Record<string, unknown>), events: [{ kind: 'message-sent', id: 'u2', from: 'user', to: 'claude', type: 'info', turn: 'keep', body: 'x', at: 'later', groupId: 'req-OTHER', provenance: 'trusted_user_client' }] } as unknown as ObserverPush;
    ({ state: other } = reduceWatch(other, decodePush(otherPush)));
    expect(other.composer?.pending).toMatchObject({ reqId: 'req-9' }); // still awaiting its own commit
  });
});

describe('actionKind projection (codex step-5 audit A)', () => {
  test('decodePush carries actionKind from the wire event into the stored header', async () => {
    const wirePush = {
      kind: 'activity', seq: 6, at: 't', principal: 'user-client',
      session: { topology: 'pair' as const, task: 't', agents: ['claude', 'codex'], driver: 'claude', turn: 'claude', status: 'active', started: 's', grants: {} },
      events: [{
        kind: 'message-sent', id: 'a1', from: 'user', to: 'claude', type: 'done', turn: 'keep',
        body: 'Session ended by user.', at: 't', groupId: 'req-7', provenance: 'trusted_user_client', actionKind: 'end',
      }],
      ackedDeliveryIds: [], voidedDeliveryIds: [],
    } as unknown as ObserverPush;
    const decoded = decodePush(wirePush);
    if (decoded.kind !== 'activity') throw new Error('expected activity');
    expect(decoded.activity.entries[0]!.message.header).toMatchObject({ actionKind: 'end', groupId: 'req-7', provenance: 'trusted_user_client' });
  });
});
