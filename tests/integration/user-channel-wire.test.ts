import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { systemClock, systemIds } from '@adapters/clock/index.ts';
import { FsMirrors, fsMessageCodec } from '@adapters/fs/brokerMirrors.ts';
import { IpcClient, IpcServer, endpointFor } from '@adapters/ipc/index.ts';
import type { ClientFrame, ServerConnection, ServerFrame } from '@adapters/ipc/types.ts';
import type { Delivery } from '@app/ports/gateway.ts';
import type { DeliverySink, ObserverSink } from '@broker/ports.ts';
import { BrokerCore, DEFAULT_CONFIG } from '@broker/server.ts';
import { BrokerGateway } from '../../src/apps/cli/brokerGateway.ts';

/**
 * Design §7 REAL-WIRE broadcast wake (codex round-2 requirement): the full
 * in-process stack — real BrokerCore behind a real IpcServer, real IpcClient
 * gateways — proving frame routing, connection-bound auth, one-txn fan-out,
 * both subscriber deliveries waking, and turn:keep composition. The core and
 * fake-host halves each pin their own layer; this pins the composition.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function asSink(connection: ServerConnection): DeliverySink {
  return {
    id: connection.id,
    sendDelivery: (push) => connection.send(push as ServerFrame),
    sendError: (code, message) => connection.send({ ok: false, error: { code, message } }),
  };
}
function asObserverSink(connection: ServerConnection): ObserverSink {
  return { id: connection.id, sendObserver: (push) => connection.send(push as ServerFrame) };
}

describe('user-channel over the real wire', () => {
  test('broadcast wake: user-attach binds the connection, user-send * fans out ONE txn that wakes both waiting subscribers, turn unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-uwire-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.pair'), { recursive: true });
    const endpoint = endpointFor(root, 21);
    const core = new BrokerCore(
      join(root, '.pair'),
      { clock: systemClock, ids: systemIds, mirrors: new FsMirrors(root), codec: fsMessageCodec },
      DEFAULT_CONFIG,
      { onStopped: () => undefined, pid: process.pid, epoch: 21, endpoint, heartbeatAt: () => systemClock.now() },
    );
    await core.recover();

    // Production wiring verbatim (apps/broker/main.ts handler shape).
    const server = new IpcServer({
      endpoint, token: 'tok', epoch: 21,
      handler: async (frame: ClientFrame, connection: ServerConnection): Promise<ServerFrame | void> => {
        switch (frame.kind) {
          case 'execute': return (await core.execute(frame.reqId, frame.clientId, frame.as, frame.envelope)) as ServerFrame;
          case 'query': return (await core.query(frame.reqId, frame.what, frame.args)) as ServerFrame;
          case 'subscribe': return (await core.subscribe(frame.reqId, asSink(connection), frame.as, frame.afterDeliverySeq)) as ServerFrame;
          case 'observe': return (await core.observe(frame.reqId, asObserverSink(connection))) as ServerFrame;
          case 'user-attach': return (await core.userAttach(frame.reqId, asObserverSink(connection), frame.clientId, frame.userToken)) as ServerFrame;
          case 'user-send': return (await core.userSend(frame.reqId, frame.clientId, connection.id, frame.to, frame.body)) as ServerFrame;
          case 'user-action': return (await core.userAction(frame.reqId, frame.clientId, connection.id, frame.action)) as ServerFrame;
          case 'ack': return (await core.ack(frame.reqId, frame.deliveryId, frame.clientId)) as ServerFrame;
          case 'extend': return core.extend(frame.reqId, frame.deliveryId) as ServerFrame;
        }
      },
      onConnection: (id, event) => core.onConnection(id, event),
    });
    await server.listen();
    cleanups.push(() => server.close().catch(() => undefined));

    const gatewayFor = (clientId: string) => {
      const gateway = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'tok', epoch: 21, clientId }));
      cleanups.push(() => gateway.close());
      return gateway;
    };

    // Session init over the wire.
    const claudeGw = gatewayFor('cli-claude');
    await claudeGw.execute({
      as: 'claude',
      command: { kind: 'init-session', task: 'wire broadcast', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t-0001' },
      identity: { clientId: 'cli-claude', reqId: 'init-1' },
    });

    // Two agents WAITING on real wire subscriptions.
    const claudeSub = await claudeGw.subscribe('claude', 0);
    const claudeSeen: { actionKind?: string; groupId?: string }[] = [];
    void (async () => {
      for await (const d of claudeSub.deliveries) {
        claudeSeen.push(d.message.header as { actionKind?: string; groupId?: string });
        await claudeSub.ack(d.deliveryId);
      }
    })().catch(() => undefined);
    const codexGw = gatewayFor('cli-codex');
    const codexSub = await codexGw.subscribe('codex', 0);

    // The user attaches on its own connection (TOFU over the wire).
    const userGw = gatewayFor('cli-user');
    const userSession = await userGw.userAttach('a'.repeat(64), false);
    expect(userSession.snapshot.userChannel).toEqual({ registered: true, authenticated: true });

    // Broadcast; consume each subscriber's stream until it arrives (the TOFU
    // registration notice precedes it — ack everything on the way).
    await userSession.send('req-42', '*', 'all hands: ship it');
    const broadcastFor = async (sub: { deliveries: AsyncIterable<Delivery>; ack: (id: string) => Promise<void> }): Promise<Delivery> => {
      for await (const delivery of sub.deliveries) {
        await sub.ack(delivery.deliveryId);
        if (delivery.message.body === 'all hands: ship it') return delivery;
      }
      throw new Error('broadcast never arrived');
    };
    const [toClaude, toCodex] = await Promise.all([broadcastFor(claudeSub), broadcastFor(codexSub)]);

    // Both woke via real delivery frames; provenance + groupId projected.
    const headers = [toClaude, toCodex].map((d) => d.message.header as typeof toClaude.message.header & { groupId?: string; provenance?: string });
    for (const header of headers) {
      expect(header.from).toBe('user');
      expect(header.groupId).toBe('req-42');
      expect(header.provenance).toBe('trusted_user_client');
      expect(header.turn).toBe('keep');
    }
    // ONE txn fan-out: per-recipient ids share base and seq, differ by index.
    const stem = (id: string) => id.replace(/-r\d+$/, '');
    expect(headers[0]!.id).not.toBe(headers[1]!.id);
    expect(stem(headers[0]!.id)).toBe(stem(headers[1]!.id));

    // turn:keep composition: the session turn is untouched by the broadcast.
    const status = await claudeGw.status();
    expect(status.session.turn).toBe('claude');

    // Connection-bound auth over the wire: an agent connection that never
    // user-attached cannot user-send, token or not.
    const forgedClient = new IpcClient({ endpoint, token: 'tok', epoch: 21, clientId: 'cli-claude' });
    cleanups.push(() => forgedClient.close());
    const forged = await forgedClient.userSend('codex', 'forged', 'req-99');
    expect(forged.ok).toBeFalse();
    if (!forged.ok) expect(forged.error.code).toBe('user-channel-required');

    await claudeSub.close();
    await codexSub.close();
    await userSession.close();
  }, 15_000);
});

/** Shared harness for the step-7 proofs: real core + server + wiring, with
 * an optional drop-response-once set (simulates response loss at the wire
 * WITHOUT racing socket teardown). */
