import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IpcClient, type DeliveryFrame } from '@adapters/ipc/index.ts';

const cli = join(import.meta.dir, '..', '..', 'src', 'apps', 'cli', 'main.ts');

test.skipIf(process.platform === 'win32')('real broker: spawn race, idle respawn, execute, subscribe, ack, and stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-broker-e2e-'));
  let idleGraceMs = '3000';
  const run = async (...argv: string[]) => {
    const proc = Bun.spawn(['bun', 'run', cli, ...argv], {
      cwd: root, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, CLAUDEX_BROKER_IDLE_GRACE_MS: idleGraceMs },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, output: stdout + stderr };
  };
  try {
    const init = await run('init', '-Task', 'real broker e2e', '-Agents', 'claude,codex', '-Driver', 'claude');
    expect(init.code, init.output).toBe(0); expect(init.output).toContain('Pairing session initialized');

    // F9: no connections/open deliveries → idle exit; the next clients race
    // to spawn and both converge on the single endpoint-lock winner (F3).
    await Bun.sleep(3_800);
    const stopped = await run('broker', 'status', '-Root', root);
    expect(stopped.output).toContain('Broker not running.');
    const [a, b] = await Promise.all([run('status'), run('status')]);
    expect(a.code, a.output).toBe(0); expect(b.code, b.output).toBe(0);
    expect(a.output).toContain('Task:      real broker e2e'); expect(b.output).toContain('Task:      real broker e2e');

    await run('broker', 'stop', '-Root', root); await Bun.sleep(1_200);
    idleGraceMs = '60000';
    expect((await run('status')).code).toBe(0);

    const sent = await run('send', '-From', 'claude', '-To', 'codex', '-Type', 'ask', '-Message', 'real delivery', '-NoWait');
    expect(sent.code, sent.output).toBe(0); expect(sent.output).toContain('Sent ask -> codex');

    // F5: duplicate subscribers never receive the same active lease. F4:
    // closing the holder without ack makes the still-live peer receive it.
    const lease = JSON.parse(await readFile(join(root, '.pair', 'broker.lease'), 'utf8')) as { endpoint: string; epoch: number };
    const token = (await readFile(join(root, '.pair', 'broker.token'), 'utf8')).trim();
    const first = new IpcClient({ endpoint: lease.endpoint, epoch: lease.epoch, token, clientId: 'wait-1', retryCount: 0 });
    const second = new IpcClient({ endpoint: lease.endpoint, epoch: lease.epoch, token, clientId: 'wait-2', retryCount: 0 });
    const firstDelivery = new Promise<DeliveryFrame>((resolve) => first.onDelivery(resolve));
    await first.subscribe('codex', 0); expect((await firstDelivery).message).toMatchObject({ body: 'real delivery' });
    let secondCount = 0; let resolveSecond!: (frame: DeliveryFrame) => void;
    const secondDelivery = new Promise<DeliveryFrame>((resolve) => { resolveSecond = resolve; });
    second.onDelivery((frame) => { secondCount++; resolveSecond(frame); });
    await second.subscribe('codex', 0); await Bun.sleep(250); expect(secondCount).toBe(0);
    first.close();
    const redelivered = await Promise.race([secondDelivery, Bun.sleep(2_500).then(() => undefined)]);
    expect(redelivered?.deliveryId).toBeDefined(); await second.ack(redelivered!.deliveryId); second.close();

    // Real CLI subscription path exercises render + stdout flush + ack.
    const reply = await run('send', '-From', 'codex', '-To', 'claude', '-Type', 'answer', '-Message', 'real reply', '-NoWait');
    expect(reply.code, reply.output).toBe(0);
    const received = await run('wait', '-As', 'claude', '-TimeoutSec', '5');
    expect(received.code, received.output).toBe(0); expect(received.output).toContain('real reply'); expect(received.output).toContain('It is now YOUR turn, claude');
  } finally {
    await run('broker', 'stop', '-Root', root).catch(() => undefined);
    await Bun.sleep(300);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
