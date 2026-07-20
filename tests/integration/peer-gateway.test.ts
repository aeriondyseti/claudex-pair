import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { systemClock, systemIds } from '@adapters/clock/index.ts';
import { FsMirrors, fsMessageCodec } from '@adapters/fs/brokerMirrors.ts';
import { IpcClient, IpcServer, endpointFor } from '@adapters/ipc/index.ts';
import type { ClientFrame, ServerConnection, ServerFrame } from '@adapters/ipc/types.ts';
import type { DeliverySink, ObserverSink } from '@broker/ports.ts';
import { BrokerCore, DEFAULT_CONFIG } from '@broker/server.ts';
import { BrokerGateway, BrokerWireError } from '../../src/apps/cli/brokerGateway.ts';

/**
 * Peer 1A round 2 BLOCKER (codex #1): the REAL CLI seam. A connection tag
 * dies with its socket, so the GATEWAY carries the credential and
 * auto-attaches on every live connection — first contact, new processes,
 * and broker restarts mid-wait. These pins run the full in-process stack:
 * real BrokerCore behind a real IpcServer, real IpcClient gateways.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const CRED = { claude: 'a'.repeat(64), codex: 'b'.repeat(64) };
const creds = (map: Record<string, string>) => async (agent: string) => {
  const token = map[agent];
  if (!token) throw new Error(`no credential for ${agent}`);
  return token;
};

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

/** Production wiring verbatim (apps/broker/main.ts handler shape, post-1A). */
async function makeBroker(root: string, epoch: number) {
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
        case 'execute': return (await core.execute(frame.reqId, frame.clientId, frame.as, frame.envelope, connection.id)) as ServerFrame;
        case 'agent-attach': return (await core.agentAttach(frame.reqId, connection.id, frame.clientId, frame.agent, frame.credential)) as ServerFrame;
        case 'query': return (await core.query(frame.reqId, frame.what, frame.args)) as ServerFrame;
        case 'subscribe': return (await core.subscribe(frame.reqId, asSink(connection), frame.as, frame.afterDeliverySeq)) as ServerFrame;
        case 'observe': return (await core.observe(frame.reqId, asObserverSink(connection))) as ServerFrame;
        case 'user-attach': return (await core.userAttach(frame.reqId, asObserverSink(connection), frame.clientId, frame.userToken)) as ServerFrame;
        case 'user-send': return (await core.userSend(frame.reqId, frame.clientId, connection.id, frame.to, frame.body)) as ServerFrame;
        case 'user-action': return (await core.userAction(frame.reqId, frame.clientId, connection.id, frame.action)) as ServerFrame;
        case 'ack': return (await core.ack(frame.reqId, frame.deliveryId, frame.clientId, connection.id)) as ServerFrame;
        case 'extend': return core.extend(frame.reqId, frame.deliveryId, connection.id) as ServerFrame;
      }
    },
    onConnection: (id, event) => core.onConnection(id, event),
  });
  await server.listen();
  cleanups.push(() => server.close().catch(() => undefined));
  return { core, server, endpoint };
}

const send = (gateway: BrokerGateway, as: string, to: string, body: string, reqId: string) =>
  gateway.execute({ as, command: { kind: 'send-message', to, type: 'info', turn: 'keep', body }, identity: { clientId: gateway.clientId, reqId } });

