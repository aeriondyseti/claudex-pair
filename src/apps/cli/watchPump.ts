import type { Event } from '@core/events.ts';
import type { LivenessDto, ObserverPush, ObserverSnapshotDto } from '@app/ports/gateway.ts';
import type { StoredMessage } from '@app/ports/index.ts';
import { fsMessageCodec } from '@adapters/fs/brokerMirrors.ts';
import type { WatchActivity, WatchEvent } from '@adapters/tui/events.ts';

/**
 * Transport pump decode (slice-2 host lane): wire observer pushes become
 * the frozen WatchEvent shapes. The message codec lives HERE, outside the
 * tui layer, per the seam contract — the reducer receives message-sent
 * events already rendered to stored form, keyed by deliveryId.
 */

export function decodePush(push: ObserverPush): WatchEvent {
  if (push.kind === 'presence') return { kind: 'presence', liveness: push.liveness as LivenessDto };
  const activity: WatchActivity = {
    seq: push.seq,
    session: push.session,
    entries: push.events.flatMap((event) =>
      event.kind === 'message-sent' ? [{ deliveryId: `${event.id}:${event.to}`, message: toStored(event) }] : [],
    ),
    ackedDeliveryIds: push.ackedDeliveryIds,
    voidedDeliveryIds: push.voidedDeliveryIds,
  };
  return { kind: 'activity', activity };
}

export function attachEvent(snapshot: ObserverSnapshotDto, endpoint: string, now: string): WatchEvent {
  return { kind: 'attach', snapshot, endpoint, now };
}

export function toStored(event: Extract<Event, { kind: 'message-sent' }>): StoredMessage {
  const pair = { id: event.id, from: event.from, to: event.to, type: event.type, turn: event.turn, sent: event.at, body: event.body };
  return {
    name: fsMessageCodec.filename(pair),
    header: {
      id: event.id, from: event.from, to: event.to, type: event.type, turn: event.turn, sent: event.at,
      // U1: composer reconciliation and badges key on these — dropping them
      // here made live sends never clear pending (codex slice review #1).
      ...(event.groupId === undefined ? {} : { groupId: event.groupId }),
      ...(event.provenance === undefined ? {} : { provenance: event.provenance }),
      ...(event.actionKind === undefined ? {} : { actionKind: event.actionKind }),
      ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
    },
    body: event.body,
    raw: fsMessageCodec.raw(pair),
  };
}

/**
 * Single-consumer event queue merging the pump sources (transport pushes,
 * ticker, terminal key/resize) into one ordered stream for the reducer
 * loop. push() after close() is a no-op — late transport callbacks must
 * not resurrect a finished loop.
 */
export class WatchEventQueue implements AsyncIterable<WatchEvent>, AsyncIterator<WatchEvent> {
  private values: WatchEvent[] = [];
  private waiters: Array<{ resolve: (r: IteratorResult<WatchEvent>) => void; reject: (e: unknown) => void }> = [];
  private ended = false;
  private error: unknown;
  push(event: WatchEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else this.values.push(event);
  }
  /** Poison the stream: the consumer's for-await rethrows (e.g. a
   * background attach discovering there is no broker session to watch). */
  fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }
  next(): Promise<IteratorResult<WatchEvent>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}
