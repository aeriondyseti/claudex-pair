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
      command: { kind: 'init-session', task: 'wire broadcast', agents: ['claude', 'codex'], driver: 'claude' },
      identity: { clientId: 'cli-claude', reqId: 'init-1' },
    });

    // Two agents WAITING on real wire subscriptions.
    const claudeSub = await claudeGw.subscribe('claude', 0);
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
