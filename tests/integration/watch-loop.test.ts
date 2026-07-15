import { describe, expect, test } from 'bun:test';
import type { ObserverPush, ObserverSession, ObserverSnapshotDto } from '@app/ports/gateway.ts';
import type { WatchEvent, WatchReducer } from '@adapters/tui/events.ts';
import { reduceWatch } from '@adapters/tui/reducer.ts';
import { runBrokerEventLoop, type ObserverGatewayLike } from '../../src/apps/cli/watchLoop.ts';
import type { TerminalHandlers, TerminalSession } from '../../src/apps/cli/term.ts';

/**
 * Deterministic host-loop races (codex live review of the slice-2 host):
 * quit stays responsive while the broker is absent, and a gap-triggered
 * reattach can never be torn down by the dying pump's stale 'lost'.
 */

const sessionState = { task: 't', agents: ['claude', 'codex'], driver: 'claude', turn: 'codex', status: 'active', started: 's', grants: {} } as const;

const snapshotAt = (seq: number): ObserverSnapshotDto => ({
  seq,
  session: sessionState,
  transcript: [],
  liveness: { broker: { pid: 1, epoch: 1, heartbeatAt: 'h' }, agents: {} },
  broker: { pid: 1, epoch: 1, endpoint: 'e', heartbeatAt: 'h' },
});

/** Controllable observer session: emit pushes; close() fails the stream
 * like a real socket teardown does. */
function fakeSession(seq: number) {
  let failPushes: (e: unknown) => void = () => undefined;
  let nextPush: ((p: ObserverPush) => void) | undefined;
  const buffered: ObserverPush[] = [];
  const pushes: AsyncIterable<ObserverPush> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<ObserverPush>>((resolve, reject) => {
            const value = buffered.shift();
            if (value) return resolve({ done: false, value });
            nextPush = (p) => resolve({ done: false, value: p });
            failPushes = reject;
          }),
      };
    },
  };
  const session: ObserverSession = {
    snapshot: snapshotAt(seq),
    pushes,
    close: async () => {
      // Real teardown surfaces as an iteration error in the pump.
      failPushes(new Error('connection closed'));
    },
  };
  return {
    session,
    emit: (p: ObserverPush) => {
      if (nextPush) {
        const deliver = nextPush;
        nextPush = undefined;
        deliver(p);
      } else buffered.push(p);
    },
  };
}

function fakeTerminal(): { factory: (handlers: TerminalHandlers) => TerminalSession; quit: () => void } {
  let captured: TerminalHandlers | undefined;
  return {
    factory: (handlers) => {
      captured = handlers;
      return { interactive: false, width: () => 80, close: () => undefined };
    },
    quit: () => captured?.onQuit(),
  };
}

const until = async (predicate: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await Bun.sleep(10);
  }
};

describe('watch event loop host', () => {
  test('quit exits promptly while the broker is absent (attach retries never block the consumer)', async () => {
    const gateway: ObserverGatewayLike = {
      observe: async () => {
        throw new Error('ECONNREFUSED');
      },
      close: async () => undefined,
    };
    const term = fakeTerminal();
    const seen: WatchEvent[] = [];
    const spy: WatchReducer = (state, event) => {
      seen.push(event);
      return reduceWatch(state, event);
    };
    const loop = runBrokerEventLoop('unused-root', { tail: 5, refreshSec: 2 }, spy, { gateway, terminal: term.factory, reattachDelayMs: 25 });
    await until(() => seen.some((e) => e.kind === 'connection' && e.state === 'reattaching'));
    const started = Date.now();
    term.quit();
    expect(await loop).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000); // prompt, not after a retry cycle
  }, 10_000);

  test('gap-triggered reattach: the dying pump cannot enqueue a stale lost that tears down the fresh session', async () => {
    const first = fakeSession(10);
    const second = fakeSession(42);
    let observeCalls = 0;
    const gateway: ObserverGatewayLike = {
      observe: async () => {
        observeCalls += 1;
        return observeCalls === 1 ? first.session : second.session;
      },
      close: async () => undefined,
    };
    const term = fakeTerminal();
    const seen: WatchEvent[] = [];
    const spy: WatchReducer = (state, event) => {
      seen.push(event);
      return reduceWatch(state, event);
    };
    const loop = runBrokerEventLoop('unused-root', { tail: 5, refreshSec: 2 }, spy, { gateway, terminal: term.factory, reattachDelayMs: 10 });
    await until(() => seen.some((e) => e.kind === 'attach' && e.snapshot.seq === 10));
    // Stream gap: seq jumps far beyond head → reducer orders a reattach;
    // closing the first session fails its pump stream (like a socket).
    first.emit({ kind: 'activity', seq: 16, at: 't', principal: 'p', events: [], session: sessionState, ackedDeliveryIds: [], voidedDeliveryIds: [] });
    await until(() => seen.some((e) => e.kind === 'attach' && e.snapshot.seq === 42));
    await Bun.sleep(100); // give any stale 'lost' a window to arrive
    const secondAttachIndex = seen.findIndex((e) => e.kind === 'attach' && e.snapshot.seq === 42);
    const afterReattach = seen.slice(secondAttachIndex);
    expect(afterReattach.some((e) => e.kind === 'connection' && e.state === 'lost')).toBeFalse();
    expect(observeCalls).toBe(2);
    term.quit();
    expect(await loop).toBe(0);
  }, 10_000);
});