describe('peer gateway: auto-attach across process boundaries', () => {
  test('init process exits; a NEW process sends and waits via auto-attach; first codex contact auto-admits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-peergw-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.pair'), { recursive: true });
    const { endpoint } = await makeBroker(root, 31);

    // Process 1: init (implicit initiator attach), then EXIT.
    const p1 = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'tok', epoch: 31, clientId: 'cli-claude' }), creds({ claude: CRED.claude }));
    await p1.execute({
      as: 'claude',
      command: { kind: 'init-session', task: 'peer wire', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-wire-1', topology: 'peer' },
      identity: { clientId: 'cli-claude', reqId: 'init-1' },
      credential: CRED.claude,
    });
    await p1.close();

    // codex's FIRST contact is a plain send on a fresh gateway: the
    // reactive auto-attach TOFU-binds AND admits it (closing the barrier),
    // then the send retries and lands.
    const codexGw = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'tok', epoch: 31, clientId: 'cli-codex' }), creds({ codex: CRED.codex }));
    cleanups.push(() => codexGw.close());
    const sent = await send(codexGw, 'codex', 'claude', 'hello from a brand-new process', 's-1');
    expect(sent.events.some((e) => e.kind === 'message-sent')).toBeTrue();

    // Process 2 for claude: a NEW untagged connection; subscribe (wait)
    // auto-attaches, receives, and acks (recipient-owned).
    const p2 = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'tok', epoch: 31, clientId: 'cli-claude-2' }), creds({ claude: CRED.claude }));
    cleanups.push(() => p2.close());
    const subscription = await p2.subscribe('claude', 0);
    cleanups.push(() => subscription.close());
    const first = (await subscription.deliveries[Symbol.asyncIterator]().next()).value!;
    expect((first.message.header as { from: string }).from).toBe('codex');
    await subscription.ack(first.deliveryId); // ownership holds on the tagged connection
  }, 15_000);

  test('a process holding the WRONG credential fails typed, before any recorded outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-peergw2-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.pair'), { recursive: true });
    const { endpoint } = await makeBroker(root, 32);

    const init = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'tok', epoch: 32, clientId: 'cli-claude' }), creds({ claude: CRED.claude }));
    cleanups.push(() => init.close());
    await init.execute({
      as: 'claude',
      command: { kind: 'init-session', task: 'peer wire', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-wire-2', topology: 'peer' },
      identity: { clientId: 'cli-claude', reqId: 'init-1' },
      credential: CRED.claude,
    });

    const impostor = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'tok', epoch: 32, clientId: 'cli-evil' }), creds({ claude: CRED.codex }));
    cleanups.push(() => impostor.close());
    const attempt = send(impostor, 'claude', 'codex', 'forged', 'f-1');
    await expect(attempt).rejects.toMatchObject({ code: 'agent-auth-failed' } as Partial<BrokerWireError>);
  }, 15_000);

  test('broker restart during a blocked wait: the reconnect re-attaches before resubscribing and the wait resumes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-peergw3-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.pair'), { recursive: true });
    const first = await makeBroker(root, 33);

    // Bootstrap: claude inits, codex auto-admits.
    const initGw = BrokerGateway.forClient(new IpcClient({ endpoint: first.endpoint, token: 'tok', epoch: 33, clientId: 'cli-claude' }), creds({ claude: CRED.claude }));
    await initGw.execute({
      as: 'claude',
      command: { kind: 'init-session', task: 'peer wire', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-wire-3', topology: 'peer' },
      identity: { clientId: 'cli-claude', reqId: 'init-1' },
      credential: CRED.claude,
    });
    const codexBoot = BrokerGateway.forClient(new IpcClient({ endpoint: first.endpoint, token: 'tok', epoch: 33, clientId: 'cli-codex' }), creds({ codex: CRED.codex }));
    await send(codexBoot, 'codex', 'claude', 'bootstrap', 'b-1');
    await codexBoot.close();
    await initGw.close();

    // claude blocks on a wait through a RESTART-aware connector.
    const nextEndpoint = endpointFor(root, 34);
    let restarted = false;
    const waiter = new BrokerGateway(
      {
        clientId: 'cli-claude-wait',
        connect: async () => new IpcClient({ endpoint: first.endpoint, token: 'tok', epoch: 33, clientId: 'cli-claude-wait' }),
        rediscover: async () => {
          if (!restarted) throw new Error('broker not back yet');
          return new IpcClient({ endpoint: nextEndpoint, token: 'tok', epoch: 34, clientId: 'cli-claude-wait' });
        },
      },
      { maxAttempts: 8, baseDelayMs: 25, maxDelayMs: 100 },
      creds({ claude: CRED.claude }),
    );
    cleanups.push(() => waiter.close());
    const subscription = await waiter.subscribe('claude', 0);
    cleanups.push(() => subscription.close());
    const iterator = subscription.deliveries[Symbol.asyncIterator]();
    const boot = (await iterator.next()).value!;
    await subscription.ack(boot.deliveryId);

    // RESTART: kill epoch 33, bring up epoch 34 over the same journal.
    await first.server.close();
    const second = await makeBroker(root, 34);
    restarted = true;

    // codex (fresh process at the new epoch) sends; claude's blocked wait
    // must re-attach on the reconnected socket and receive it.
    const codex2 = BrokerGateway.forClient(new IpcClient({ endpoint: second.endpoint, token: 'tok', epoch: 34, clientId: 'cli-codex-2' }), creds({ codex: CRED.codex }));
    cleanups.push(() => codex2.close());
    await send(codex2, 'codex', 'claude', 'after the restart', 'a-1');

    const resumed = (await iterator.next()).value!;
    expect((resumed.message.body as string)).toContain('after the restart');
    await subscription.ack(resumed.deliveryId); // ack ownership across the re-attach
  }, 20_000);
});


