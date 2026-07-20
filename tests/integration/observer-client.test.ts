import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IpcClient, IpcServer, endpointFor } from '@adapters/ipc/index.ts';
import type { ObserverPush, ObserverSnapshotDto } from '@app/ports/gateway.ts';
import { BrokerGateway } from '../../src/apps/cli/brokerGateway.ts';

/** Wire-level observer contract: observe carries NO agent identity, the
 * snapshot is the response, and activity/presence pushes stream in order
 * through the gateway's ObserverSession without touching delivery paths. */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const session = { task: 'observed', agents: ['claude', 'codex'], driver: 'claude', turn: 'codex', status: 'active', started: '2026-07-14 18:00:00', grants: {} } as const;

const snapshot: ObserverSnapshotDto = {
  seq: 7,
  session,
  transcript: [],
  liveness: { broker: { pid: 1, epoch: 4, heartbeatAt: '2026-07-14 18:00:10' }, agents: {} },
  broker: { pid: 1, epoch: 4, endpoint: 'e', heartbeatAt: '2026-07-14 18:00:10' },
};

describe('observer gateway (wire)', () => {
  test('observe returns the snapshot and streams pushes; frame carries no agent identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-observe-wire-'));
    const endpoint = endpointFor(root, 4);
    const framesSeen: Record<string, unknown>[] = [];
    const server = new IpcServer({
      endpoint, token: 'token', epoch: 4,
      handler: async (frame, connection) => {
        framesSeen.push(frame as unknown as Record<string, unknown>);
        if (frame.kind === 'observe') {
          const respond = async () => {
            await connection.send({ kind: 'activity', seq: 8, at: 't', principal: 'claude', events: [], session: { ...session, turn: 'claude' }, ackedDeliveryIds: ['m:codex'], voidedDeliveryIds: [] });
            await connection.send({ kind: 'presence', liveness: { agents: { codex: { connectedSince: 'now' } } } });
          };
          setTimeout(() => void respond(), 20);
          return { reqId: frame.reqId, ok: true, data: snapshot };
        }
        return { reqId: frame.reqId, ok: true };
      },
    });
    await server.listen();
    cleanups.push(() => server.close(), () => rm(root, { recursive: true, force: true }));
    const gateway = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'token', epoch: 4, clientId: 'watch-1' }));
    cleanups.push(() => gateway.close());

    const observed = await gateway.observe(false);
    expect(observed.snapshot.seq).toBe(7);
    expect(observed.snapshot.broker.epoch).toBe(4);
    const observeFrame = framesSeen.find((f) => f['kind'] === 'observe')!;
    expect(observeFrame['as']).toBeUndefined(); // an observer is not a participant

    const iterator = observed.pushes[Symbol.asyncIterator]();
    const first = (await iterator.next()).value as ObserverPush;
    expect(first.kind).toBe('activity');
    if (first.kind === 'activity') { expect(first.seq).toBe(8); expect(first.ackedDeliveryIds).toEqual(['m:codex']); expect(first.session.turn).toBe('claude'); }
    const second = (await iterator.next()).value as ObserverPush;
    expect(second.kind).toBe('presence');
    await observed.close();
    expect((await iterator.next()).done).toBeTrue();
  });

  test('connection loss fails the push stream so watch can reattach with a fresh snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-observe-drop-'));
    const endpoint = endpointFor(root, 9);
    const server = new IpcServer({
      endpoint, token: 'token', epoch: 9,
      handler: async (frame) => (frame.kind === 'observe' ? { reqId: frame.reqId, ok: true, data: snapshot } : { reqId: frame.reqId, ok: true }),
    });
    await server.listen();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const gateway = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'token', epoch: 9, clientId: 'watch-2' }));
    cleanups.push(() => gateway.close());

    const observed = await gateway.observe(false);
    const next = observed.pushes[Symbol.asyncIterator]().next();
    await server.close(); // broker stop/crash
    // Manual catch: bun's expect(...).rejects wedges on this late-rejecting
    // promise under the test runner (verified in isolation).
    let failed = false;
    try { await next; } catch { failed = true; }
    expect(failed).toBeTrue(); // stream fails → caller reattaches
    await observed.close();
  });

  test('userAttach handshake drop: rejects without retry, and a caller-rebuilt session gets a clean unpoisoned queue (close-out #6)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-uattach-drop-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const dropEndpoint = endpointFor(root, 11);
    // Raw dropper: accepts, then destroys mid-handshake — the user-attach
    // response can never arrive. IpcClient.userAttach must reject (it has
    // NO internal retry by contract — a retry on a fresh socket would
    // poison the already-armed push queue).
    const { createServer } = await import('node:net');
    const dropper = createServer((socket) => { setTimeout(() => socket.destroy(), 20); });
    await new Promise<void>((resolve, reject) => { dropper.once('error', reject); dropper.listen(dropEndpoint, resolve); });
    cleanups.push(() => new Promise<void>((resolve) => dropper.close(() => resolve())));

    const dropClient = new IpcClient({ endpoint: dropEndpoint, token: 'token', epoch: 11, clientId: 'ua-1' });
    await dropClient.connect();
    const droppedGateway = BrokerGateway.forClient(dropClient);
    let failed = false;
    try { await droppedGateway.userAttach('u'.repeat(64), false); } catch { failed = true; }
    expect(failed).toBeTrue(); // the CALLER learns; nothing armed in the background
    await droppedGateway.close();

    // Caller rebuild (the designed recovery): a fresh session against a good
    // broker attaches cleanly and its queue serves live pushes — no residue
    // from the failed attempt.
    const goodEndpoint = endpointFor(root, 12);
    const server = new IpcServer({
      endpoint: goodEndpoint, token: 'token', epoch: 12,
      handler: async (frame, connection) => {
        if (frame.kind === 'user-attach') {
          setTimeout(() => void connection.send({ kind: 'presence', liveness: { agents: {} } } as Parameters<typeof connection.send>[0]), 10);
          return { reqId: frame.reqId, ok: true, data: { ...snapshot, userChannel: { registered: true, authenticated: true } } };
        }
        return { reqId: frame.reqId, ok: true };
      },
    });
    await server.listen();
    cleanups.push(() => server.close().catch(() => undefined));
    const gateway = BrokerGateway.forClient(new IpcClient({ endpoint: goodEndpoint, token: 'token', epoch: 12, clientId: 'ua-1' }));
    cleanups.push(() => gateway.close());
    const attached = await gateway.userAttach('u'.repeat(64), false);
    const first = (await attached.pushes[Symbol.asyncIterator]().next()).value;
    expect(first?.kind).toBe('presence'); // clean queue, live stream
    await attached.close();
  });

  test('userAttach close-race: a connection dying right after the handshake fails the push stream — it never hangs (close-out #6)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-uattach-race-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpoint = endpointFor(root, 13);
    const server: IpcServer = new IpcServer({
      endpoint, token: 'token', epoch: 13,
      handler: async (frame) => {
        if (frame.kind === 'user-attach') {
          // Respond, then tear the connection down immediately — racing the
          // client's close-semantics arming. Whichever side of the race the
          // runtime lands on (onClose listener or the connected guard), the
          // outcome contract is the same: the stream FAILS, never hangs.
          setTimeout(() => void server.close(), 5);
          return { reqId: frame.reqId, ok: true, data: { ...snapshot, userChannel: { registered: true, authenticated: true } } };
        }
        return { reqId: frame.reqId, ok: true };
      },
    });
    await server.listen();
    const gateway = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'token', epoch: 13, clientId: 'ua-2' }));
    cleanups.push(() => gateway.close());

    const attached = await gateway.userAttach('u'.repeat(64), false);
    const next = attached.pushes[Symbol.asyncIterator]().next();
    let failed = false;
    try { await next; } catch { failed = true; }
    expect(failed).toBeTrue(); // loud failure → the host reattaches; a silent hang would strand the pane
    await attached.close();
  });
});
