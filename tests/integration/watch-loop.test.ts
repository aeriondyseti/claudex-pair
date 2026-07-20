import { describe, expect, test } from 'bun:test';
import type { ObserverPush, ObserverSession, ObserverSnapshotDto } from '@app/ports/gateway.ts';
import type { WatchEvent, WatchReducer } from '@adapters/tui/events.ts';
import { reduceWatch } from '@adapters/tui/reducer.ts';
import { runBrokerEventLoop, runFsEventLoop, type ObserverGatewayLike } from '../../src/apps/cli/watchLoop.ts';
import type { bindFsDeps } from '../../src/apps/cli/bind.ts';
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
    const spawnArgs: (boolean | undefined)[] = [];
    const gateway: ObserverGatewayLike = {
      observe: async (spawn) => {
        spawnArgs.push(spawn);
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
    const loop = runBrokerEventLoop('unused-root', { tail: 5, refreshSec: 2 }, spy, { gateway, terminal: term.factory, reattachDelayMs: 25, write: () => undefined });
    await until(() => seen.some((e) => e.kind === 'connection' && e.state === 'reattaching'));
    await until(() => spawnArgs.length >= 2); // at least one RETRY happened
    const started = Date.now();
    term.quit();
    expect(await loop).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000); // prompt, not after a retry cycle
    // Failed initial attempts must NOT burn the spawn permission.
    expect(spawnArgs.length).toBeGreaterThan(1);
    expect(spawnArgs.every((s) => s === true)).toBeTrue();
  }, 10_000);

  test('spawn permission flips only after the first SUCCESSFUL attach; reattaches are connect-only', async () => {
    const first = fakeSession(10);
    const second = fakeSession(20);
    const spawnArgs: (boolean | undefined)[] = [];
    let calls = 0;
    const gateway: ObserverGatewayLike = {
      observe: async (spawn) => {
        spawnArgs.push(spawn);
        calls += 1;
        if (calls === 1) throw new Error('ECONNREFUSED'); // failed spawn attempt
        if (calls === 2) return first.session;
        return second.session;
      },
      close: async () => undefined,
    };
    const term = fakeTerminal();
    const seen: WatchEvent[] = [];
    const spy: WatchReducer = (state, event) => {
      seen.push(event);
      return reduceWatch(state, event);
    };
    const loop = runBrokerEventLoop('unused-root', { tail: 5, refreshSec: 2 }, spy, { gateway, terminal: term.factory, reattachDelayMs: 10, write: () => undefined });
    await until(() => seen.some((e) => e.kind === 'attach' && e.snapshot.seq === 10));
    // Force a reattach via stream gap.
    first.emit({ kind: 'activity', seq: 16, at: 't', principal: 'p', events: [], session: sessionState, ackedDeliveryIds: [], voidedDeliveryIds: [] });
    await until(() => seen.some((e) => e.kind === 'attach' && e.snapshot.seq === 20));
    expect(spawnArgs).toEqual([true, true, false]); // failure keeps true; success flips; reattach connect-only
    term.quit();
    expect(await loop).toBe(0);
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
    const loop = runBrokerEventLoop('unused-root', { tail: 5, refreshSec: 2 }, spy, { gateway, terminal: term.factory, reattachDelayMs: 10, write: () => undefined });
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

  test('fs poller is single-flight (no overlap, no stale overwrite) and a read failure retries instead of rejecting', async () => {
    let loads = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const fsDeps = {
      clock: { now: () => `2026-07-14 19:00:${String(loads).padStart(2, '0')}`, epochMs: () => Date.now(), sleep: (ms: number) => Bun.sleep(ms) },
      store: {
        load: async () => {
          loads += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (loads === 2) {
            inFlight -= 1;
            throw new Error('transient mirror read failure');
          }
          await Bun.sleep(60); // slower than the poll interval — would overlap under setInterval
          inFlight -= 1;
          return { ...sessionState, task: `t${loads}` };
        },
      },
      mailbox: { archived: async () => [], pending: async () => [] },
    } as unknown as ReturnType<typeof bindFsDeps>;
    const term = fakeTerminal();
    const seen: WatchEvent[] = [];
    const spy: WatchReducer = (state, event) => {
      seen.push(event);
      return reduceWatch(state, event);
    };
    const loop = runFsEventLoop('unused-root', { tail: 5, refreshSec: 0.02 }, spy, { fsDeps, terminal: term.factory, write: () => undefined });
    await until(() => seen.filter((e) => e.kind === 'replace-model').length >= 3);
    expect(maxInFlight).toBe(1); // serialized by construction
    const models = seen.filter((e): e is Extract<WatchEvent, { kind: 'replace-model' }> => e.kind === 'replace-model');
    // Monotonic: each replacement comes from a strictly later load — a slow
    // older read can never overwrite a newer model.
    const tasks = models.map((m) => Number(m.model.session.task.slice(1)));
    expect([...tasks].sort((a, b) => a - b)).toEqual(tasks);
    expect(tasks.length).toBe(new Set(tasks).size);
    expect(tasks).not.toContain(2); // the failed read produced no replacement — and no crash
    term.quit();
    expect(await loop).toBe(0);
  }, 10_000);

  test('submit recovery (design §5 idle contract): dead broker → user submit respawns via authenticated reattach → exactly ONE committed send with the immutable reqId', async () => {
    const userChannel = { registered: true, authenticated: true };
    const sessionA = fakeSession(1);
    (sessionA.session.snapshot as { userChannel?: typeof userChannel }).userChannel = userChannel;
    const sends: { reqId: string; target: string; body: string }[] = [];
    const sessionB = fakeSession(1);
    (sessionB.session.snapshot as { userChannel?: typeof userChannel }).userChannel = userChannel;
    const userSessionA = { ...sessionA.session, send: async () => { throw new Error('IPC connection closed'); } };
    const userSessionB = { ...sessionB.session, send: async (reqId: string, target: string, body: string) => void sends.push({ reqId, target, body }) };

    const attachCalls: boolean[] = []; // spawn flag per userAttach call
    let brokerAlive = true;
    const gateway: ObserverGatewayLike = {
      observe: async () => { throw new Error('observe must not be used when a token is present'); },
      userAttach: async (_token, spawn) => {
        attachCalls.push(spawn === true);
        if (attachCalls.length === 1) return userSessionA; // initial attach (spawn allowed)
        if (!spawn && !brokerAlive) throw new Error('ECONNREFUSED'); // background connect-only vs dead broker
        brokerAlive = true; // spawn=true resurrects it (the recovery path)
        return userSessionB;
      },
      close: async () => undefined,
    };

    let handlers: TerminalHandlers | undefined;
    const term = {
      factory: (h: TerminalHandlers) => { handlers = h; return { interactive: true, width: () => 80, close: () => undefined }; },
    };
    const seen: WatchEvent[] = [];
    const spy: WatchReducer = (state, event) => { seen.push(event); return reduceWatch(state, event); };
    const loop = runBrokerEventLoop('unused-root', { tail: 5, refreshSec: 2, userToken: 'u'.repeat(64) }, spy, {
      gateway, terminal: term.factory, reattachDelayMs: 25, write: () => undefined,
    });

    // Attach A, composer registered.
    await until(() => seen.some((e) => e.kind === 'user-channel' && e.state === 'registered'));
    // Broker idle-exits: A's stream dies silently.
    brokerAlive = false;
    await sessionA.session.close();
    await until(() => seen.some((e) => e.kind === 'connection' && e.state === 'lost'));
    await until(() => attachCalls.some((spawn) => !spawn)); // background loop is retrying connect-only

    // The user types and submits into the dead channel.
    handlers!.onText!('ship it');
    handlers!.onKey?.('submit');
    await until(() => seen.some((e) => e.kind === 'submit-result' && e.ok));

    expect(sends.length).toBe(1); // exactly one committed send
    expect(sends[0]!.body).toBe('ship it');
    const submitEvent = seen.find((e): e is Extract<WatchEvent, { kind: 'key'; key: 'submit' }> => e.kind === 'key' && e.key === 'submit')!;
    expect(sends[0]!.reqId).toBe(submitEvent.reqId); // immutable payload, reqId reused verbatim
    expect(attachCalls[0]).toBeTrue(); // initial attach may spawn
    expect(attachCalls[attachCalls.length - 1]).toBeTrue(); // the RECOVERY attach spawned
    expect(attachCalls.slice(1, -1).every((spawn) => !spawn)).toBeTrue(); // background stayed connect-only throughout
    // The recovered session re-attached authenticated: a fresh attach event
    // and a registered channel event followed the recovery.
    expect(seen.filter((e) => e.kind === 'attach').length).toBeGreaterThanOrEqual(2);

    handlers!.onQuit();
    expect(await loop).toBe(0);
  }, 10_000);

  test('mid-submit idempotent recovery: broker commits but the response is lost — the retry dedups to exactly ONE commit (design §5)', async () => {
    const userChannel = { registered: true, authenticated: true };
    // Committed reqIds survive "broker restart" here because dedup is
    // journal-backed in the real broker (pinned by the core test 'dedup
    // replays before allocation'); this models that contract at the host
    // seam to prove the recovery path composes with it.
    const commits: string[] = [];
    let attempts = 0;
    const makeUserSession = (failAfterCommit: boolean) => {
      const s = fakeSession(1);
      (s.session.snapshot as { userChannel?: typeof userChannel }).userChannel = userChannel;
      return {
        ...s.session,
        send: async (reqId: string) => {
          attempts += 1;
          if (!commits.includes(reqId)) commits.push(reqId); // commit lands
          if (failAfterCommit) throw new Error('IPC connection closed'); // …but the response is lost
        },
      };
    };
    const attachCalls: boolean[] = [];
    const gateway: ObserverGatewayLike = {
      observe: async () => { throw new Error('token present'); },
      userAttach: async (_token, spawn) => {
        attachCalls.push(spawn === true);
        return attachCalls.length === 1 ? makeUserSession(true) : makeUserSession(false);
      },
      close: async () => undefined,
    };
    let handlers: TerminalHandlers | undefined;
    const seen: WatchEvent[] = [];
    const spy: WatchReducer = (state, event) => { seen.push(event); return reduceWatch(state, event); };
    const loop = runBrokerEventLoop('unused-root', { tail: 5, refreshSec: 2, userToken: 'u'.repeat(64) }, spy, {
      gateway,
      terminal: (h) => { handlers = h; return { interactive: true, width: () => 80, close: () => undefined }; },
      reattachDelayMs: 25,
      write: () => undefined,
    });
    await until(() => seen.some((e) => e.kind === 'user-channel' && e.state === 'registered'));
    handlers!.onText!('exactly once');
    handlers!.onKey?.('submit');
    await until(() => seen.some((e) => e.kind === 'submit-result' && e.ok));

    expect(attempts).toBe(2); // original + the single recovery retry
    expect(commits.length).toBe(1); // dedup by verbatim reqId: exactly one commit
    expect(attachCalls[attachCalls.length - 1]).toBeTrue(); // recovery reattached with spawn allowed
    handlers!.onQuit();
    expect(await loop).toBe(0);
  }, 10_000);

  test('non-TTY exclusion proof (close-out #7): zero credential activity, zero user-attach, no send path — even with a registered broker binding', async () => {
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { runWatch } = await import('../../src/apps/cli/watch.ts');
    const root = await mkdtemp(join(tmpdir(), 'claudex-nontty-'));
    await mkdir(join(root, '.pair', 'journal'), { recursive: true }); // broker-mode routing
    try {
      // Strongest configuration: the session HAS a registered user channel;
      // the non-interactive host must still touch nothing.
      const bound = fakeSession(1);
      (bound.session.snapshot as { userChannel?: { registered: boolean } }).userChannel = { registered: true };
      let credentialCalls = 0;
      let userAttachCalls = 0;
      const gateway: ObserverGatewayLike = {
        observe: async () => bound.session,
        userAttach: async () => { userAttachCalls += 1; throw new Error('must never be called'); },
        close: async () => undefined,
      };
      const term = fakeTerminal();
      // The reducer spy seam is on the loop, not runWatch — assert via the
      // rendered frames (the loop's observable output) instead.
      const frames: string[] = [];
      const loop = runWatch(root, { tail: 5, refreshSec: 2 }, {
        interactive: false, // the exclusion under test
        loadCredential: async () => { credentialCalls += 1; return { kind: 'created', token: 'x'.repeat(64) }; },
        gateway,
        terminal: term.factory,
        write: (chunk) => void frames.push(chunk),
        reattachDelayMs: 25,
      });
      await until(() => frames.length >= 1);
      term.quit();
      expect(await loop).toBe(0);

      expect(credentialCalls).toBe(0); // store never loaded, never created
      expect(userAttachCalls).toBe(0); // never authenticated
      const rendered = frames.join('');
      expect(rendered).not.toContain('to:*'); // no composer input affordance
      expect(rendered).not.toContain('USER CREDENTIAL ERROR'); // and no phantom error either
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