describe('round 4 #2: rebind terminates waits promptly; ONE explicit regenerate converges every process', () => {
  test('two simultaneous gateways get typed prompt failures (zero auto-mints); one -Regenerate converges both', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-peergw4-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.pair'), { recursive: true });
    const { endpoint } = await makeBroker(root, 35);

    // Bootstrap: claude inits; codex auto-admits.
    const initGw = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'tok', epoch: 35, clientId: 'cli-claude' }), creds({ claude: CRED.claude }));
    await initGw.execute({
      as: 'claude',
      command: { kind: 'init-session', task: 'peer wire', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-wire-4', topology: 'peer' },
      identity: { clientId: 'cli-claude', reqId: 'init-1' },
      credential: CRED.claude,
    });
    await initGw.close();

    // A SHARED credential store (the cross-process reality): both codex
    // gateways read the same source; nothing auto-mints (round 4 #2 safe
    // alternative — auto-rotation loses the store race).
    const store = { token: CRED.codex, mints: 0 };
    const sharedSource = async (agent: string) => {
      if (agent !== 'codex') throw new Error('wrong agent');
      return store.token;
    };
    const gwA = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'tok', epoch: 35, clientId: 'cli-codex-a' }), sharedSource);
    const gwB = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'tok', epoch: 35, clientId: 'cli-codex-b' }), sharedSource);
    cleanups.push(() => gwA.close());
    cleanups.push(() => gwB.close());

    // Both processes attach (A admits, B reconnects) and BLOCK on waits.
    await send(gwA, 'codex', 'claude', 'bootstrap', 'b-1');
    const subA = await gwA.subscribe('codex', 0);
    const subB = await gwB.subscribe('codex', 0);
    cleanups.push(() => subA.close());
    cleanups.push(() => subB.close());
    // Catch-wrap at creation: Bun flags rejections whose handler attaches
    // a tick later as unhandled (established suite pattern).
    const pendingA = subA.deliveries[Symbol.asyncIterator]().next().then(() => undefined, (e: unknown) => e);
    const pendingB = subB.deliveries[Symbol.asyncIterator]().next().then(() => undefined, (e: unknown) => e);

    // The USER rebinds codex over the real wire while both waits block.
    const userGw = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'tok', epoch: 35, clientId: 'cli-user' }));
    cleanups.push(() => userGw.close());
    const userSession = await userGw.userAttach('f'.repeat(64));
    cleanups.push(() => userSession.close());
    await userSession.action('ract-1', { verb: 'rebind', agent: 'codex' });

    // BOTH blocked waits fail promptly and typed — no hang, no divergent
    // auto-rotation, the shared store untouched.
    expect(await pendingA).toMatchObject({ code: 'credential-revoked' });
    expect(await pendingB).toMatchObject({ code: 'credential-revoked' });
    expect(store.mints).toBe(0);
    expect(store.token).toBe(CRED.codex);

    // ONE explicit regenerate (pair attach -Regenerate semantics): the
    // store is atomically replaced ONCE; every process converges on it.
    store.token = 'd'.repeat(64);
    store.mints += 1;
    const boundA = await gwA.agentAttach('codex', store.token);
    expect(boundA.credentialVersion).toBe(2); // store == broker verifier
    const subA2 = await gwA.subscribe('codex', 0);
    cleanups.push(() => subA2.close());
    const subB2 = await gwB.subscribe('codex', 0); // second process converges on the SAME token
    cleanups.push(() => subB2.close());
    const pending2 = subA2.deliveries[Symbol.asyncIterator]().next();

    const claudeGw = BrokerGateway.forClient(new IpcClient({ endpoint, token: 'tok', epoch: 35, clientId: 'cli-claude-2' }), creds({ claude: CRED.claude }));
    cleanups.push(() => claudeGw.close());
    await send(claudeGw, 'claude', 'codex', 'after the rebind', 'a-1');
    // Logical-identity deduplication (at-least-once wire): drain and ack
    // by deliveryId until the EXACT post-rebind body appears (bounded),
    // then assert exactly ONE unique delivery identity carries it —
    // same-ID re-occurrences remain legal redelivery.
    const seen = new Map<string, string>(); // deliveryId -> body
    const iterator2 = subA2.deliveries[Symbol.asyncIterator]();
    let step2 = await pending2;
    const deadline = Date.now() + 5_000;
    for (;;) {
      const delivery = step2.value!;
      seen.set(delivery.deliveryId, delivery.message.body as string);
      await subA2.ack(delivery.deliveryId);
      if ([...seen.values()].some((b) => b.includes('after the rebind'))) break;
      if (Date.now() > deadline) throw new Error('post-rebind message never arrived');
      step2 = await iterator2.next();
    }
    expect([...seen.entries()].filter(([, b]) => b.includes('after the rebind'))).toHaveLength(1);
    expect(store.mints).toBe(1); // exactly one replacement, ever
  }, 20_000);
});