async function harness(epoch: number, dropResponseOnce: Set<string> = new Set()) {
  const root = await mkdtemp(join(tmpdir(), `claudex-uwire-${epoch}-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.pair'), { recursive: true });
  const endpoint = endpointFor(root, epoch);
  const core = new BrokerCore(
    join(root, '.pair'),
    { clock: systemClock, ids: systemIds, mirrors: new FsMirrors(root), codec: fsMessageCodec },
    DEFAULT_CONFIG,
    { onStopped: () => undefined, pid: process.pid, epoch, endpoint, heartbeatAt: () => systemClock.now() },
  );
  await core.recover();
  const server = new IpcServer({
    endpoint, token: 'tok', epoch,
    handler: async (frame: ClientFrame, connection: ServerConnection): Promise<ServerFrame | void> => {
      switch (frame.kind) {
        case 'execute': return (await core.execute(frame.reqId, frame.clientId, frame.as, frame.envelope)) as ServerFrame;
        case 'query': return (await core.query(frame.reqId, frame.what, frame.args)) as ServerFrame;
        case 'subscribe': return (await core.subscribe(frame.reqId, asSink(connection), frame.as, frame.afterDeliverySeq)) as ServerFrame;
        case 'observe': return (await core.observe(frame.reqId, asObserverSink(connection))) as ServerFrame;
        case 'user-attach': return (await core.userAttach(frame.reqId, asObserverSink(connection), frame.clientId, frame.userToken)) as ServerFrame;
        case 'user-send': return (await core.userSend(frame.reqId, frame.clientId, connection.id, frame.to, frame.body)) as ServerFrame;
        case 'user-action': {
          const response = (await core.userAction(frame.reqId, frame.clientId, connection.id, frame.action)) as ServerFrame;
          if (dropResponseOnce.delete(frame.reqId)) return; // committed; response LOST
          return response;
        }
        case 'ack': return (await core.ack(frame.reqId, frame.deliveryId, frame.clientId)) as ServerFrame;
        case 'extend': return core.extend(frame.reqId, frame.deliveryId) as ServerFrame;
      }
    },
    onConnection: (id, event) => core.onConnection(id, event),
  });
  await server.listen();
  cleanups.push(() => server.close().catch(() => undefined));
  const clientFor = (clientId: string) => {
    const client = new IpcClient({ endpoint, token: 'tok', epoch, clientId });
    cleanups.push(() => client.close());
    return client;
  };
  return { root, endpoint, core, clientFor };
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await cond()) && Date.now() < deadline) await Bun.sleep(15);
  expect(await cond()).toBeTrue();
};

describe('slice-4a step 7: real-wire proofs', () => {
  test('F-A8 user kick, two-subscription topology: journal+MIRROR voiding, observer voidedDeliveryIds, terminal wake + reconnect suppression, survivor notice', async () => {
    const { root, clientFor } = await harness(22);
    const gatewayCounting = (clientId: string, counter: { n: number }) => {
      const client = clientFor(clientId);
      const gateway = new BrokerGateway({ clientId, connect: async () => client, rediscover: async () => { counter.n += 1; return client; } });
      cleanups.push(() => gateway.close());
      return gateway;
    };
    const claudeGw = gatewayCounting('cli-claude', { n: 0 });
    await claudeGw.execute({ as: 'claude', command: { kind: 'init-session', task: 'FA8', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t-0001' }, identity: { clientId: 'cli-claude', reqId: 'init-1' } });
    const seeded = await claudeGw.execute({ as: 'claude', command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'seed' }, identity: { clientId: 'cli-claude', reqId: 'seed-1' } });
    const seededFile = seeded.receipt.messageFiles[0]!;
    const seededDeliveryId = `${seeded.events.find((e) => e.kind === 'message-sent')!.id}:codex`;
    await until(() => Bun.file(join(root, '.pair', 'inbox', 'codex', seededFile)).exists());

    // Subscription #1 takes the seeded delivery LEASE (never acks).
    const red1 = { n: 0 };
    const sub1 = await gatewayCounting('cli-codex-1', red1).subscribe('codex', 0);
    const leased = (await sub1.deliveries[Symbol.asyncIterator]().next()).value!;
    expect(leased.deliveryId).toBe(seededDeliveryId);
    // Subscription #2 is genuinely EMPTY-BLOCKED (the seed is leased to #1).
    const red2 = { n: 0 };
    const sub2 = await gatewayCounting('cli-codex-2', red2).subscribe('codex', 0);
    // Catch-wrapped at CREATION: the rejection lands while later awaits are
    // in flight — a bare promise would be flagged as an unhandled rejection.
    const blocked = sub2.deliveries[Symbol.asyncIterator]().next().then(() => undefined, (error: unknown) => error as { code?: string });

    // Observer armed BEFORE the kick (proof requirement: voidedDeliveryIds).
    const observed = await gatewayCounting('cli-observer', { n: 0 }).observe(false);
    const pushes: unknown[] = [];
    void (async () => { for await (const push of observed.pushes) pushes.push(push); })().catch(() => undefined);

    const claudeSub = await claudeGw.subscribe('claude', 0);
    const claudeSeen: { actionKind?: string; groupId?: string }[] = [];
    void (async () => {
      for await (const d of claudeSub.deliveries) {
        claudeSeen.push(d.message.header as { actionKind?: string; groupId?: string });
        await claudeSub.ack(d.deliveryId);
      }
    })().catch(() => undefined);

    // The user kicks codex over the REAL wire.
    const userSession = await gatewayCounting('cli-user', { n: 0 }).userAttach('a'.repeat(64), false);
    await userSession.action('kick-1', { verb: 'kick', agent: 'codex', reason: 'stuck' });

    // Terminal wake: the EMPTY-BLOCKED subscription rejects typed, no reconnect.
    const caught = await blocked;
    expect(caught?.code).toBe('removed-from-session');
    // The leaseholder ack also rejects terminally pre-wire.
    let ackCaught: { code?: string } | undefined;
    try { await sub1.ack(seededDeliveryId); } catch (error) { ackCaught = error as { code?: string }; }
    expect(ackCaught?.code).toBe('removed-from-session');
    await Bun.sleep(60);
    expect(red1.n).toBe(0); // reconnect suppressed on both
    expect(red2.n).toBe(0);

    // MIRROR voiding: the seeded file moved inbox/codex -> archive.
    await until(async () => !(await Bun.file(join(root, '.pair', 'inbox', 'codex', seededFile)).exists()));
    await until(() => Bun.file(join(root, '.pair', 'archive', seededFile)).exists());

    // Observer push for the kick txn carries the voided delivery ids.
    await until(() => pushes.some((p) => (p as { kind?: string; voidedDeliveryIds?: string[] }).kind === 'activity' && ((p as { voidedDeliveryIds?: string[] }).voidedDeliveryIds ?? []).includes(seededDeliveryId)));

    // Survivor notice with the durable actionKind reaches claude.
    await until(() => claudeSeen.some((h) => h.actionKind === 'kick' && h.groupId === 'kick-1'), 5_000);

    await sub1.close(); await sub2.close(); await claudeSub.close(); await observed.close(); await userSession.close();
  }, 20_000);

  test('F-A11 wire: committed end whose response is LOST replays the recorded outcome on a fresh authenticated connection', async () => {
    const { clientFor } = await harness(23, new Set(['end-lost']));
    const claude = clientFor('cli-claude');
    expect((await claude.execute('claude', { command: { kind: 'init-session', task: 'FA11', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t-0001' } }, 'init-1')).ok).toBeTrue();

    // Attach + fire the end whose response the wire will DROP (committed).
    const user1 = clientFor('cli-user');
    expect((await user1.userAttach('b'.repeat(64), 'att-1-x-x-x' as `${string}-${string}-${string}-${string}-${string}`)).ok).toBeTrue();
    const lost = user1.userAction({ verb: 'end', summary: 'wrap' }, 'end-lost');
    const lostRace = await Promise.race([lost.then(() => 'responded').catch(() => 'rejected'), Bun.sleep(300).then(() => 'hung')]);
    expect(lostRace).toBe('hung'); // the response never arrived — caller stranded
    user1.close(); // stranded caller gives up its socket

    // Fresh connection, SAME clientId + token: auth first, then dedup replay.
    const user2 = clientFor('cli-user');
    expect((await user2.userAttach('b'.repeat(64), 'att-2-x-x-x' as `${string}-${string}-${string}-${string}-${string}`)).ok).toBeTrue();
    const retry = await user2.userAction({ verb: 'end', summary: 'wrap' }, 'end-lost');
    expect(retry.ok).toBeTrue(); // replayed recorded outcome — never session-not-active
    if (retry.ok) {
      expect(((retry.data as { session: { status: string } }).session.status)).toBe('completed');
      expect((retry.events ?? []).some((e) => (e as { kind?: string }).kind === 'session-ended')).toBeTrue();
    }
  }, 20_000);
});
