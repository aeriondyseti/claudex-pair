import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { systemClock, systemIds } from '@adapters/clock/index.ts';
import { FsMirrors, fsMessageCodec } from '@adapters/fs/brokerMirrors.ts';
import { IpcServer } from '@adapters/ipc/server.ts';
import { endpointFor } from '@adapters/ipc/endpoint.ts';
import type { ClientFrame, ServerConnection, ServerFrame } from '@adapters/ipc/types.ts';
import { ElectionLock, currentProcessStartTime, electionEndpointFor, fenceByVerifiedTermination, writeLease } from '@broker/election.ts';
import type { DeliverySink } from '@broker/ports.ts';
import { BrokerCore, DEFAULT_CONFIG, type BrokerConfig, type BrokerResponse } from '@broker/server.ts';

/**
 * Broker daemon composition root (BROKER-SPEC "Lifecycle"). Spawned detached
 * by the CLI on demand: elect (endpoint-as-lock) → recover journal →
 * reconcile mirrors → listen on the epoch endpoint → write token + lease →
 * heartbeat. Exits on `pair broker stop` (drain) or sustained idle. This is
 * the only place transport frames meet the broker core.
 *
 * Usage: bun run src/apps/broker/main.ts <repo-root>
 */

function configFromEnv(): BrokerConfig {
  const config = { ...DEFAULT_CONFIG };
  const raw = process.env['CLAUDEX_BROKER_IDLE_GRACE_MS'];
  if (raw !== undefined) {
    const n = Number(raw);
    // Contract: tests may only SHORTEN idle grace, never extend it.
    if (Number.isInteger(n) && n >= 1_000 && n <= DEFAULT_CONFIG.idleGraceMs) config.idleGraceMs = n;
  }
  return config;
}

function asSink(connection: ServerConnection): DeliverySink {
  return {
    id: connection.id,
    sendDelivery: (push) => connection.send(push as ServerFrame),
    sendError: (code, message) => connection.send({ ok: false, error: { code, message } }),
  };
}

async function main(): Promise<number> {
  const root = resolve(process.argv[2] ?? process.cwd());
  const config = configFromEnv();
  const clock = systemClock;

  let acquired = await ElectionLock.acquire(root, electionEndpointFor(root));
  if (acquired.kind === 'hung') {
    // F7: fence exactly the recorded identity, then retry once.
    const fenced = await fenceByVerifiedTermination(acquired.lease);
    if (!fenced.fenced) {
      process.stderr.write(`broker hung (pid ${acquired.lease.pid}): ${fenced.reason} — no takeover.\n`);
      return 3;
    }
    acquired = await ElectionLock.acquire(root, electionEndpointFor(root));
  }
  if (acquired.kind !== 'acquired') {
    // A live incumbent serves this repo; our spawn was a race loser (F3).
    return 0;
  }
  const { lock, epoch } = acquired;
  const startTime = (await currentProcessStartTime()) ?? clock.now();
  const endpoint = endpointFor(root, epoch);
  const nonce = randomBytes(16).toString('hex');

  // Token: generated ONLY by the lease winner, immediately after acquisition.
  await mkdir(join(root, '.pair'), { recursive: true });
  const token = randomBytes(32).toString('hex');
  const tokenPath = join(root, '.pair', 'broker.token');
  await writeFile(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  await chmod(tokenPath, 0o600).catch(() => undefined);

  let heartbeatAt = clock.now();
  const lease = () => ({
    pid: process.pid,
    processStartTime: startTime,
    nonce,
    epoch,
    endpoint,
    heartbeatAt,
  });

  let server: IpcServer | undefined = undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined = undefined;
  let stopped = false;
  const stop = async (code: number) => {
    if (stopped) return;
    stopped = true;
    core.stopIdleMonitor();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await server?.close().catch(() => undefined);
    await lock.release().catch(() => undefined);
    process.exit(code);
  };

  const core = new BrokerCore(
    join(root, '.pair'),
    { clock, ids: systemIds, mirrors: new FsMirrors(root), codec: fsMessageCodec },
    config,
    { onStopped: () => void stop(0), pid: process.pid, epoch, heartbeatAt: () => heartbeatAt },
  );

  const mode = await core.recover();
  if (mode === 'conflict') {
    process.stderr.write('mirror divergence at journal parity — serving read-only; run pair doctor.\n');
  }

  const handler = async (frame: ClientFrame, connection: ServerConnection): Promise<ServerFrame | void> => {
    switch (frame.kind) {
      case 'execute':
        return (await core.execute(frame.reqId, frame.clientId, frame.as, frame.envelope)) as ServerFrame;
      case 'query': {
        const response = (await core.query(frame.reqId, frame.what)) as ServerFrame;
        if (frame.what === 'broker-stop') {
          // Respond-then-close (drain contract): the response frame goes out
          // on the returned promise; teardown follows once it has flushed.
          setTimeout(() => void stop(0), 200).unref();
        }
        return response;
      }
      case 'subscribe':
        await core.subscribe(asSink(connection), frame.as, frame.afterDeliverySeq);
        return;
      case 'ack':
        await core.ack(frame.deliveryId, frame.clientId);
        return;
      case 'extend':
        core.extend(frame.deliveryId);
        return;
    }
  };

  server = new IpcServer({
    endpoint,
    token,
    epoch,
    handler: handler as (frame: ClientFrame, connection: ServerConnection) => Promise<ServerFrame | void>,
    onConnection: (id, event) => core.onConnection(id, event),
  });
  await server.listen();
  await writeLease(root, lease());

  heartbeatTimer = setInterval(() => {
    heartbeatAt = clock.now();
    void writeLease(root, lease()).catch(() => undefined);
  }, config.heartbeatMs);
  heartbeatTimer.unref();

  core.startIdleMonitor();
  process.on('SIGINT', () => void stop(0));
  process.on('SIGTERM', () => void stop(0));

  // Readiness marker for the spawning CLI's bounded backoff.
  process.stdout.write(`claudex-broker ready pid=${process.pid} epoch=${epoch} endpoint=${endpoint}\n`);
  return -1; // stays alive; exit happens via stop()
}

const code = await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  return 1;
});
if (code >= 0) process.exit(code);

// Referenced only for the response union documented in server.ts.
export type { BrokerResponse };
