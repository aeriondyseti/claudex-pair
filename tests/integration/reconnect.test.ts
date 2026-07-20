import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IpcClient, IpcServer, endpointFor } from '@adapters/ipc/index.ts';
import type { SubscribeFrame } from '@adapters/ipc/types.ts';
import { BrokerGateway } from '../../src/apps/cli/brokerGateway.ts';

/**
 * Subscription reconnect hardening (micro-slice before U1): broker churn
 * must not kill a fused wait — bounded backoff, same clientId, last-ACKED
 * cursor on the new connection, cancellation on close.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const message = (id: string) => ({
  name: `${id}-codex.md`,
  header: { id, from: 'claude', to: 'codex', type: 'ask', turn: 'pass', sent: 's' },
  body: `body-${id}`,
  raw: `raw-${id}`,
});

function server(endpoint: string, epoch: number, onSubscribe: (frame: SubscribeFrame, send: (frame: unknown) => Promise<void>) => Promise<void> | void) {
  return new IpcServer({
    endpoint, token: 'token', epoch,
    handler: async (frame, connection) => {
      if (frame.kind === 'subscribe') {
        await onSubscribe(frame, (f) => connection.send(f as Parameters<typeof connection.send>[0]));
        return { reqId: frame.reqId, ok: true };
      }
      return { reqId: frame.reqId, ok: true };
    },
  });
}

describe('subscription reconnect', () => {
  test('survives broker restart: bounded retries, same clientId, last-ACKED cursor presented to the new broker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-reconnect-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpointA = endpointFor(root, 1);
    const endpointB = endpointFor(root, 2);

    const subscribesA: SubscribeFrame[] = [];
    const serverA = server(endpointA, 1, async (frame, send) => {
      subscribesA.push(frame);
      await send({ kind: 'delivery', deliverySeq: 5, deliveryId: 'm5:codex', message: message('m5') });
    });
    await serverA.listen();

    const subscribesB: SubscribeFrame[] = [];
    const serverB = server(endpointB, 2, async (frame, send) => {
      subscribesB.push(frame);
      await send({ kind: 'delivery', deliverySeq: 6, deliveryId: 'm6:codex', message: message('m6') });
    });
    cleanups.push(() => serverB.close().catch(() => undefined));

    let rediscoveries = 0;
    const clientFor = (endpoint: string, epoch: number) => new IpcClient({ endpoint, token: 'token', epoch, clientId: 'stable-client' });
    const gateway = new BrokerGateway(
      {
        clientId: 'stable-client',
        connect: async () => clientFor(endpointA, 1),
        rediscover: async () => {
          rediscoveries += 1;
          if (rediscoveries === 1) throw new Error('broker not back yet'); // first retry fails → backoff
          if (rediscoveries === 2) await serverB.listen(); // broker respawned at a new epoch
          return clientFor(endpointB, 2);
        },
      },
      { maxAttempts: 5, baseDelayMs: 20, maxDelayMs: 80 },
    );
    cleanups.push(() => gateway.close());

    const subscription = await gateway.subscribe('codex', 0);
    const iterator = subscription.deliveries[Symbol.asyncIterator]();
    const first = (await iterator.next()).value!;
    expect(first.deliveryId).toBe('m5:codex');
    await subscription.ack('m5:codex'); // cursor now 5

    await serverA.close(); // broker dies
    const second = (await iterator.next()).value!; // arrives via the reconnected subscription
    expect(second.deliveryId).toBe('m6:codex');

    expect(subscribesA[0]!.clientId).toBe('stable-client');
    expect(subscribesB.length).toBe(1);
    expect(subscribesB[0]!.clientId).toBe('stable-client'); // identity preserved
    expect(subscribesB[0]!.afterDeliverySeq).toBe(5); // last-ACKED cursor, not observed
    await subscription.close();
  }, 15_000);

  test('permanently-gone broker: bounded attempts then the stream fails (no infinite retry/spawn storm)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-reconnect-dead-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpoint = endpointFor(root, 3);
    const serverA = server(endpoint, 3, () => undefined);
    await serverA.listen();

    let attempts = 0;
    const gateway = new BrokerGateway(
      {
        clientId: 'doomed-client',
        connect: async () => new IpcClient({ endpoint, token: 'token', epoch: 3, clientId: 'doomed-client' }),
        rediscover: async () => { attempts += 1; throw new Error('gone for good'); },
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20 },
    );
    cleanups.push(() => gateway.close());

    const subscription = await gateway.subscribe('codex', 0);
    const next = subscription.deliveries[Symbol.asyncIterator]().next();
    await serverA.close();
    let failed = false;
    try { await next; } catch { failed = true; }
    expect(failed).toBeTrue();
    expect(attempts).toBe(3); // bounded — never a retry storm
    await subscription.close();
  }, 15_000);

  test('close() during backoff cancels promptly — no extra rediscover, no waiting out the delay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-reconnect-cancel-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpoint = endpointFor(root, 4);
    const serverA = server(endpoint, 4, () => undefined);
    await serverA.listen();

    let attempts = 0;
    const gateway = new BrokerGateway(
      {
        clientId: 'cancel-client',
        connect: async () => new IpcClient({ endpoint, token: 'token', epoch: 4, clientId: 'cancel-client' }),
        rediscover: async () => { attempts += 1; throw new Error('still down'); },
      },
      { maxAttempts: 100, baseDelayMs: 5_000, maxDelayMs: 5_000 }, // close must NOT wait this out
    );
    cleanups.push(() => gateway.close());

    const subscription = await gateway.subscribe('codex', 0);
    await serverA.close();
    // First rediscover fails fast, then the loop parks in a 5s backoff.
    const deadline = Date.now() + 2_000;
    while (attempts === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(attempts).toBe(1);
    const started = Date.now();
    await subscription.close(); // breaks the backoff sleep immediately
    expect(Date.now() - started).toBeLessThan(500);
    await Bun.sleep(100);
    expect(attempts).toBe(1); // cancellation spent zero additional rediscoveries
  }, 15_000);

  test('retries exhausted BEFORE the consumer calls next(): the stored terminal error still rejects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-reconnect-late-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpoint = endpointFor(root, 5);
    const serverA = server(endpoint, 5, () => undefined);
    await serverA.listen();

    let attempts = 0;
    const gateway = new BrokerGateway(
      {
        clientId: 'late-client',
        connect: async () => new IpcClient({ endpoint, token: 'token', epoch: 5, clientId: 'late-client' }),
        rediscover: async () => { attempts += 1; throw new Error('gone'); },
      },
      { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
    );
    cleanups.push(() => gateway.close());

    const subscription = await gateway.subscribe('codex', 0);
    await serverA.close();
    const deadline = Date.now() + 2_000;
    while (attempts < 2 && Date.now() < deadline) await Bun.sleep(10); // exhaust with NO waiter pending
    await Bun.sleep(50);
    let failed = false;
    try { await subscription.deliveries[Symbol.asyncIterator]().next(); } catch { failed = true; }
    expect(failed).toBeTrue(); // error was stored, not silently swallowed as done
    await subscription.close();
  }, 15_000);

  test('failed attach is transactional: every failed retry closes its socket (no connection/listener leak)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-reconnect-leak-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpointA = endpointFor(root, 6);
    const endpointB = endpointFor(root, 7);
    const serverA = server(endpointA, 6, () => undefined);
    await serverA.listen();

    // Broken replacement broker: connections accepted, subscribe always
    // rejected — every attach attempt fails AFTER connecting.
    const opens: string[] = [];
    const closes: string[] = [];
    const serverB = new IpcServer({
      endpoint: endpointB, token: 'token', epoch: 7,
      handler: async (frame) => ({ reqId: (frame as { reqId: string }).reqId, ok: false, error: { code: 'broker-stopping', message: 'draining' } }),
      onConnection: (id, event) => void (event === 'open' ? opens.push(id) : closes.push(id)),
    });
    await serverB.listen();
    cleanups.push(() => serverB.close().catch(() => undefined));

    const gateway = new BrokerGateway(
      {
        clientId: 'leak-client',
        connect: async () => new IpcClient({ endpoint: endpointA, token: 'token', epoch: 6, clientId: 'leak-client' }),
        rediscover: async () => new IpcClient({ endpoint: endpointB, token: 'token', epoch: 7, clientId: 'leak-client' }),
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10 },
    );
    cleanups.push(() => gateway.close());

    const subscription = await gateway.subscribe('codex', 0);
    const next = subscription.deliveries[Symbol.asyncIterator]().next();
    await serverA.close();
    let failed = false;
    try { await next; } catch { failed = true; }
    expect(failed).toBeTrue();
    const deadline = Date.now() + 2_000;
    while (closes.length < opens.length && Date.now() < deadline) await Bun.sleep(10);
    expect(opens.length).toBe(3); // one connection per attempt
    expect(closes.length).toBe(opens.length); // and every one was closed — nothing leaked
    await subscription.close();
  }, 15_000);

  test('drop during the INITIAL handshake: subscribe() rejects with zero orphan reconnect work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-reconnect-initdrop-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpoint = endpointFor(root, 8);
    // Raw server: accepts, then destroys — the handshake can never complete.
    const dropper = createServer((socket) => { setTimeout(() => socket.destroy(), 20); });
    await new Promise<void>((resolve, reject) => { dropper.once('error', reject); dropper.listen(endpoint, resolve); });
    cleanups.push(() => new Promise<void>((resolve) => dropper.close(() => resolve())));

    let rediscoveries = 0;
    const gateway = new BrokerGateway(
      {
        clientId: 'initdrop-client',
        connect: async () => { const c = new IpcClient({ endpoint, token: 'token', epoch: 8, clientId: 'initdrop-client' }); await c.connect(); return c; },
        rediscover: async () => { rediscoveries += 1; throw new Error('must not be called'); },
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10 },
    );
    cleanups.push(() => gateway.close());

    let failed = false;
    try { await gateway.subscribe('codex', 0); } catch { failed = true; }
    expect(failed).toBeTrue(); // the caller learns immediately
    await Bun.sleep(150);
    expect(rediscoveries).toBe(0); // no background retries were orphaned
  }, 15_000);

  test('D2: ack across a broker restart rediscovers — never redials the dead endpoint, delivery closes on the new broker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-reconnect-ack-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpointA = endpointFor(root, 11);
    const endpointB = endpointFor(root, 12);

    // Broker A delivers m7 then dies before the ack arrives.
    const serverA = server(endpointA, 11, async (_frame, send) => {
      await send({ kind: 'delivery', deliverySeq: 7, deliveryId: 'm7:codex', message: message('m7') });
    });
    await serverA.listen();

    // Broker B (post-restart): records acks; redelivers m7 on subscribe
    // (open/unacked-beats-cursor), exactly like a real recovered journal.
    const acksB: string[] = [];
    const serverB = new IpcServer({
      endpoint: endpointB, token: 'token', epoch: 12,
      handler: async (frame, connection) => {
        if (frame.kind === 'subscribe') void connection.send({ kind: 'delivery', deliverySeq: 7, deliveryId: 'm7:codex', message: message('m7') } as Parameters<typeof connection.send>[0]);
        if (frame.kind === 'ack') acksB.push(frame.deliveryId);
        return { reqId: (frame as { reqId: string }).reqId, ok: true };
      },
    });
    cleanups.push(() => serverB.close().catch(() => undefined));

    // Deterministic ordering (codex review #1): rediscovery is GATED, so the
    // onClose reconnect cannot swap `client` to B before the ack runs — the
    // ack's first attempt is GUARANTEED to hit the dead A client, and only
    // its failure path (await reconnecting) can proceed once we release the
    // gate. Without withReconnectRetry this test fails: the first attempt's
    // redial error escapes instead of riding the reconnect.
    let rediscoverReached = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const gateway = new BrokerGateway(
      {
        clientId: 'ack-client',
        connect: async () => new IpcClient({ endpoint: endpointA, token: 'token', epoch: 11, clientId: 'ack-client' }),
        rediscover: async () => {
          rediscoverReached = true;
          await gate; // held until the ack has begun (and failed) on A
          await serverB.listen().catch(() => undefined); // respawned at the new epoch
          return new IpcClient({ endpoint: endpointB, token: 'token', epoch: 12, clientId: 'ack-client' });
        },
      },
      { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 40 },
    );
    cleanups.push(() => gateway.close());

    const subscription = await gateway.subscribe('codex', 0);
    const first = (await subscription.deliveries[Symbol.asyncIterator]().next()).value!;
    expect(first.deliveryId).toBe('m7:codex');

    await serverA.close(); // broker dies between print and ack (the bekf8jfk7 shape)
    const deadline = Date.now() + 2_000;
    while (!rediscoverReached && Date.now() < deadline) await Bun.sleep(5);
    expect(rediscoverReached).toBeTrue(); // reconnect is parked at the gate; `client` is still the dead A client

    const acking = subscription.ack('m7:codex'); // first attempt hits dead A, must ride the reconnect
    await Bun.sleep(25); // give the doomed first attempt time to fail while the gate holds
    expect(acksB).toEqual([]); // nothing can have landed yet — B is not even listening
    releaseGate();
    await acking;
    expect(acksB).toEqual(['m7:codex']);
    await subscription.close();
  }, 15_000);

  test('D2: reconnect exhaustion surfaces the terminal error — the ack retry never redials a stale client', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-reconnect-ack-exhaust-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpoint = endpointFor(root, 13);
    const serverA = server(endpoint, 13, async (_frame, send) => {
      await send({ kind: 'delivery', deliverySeq: 8, deliveryId: 'm8:codex', message: message('m8') });
    });
    await serverA.listen();

    const gateway = new BrokerGateway(
      {
        clientId: 'exhaust-client',
        connect: async () => new IpcClient({ endpoint, token: 'token', epoch: 13, clientId: 'exhaust-client' }),
        rediscover: async () => { throw new Error('broker gone for good'); },
      },
      { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 10 },
    );
    cleanups.push(() => gateway.close());

    const subscription = await gateway.subscribe('codex', 0);
    const first = (await subscription.deliveries[Symbol.asyncIterator]().next()).value!;
    expect(first.deliveryId).toBe('m8:codex');
    await serverA.close();

    let caught: Error | undefined;
    try { await subscription.ack('m8:codex'); } catch (error) { caught = error as Error; }
    // Pre-review-fix this surfaced a raw redial failure from the stale
    // client; the terminal reconnect error is the honest outcome.
    expect(caught?.message).toBe('broker gone for good');
    await subscription.close();
  }, 15_000);

  test('D2: ack after close() fails fast — no reconnect, no rediscovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-reconnect-ack-closed-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpoint = endpointFor(root, 14);
    const serverA = server(endpoint, 14, async (_frame, send) => {
      await send({ kind: 'delivery', deliverySeq: 9, deliveryId: 'm9:codex', message: message('m9') });
    });
    await serverA.listen();

    let rediscoveries = 0;
    const gateway = new BrokerGateway(
      {
        clientId: 'closed-client',
        connect: async () => new IpcClient({ endpoint, token: 'token', epoch: 14, clientId: 'closed-client' }),
        rediscover: async () => { rediscoveries += 1; throw new Error('must not be called'); },
      },
      { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 10 },
    );
    cleanups.push(() => gateway.close());

    const subscription = await gateway.subscribe('codex', 0);
    const first = (await subscription.deliveries[Symbol.asyncIterator]().next()).value!;
    expect(first.deliveryId).toBe('m9:codex');

    await subscription.close();
    await serverA.close(); // transport now dead AND subscription closed
    let failed = false;
    try { await subscription.ack('m9:codex'); } catch { failed = true; }
    expect(failed).toBeTrue();
    await Bun.sleep(50);
    expect(rediscoveries).toBe(0); // post-close: surface the failure, never reconnect
  }, 15_000);

  test('close() during a reconnect handshake: nothing is published and the replacement socket is closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-reconnect-midhs-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpointA = endpointFor(root, 9);
    const endpointB = endpointFor(root, 10);
    const serverA = server(endpointA, 9, () => undefined);
    await serverA.listen();

    const opens: string[] = [];
    const closes: string[] = [];
    const serverB = new IpcServer({
      endpoint: endpointB, token: 'token', epoch: 10,
      handler: async (frame) => {
        if (frame.kind === 'subscribe') await Bun.sleep(300); // slow handshake
        return { reqId: (frame as { reqId: string }).reqId, ok: true };
      },
      onConnection: (id, event) => void (event === 'open' ? opens.push(id) : closes.push(id)),
    });
    await serverB.listen();
    cleanups.push(() => serverB.close().catch(() => undefined));

    const gateway = new BrokerGateway(
      {
        clientId: 'midhs-client',
        connect: async () => new IpcClient({ endpoint: endpointA, token: 'token', epoch: 9, clientId: 'midhs-client' }),
        rediscover: async () => new IpcClient({ endpoint: endpointB, token: 'token', epoch: 10, clientId: 'midhs-client' }),
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10 },
    );
    cleanups.push(() => gateway.close());

    const subscription = await gateway.subscribe('codex', 0);
    await serverA.close(); // triggers reconnect into the slow handshake
    const deadline = Date.now() + 2_000;
    while (opens.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(opens.length).toBe(1); // handshake with the replacement in flight
    const started = Date.now();
    await subscription.close(); // cancel mid-handshake
    expect(Date.now() - started).toBeLessThan(1_000);
    const closeDeadline = Date.now() + 2_000;
    while (closes.length < 1 && Date.now() < closeDeadline) await Bun.sleep(10);
    expect(closes.length).toBe(1); // replacement socket closed, not published
  }, 15_000);
});
