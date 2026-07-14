import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IpcClient, IpcServer, endpointFor, type DeliveryFrame } from './index.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function pair() {
  const root = await mkdtemp(join(tmpdir(), 'claudex-ipc-')); const endpoint = endpointFor(root, 7);
  const server = new IpcServer({ endpoint, token: 'secret', epoch: 7, handler: async (frame, connection) => {
    if (frame.kind === 'execute') return { reqId: frame.reqId, ok: true, seq: 9, events: [frame.envelope] };
    if (frame.kind === 'subscribe') { await connection.send({ kind: 'delivery', deliverySeq: 3, deliveryId: 'm:codex', message: 'hello' }); return { reqId: frame.reqId, ok: true }; }
  }});
  await server.listen(); cleanups.push(() => server.close(), () => rm(root, { recursive: true, force: true }));
  return { endpoint, server };
}

describe('NDJSON IPC transport', () => {
  test('frames requests and pushes subscriptions over a loopback pair', async () => {
    const { endpoint } = await pair(); const client = new IpcClient({ endpoint, token: 'secret', epoch: 7, clientId: 'c1' }); cleanups.push(() => client.close());
    expect(await client.execute('codex', { command: 'x' }, 'r1')).toEqual({ reqId: 'r1', ok: true, seq: 9, events: [{ command: 'x' }] });
    const delivery = new Promise<DeliveryFrame>((resolve) => client.onDelivery(resolve));
    await client.subscribe('codex'); expect(await delivery).toMatchObject({ deliverySeq: 3, deliveryId: 'm:codex', message: 'hello' });
  });

  test('rejects wrong token before handler dispatch', async () => {
    const { endpoint } = await pair(); const client = new IpcClient({ endpoint, token: 'wrong', epoch: 7, retryCount: 0 }); cleanups.push(() => client.close());
    expect(await client.execute('codex', {}, 'bad-token')).toMatchObject({ reqId: 'bad-token', ok: false, error: { code: 'unauthorized' } });
  });

  test('rejects stale epochs', async () => {
    const { endpoint } = await pair(); const client = new IpcClient({ endpoint, token: 'secret', epoch: 6, retryCount: 0 }); cleanups.push(() => client.close());
    expect(await client.query('status', 'stale')).toMatchObject({ reqId: 'stale', ok: false, error: { code: 'stale-epoch' } });
  });

  test.skipIf(process.platform === 'win32')('F13 unlinks a stale Unix socket and binds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-stale-')); const endpoint = endpointFor(root, 2); await writeFile(endpoint, 'stale');
    const server = new IpcServer({ endpoint, token: 't', epoch: 2, handler: () => undefined });
    await server.listen(); cleanups.push(() => server.close(), () => rm(root, { recursive: true, force: true }));
    const client = new IpcClient({ endpoint, token: 't', epoch: 2 }); cleanups.push(() => client.close()); await client.connect();
  });
});
