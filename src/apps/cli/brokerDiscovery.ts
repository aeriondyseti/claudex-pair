import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { IpcClient } from '@adapters/ipc/client.ts';

export type LeaseRecord = {
  pid: number; processStartTime: string; nonce: string; epoch: number;
  endpoint: string; heartbeatAt: string;
};

export type DiscoveryOptions = {
  root: string;
  clientId?: string;
  readinessMs?: number;
  spawn?: (root: string) => Promise<void>;
};

export class BrokerDiscovery {
  readonly root: string;
  readonly clientId: string;
  readonly readinessMs: number;
  readonly spawnBroker: (root: string) => Promise<void>;

  constructor(options: DiscoveryOptions) {
    this.root = resolve(options.root);
    this.clientId = options.clientId ?? randomUUID();
    this.readinessMs = options.readinessMs ?? 5_000;
    this.spawnBroker = options.spawn ?? spawnDetachedBroker;
  }

  async connect(spawnIfAbsent = true): Promise<IpcClient> {
    const existing = await this.tryConnect();
    if (existing) return existing;
    if (!spawnIfAbsent) throw new Error('Broker is not running.');
    await this.spawnBroker(this.root);
    const deadline = Date.now() + this.readinessMs;
    let delay = 100;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const client = await this.tryConnect();
        if (client) return client;
      } catch (error) { last = error; }
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 800);
    }
    throw new Error(`Broker failed readiness within ${this.readinessMs}ms${last ? `: ${String(last)}` : ''}`);
  }

  async rediscover(): Promise<IpcClient> {
    return this.connect(true);
  }

  private async tryConnect(): Promise<IpcClient | undefined> {
    let lease: LeaseRecord;
    let token: string;
    try {
      [lease, token] = await Promise.all([
        readJson<LeaseRecord>(join(this.root, '.pair', 'broker.lease')),
        readFile(join(this.root, '.pair', 'broker.token'), 'utf8'),
      ]);
    } catch { return undefined; }
    const client = new IpcClient({ endpoint: lease.endpoint, token: token.trim(), epoch: lease.epoch, clientId: this.clientId, retryCount: 0 });
    try {
      await client.connect();
      const ping = await client.query('broker-status', randomUUID());
      if (!ping.ok) throw new Error(ping.error.message);
      return client;
    } catch {
      client.close();
      return undefined;
    }
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function spawnDetachedBroker(root: string): Promise<void> {
  const packageRoot = resolve(import.meta.dir, '..', '..', '..');
  const source = join(packageRoot, 'src', 'apps', 'broker', 'main.ts');
  const compiled = join(packageRoot, 'dist', 'pair-broker.exe');
  const bun = Bun.which('bun');
  const argv = bun ? [bun, 'run', source, root] : [compiled, root];
  // node:child_process with detached:true — Bun.spawn+unref leaves the
  // daemon in the parent's Windows process tree, so it died with the pwsh
  // shim (found live: broker.lease pid gone the moment the CLI exited).
  // detached:true gives it its own process group/console on every platform.
  const { spawn } = await import('node:child_process');
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}
