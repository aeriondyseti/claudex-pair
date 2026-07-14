import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IpcClient, IpcServer, endpointFor } from '@adapters/ipc/index.ts';
import type { Delivery, DeliverySubscription, ExecuteOutcome, StatusDto } from '@app/ports/gateway.ts';
import { BrokerGateway } from '../../src/apps/cli/brokerGateway.ts';
import { BrokerDiscovery } from '../../src/apps/cli/brokerDiscovery.ts';
import { printDeliveryThenAck } from '../../src/apps/cli/brokerWait.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const session = { task: 'broker client', agents: ['claude', 'codex'], driver: 'claude', turn: 'codex', status: 'active', started: '2026-07-14 17:00:00', grants: {} } as const;
const status: StatusDto = { session, navigators: ['codex'], openGrants: [], pending: { claude: [], codex: [] }, recent: [] };
const message = { name: 'm-codex.md', header: { id: 'm', from: 'claude', to: 'codex', type: 'ask', turn: 'pass', sent: '2026-07-14 17:00:00' }, body: 'review', raw: '---\nid: m\n---\n\nreview' };

describe('broker client gateway', () => {
  test('maps typed execute/query/subscribe and waits for durable ack responses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-client-')); const endpoint = endpointFor(root, 3); const seen: string[] = [];
    const server = new IpcServer({ endpoint, token: 'token', epoch: 3, handler: async (frame, connection) => {
      seen.push(frame.kind);
      if (frame.kind === 'execute') return { reqId: frame.reqId, ok: true, data: { seq: 4, events: [], receipt: { messageFiles: ['m.md'] }, session } satisfies ExecuteOutcome };
      if (frame.kind === 'query') return { reqId: frame.reqId, ok: true, data: frame.what === 'status' ? status : frame.what === 'grants' || frame.what === 'log' ? [] : { running: true, pid: 1, epoch: 3 } };
      if (frame.kind === 'subscribe') { await connection.send({ kind: 'delivery', deliverySeq: 8, deliveryId: 'm:codex', message }); return { reqId: frame.reqId, ok: true }; }
      return { reqId: frame.reqId, ok: true };
    }});
    await server.listen(); cleanups.push(() => server.close(), () => rm(root, { recursive: true, force: true }));
    const client = new IpcClient({ endpoint, token: 'token', epoch: 3, clientId: 'client-1' }); const gateway = BrokerGateway.forClient(client); cleanups.push(() => gateway.close());

    const outcome = await gateway.execute({ as: 'codex', command: { kind: 'end-session', summary: 'done' }, identity: { clientId: 'client-1', reqId: 'req-1' } });
    expect(outcome.seq).toBe(4); expect((await gateway.status()).session.turn).toBe('codex'); expect(await gateway.grants()).toEqual([]);
    const subscription = await gateway.subscribe('codex', 0); const delivery = await subscription.deliveries[Symbol.asyncIterator]().next();
    expect(delivery.value?.deliveryId).toBe('m:codex'); await subscription.ack('m:codex'); await subscription.extend('m:codex');
    expect(seen).toEqual(['execute', 'query', 'query', 'subscribe', 'ack', 'extend']);
  });

  test('F14 writes and flushes the complete delivery before ack', async () => {
    const order: string[] = [];
    const delivery: Delivery = { deliverySeq: 1, deliveryId: 'm:codex', message };
    const subscription: DeliverySubscription = {
      deliveries: { async *[Symbol.asyncIterator]() { yield delivery; } },
      ack: async () => { order.push('ack'); }, extend: async () => {}, close: async () => {},
    };
    await printDeliveryThenAck(delivery, subscription, async (text) => { expect(text).toContain('INCOMING m-codex.md'); expect(text).toContain('review'); order.push('flush'); });
    expect(order).toEqual(['flush', 'ack']);
  });

  test('blocked subscription re-discovers and replays after broker connection closes', async () => {
    const root1 = await mkdtemp(join(tmpdir(), 'claudex-reconnect-a-')); const root2 = await mkdtemp(join(tmpdir(), 'claudex-reconnect-b-'));
    const endpoint1 = endpointFor(root1, 1); const endpoint2 = endpointFor(root2, 2);
    const server1 = new IpcServer({ endpoint: endpoint1, token: 'a', epoch: 1, handler: (frame) => 'reqId' in frame ? { reqId: frame.reqId, ok: true } : undefined });
    const server2 = new IpcServer({ endpoint: endpoint2, token: 'b', epoch: 2, handler: async (frame, connection) => {
      if (frame.kind === 'subscribe') { await connection.send({ kind: 'delivery', deliverySeq: 9, deliveryId: 'm:codex', message }); return { reqId: frame.reqId, ok: true }; }
      return 'reqId' in frame ? { reqId: frame.reqId, ok: true } : undefined;
    }});
    await server1.listen(); await server2.listen(); cleanups.push(() => server2.close(), () => rm(root1, { recursive: true, force: true }), () => rm(root2, { recursive: true, force: true }));
    const client1 = new IpcClient({ endpoint: endpoint1, token: 'a', epoch: 1, clientId: 'stable' });
    const client2 = new IpcClient({ endpoint: endpoint2, token: 'b', epoch: 2, clientId: 'stable' });
    const gateway = new BrokerGateway({ clientId: 'stable', connect: async () => client1, rediscover: async () => client2 }); cleanups.push(() => gateway.close());
    const subscription = await gateway.subscribe('codex', 0); const next = subscription.deliveries[Symbol.asyncIterator]().next();
    await server1.close();
    expect((await next).value?.deliverySeq).toBe(9);
    await subscription.close();
  });

  test('spawn-on-demand waits for lease, token, and broker ping readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-spawn-')); const endpoint = endpointFor(root, 4); let server: IpcServer | undefined; let spawns = 0;
    const discovery = new BrokerDiscovery({ root, clientId: 'spawn-client', readinessMs: 2_000, spawn: async () => {
      spawns++;
      server = new IpcServer({ endpoint, token: 'spawn-token', epoch: 4, handler: (frame) => frame.kind === 'query' ? { reqId: frame.reqId, ok: true, data: { running: true, epoch: 4 } } : undefined });
      await server.listen(); await mkdir(join(root, '.pair'), { recursive: true });
      await writeFile(join(root, '.pair', 'broker.token'), 'spawn-token');
      await writeFile(join(root, '.pair', 'broker.lease'), JSON.stringify({ pid: process.pid, processStartTime: 'now', nonce: 'n', epoch: 4, endpoint, heartbeatAt: 'now' }));
    }});
    cleanups.push(async () => { await server?.close(); await rm(root, { recursive: true, force: true }); });
    const client = await discovery.connect(); cleanups.push(() => client.close());
    expect(spawns).toBe(1); expect((await client.query('broker-status')).ok).toBeTrue();
  });
});
