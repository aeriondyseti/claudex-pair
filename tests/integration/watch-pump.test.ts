import { describe, expect, test } from 'bun:test';
import type { ObserverPush } from '@app/ports/gateway.ts';
import { decodePush, WatchEventQueue } from '../../src/apps/cli/watchPump.ts';

/** Host-lane pump decode: wire pushes → frozen WatchEvent shapes (slice 2). */

const session = { task: 't', agents: ['claude', 'codex'], driver: 'claude', turn: 'codex', status: 'active', started: 's', grants: {} } as const;

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
