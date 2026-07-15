import { afterEach, describe, expect, test } from 'bun:test';
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

  test('close() during reconnect cancels cleanly', async () => {
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
      { maxAttempts: 100, baseDelayMs: 30, maxDelayMs: 30 },
    );
    cleanups.push(() => gateway.close());

    const subscription = await gateway.subscribe('codex', 0);
    await serverA.close();
    await Bun.sleep(50); // let a reconnect cycle start
    await subscription.close(); // must cancel the in-progress reconnect
    const settled = attempts;
    await Bun.sleep(120);
    expect(attempts - settled).toBeLessThanOrEqual(1); // no further retry churn after close
  }, 15_000);
});
