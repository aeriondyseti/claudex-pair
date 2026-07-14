import { createServer, createConnection, type Server } from 'node:net';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Broker election — endpoint-as-lock (BROKER-SPEC "Identity & discovery",
 * endpoint-as-lock revision). The lifetime lock is a bound net server on the
 * FIXED election name; the bound handle dies with the process, so the lock
 * releases on death and can never be stolen. `.pair/broker.lease` is only
 * the discovery/heartbeat record, written by the winner via atomic replace.
 */

export type LeaseRecord = {
  pid: number;
  processStartTime: string;
  nonce: string;
  epoch: number;
  endpoint: string;
  heartbeatAt: string;
};

export const HEARTBEAT_STALE_MS = 60_000;

/**
 * Local root normalization (same semantics as the ipc adapter's — but the
 * election name only ever needs to be consistent with ITSELF; clients never
 * dial it, they read the lease record).
 */
function normalizedRoot(root: string): string {
  const value = resolve(root).replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function electionEndpointFor(root: string, platform: NodeJS.Platform = process.platform): string {
  const hash = createHash('sha256').update(normalizedRoot(root)).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\claudex-${hash}-lock`;
  const runtime = process.env.XDG_RUNTIME_DIR || tmpdir();
  return `${runtime}/claudex-${hash}-lock.sock`;
}

export function leasePath(root: string): string {
  return join(root, '.pair', 'broker.lease');
}

export async function readLease(root: string): Promise<LeaseRecord | undefined> {
  try {
    return JSON.parse(await readFile(leasePath(root), 'utf8')) as LeaseRecord;
  } catch {
    return undefined;
  }
}

/** Atomic replace: the record is either the old one or the new one, never torn. */
export async function writeLease(root: string, record: LeaseRecord): Promise<void> {
  const path = leasePath(root);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export type AcquireResult =
  | { kind: 'acquired'; lock: ElectionLock; epoch: number }
  | { kind: 'incumbent'; lease: LeaseRecord | undefined }
  | { kind: 'hung'; lease: LeaseRecord; reason: string };

export class ElectionLock {
  #server: Server;
  #endpoint: string;
  private constructor(server: Server, endpoint: string) {
    this.#server = server;
    this.#endpoint = endpoint;
  }

  /**
   * Try to become the broker. Exactly one process can hold the election
   * binding; losers learn whether the incumbent is live (connect probe /
   * fresh heartbeat) or hung (stale heartbeat — fencing is the CALLER's
   * decision via fenceByVerifiedTermination, never automatic here).
   */
  static async acquire(root: string, endpoint: string = electionEndpointFor(root)): Promise<AcquireResult> {
    const bound = await tryBind(endpoint);
    if (bound.kind === 'bound') {
      const prior = await readLease(root);
      const epoch = (prior?.epoch ?? 0) + 1;
      return { kind: 'acquired', lock: new ElectionLock(bound.server, endpoint), epoch };
    }
    // EADDRINUSE. Unix: the socket file may be a corpse (F13) — probe it.
    if (process.platform !== 'win32' && !(await endpointIsLive(endpoint))) {
      await rm(endpoint, { force: true });
      const rebound = await tryBind(endpoint);
      if (rebound.kind === 'bound') {
        const prior = await readLease(root);
        return { kind: 'acquired', lock: new ElectionLock(rebound.server, endpoint), epoch: (prior?.epoch ?? 0) + 1 };
      }
    }
    const lease = await readLease(root);
    if (lease && Date.now() - Date.parse(lease.heartbeatAt) > HEARTBEAT_STALE_MS) {
      return { kind: 'hung', lease, reason: `heartbeat stale since ${lease.heartbeatAt}` };
    }
    return { kind: 'incumbent', lease };
  }

  async release(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.#server.close((e) => (e ? reject(e) : resolve())));
    if (process.platform !== 'win32') await rm(this.#endpoint, { force: true });
  }
}

/**
 * F7 fencing: kill exactly the recorded identity — pid AND processStartTime
 * must both match. PID reuse (start time differs) or an unverifiable start
 * time refuses the takeover; the caller surfaces "broker hung" to the human
 * (spec: termination unavailable → no takeover).
 */
export async function fenceByVerifiedTermination(lease: LeaseRecord): Promise<{ fenced: boolean; reason: string }> {
  const observed = await processStartTime(lease.pid);
  if (observed === undefined) return { fenced: false, reason: `cannot verify start time of pid ${lease.pid}` };
  if (!startTimesMatch(observed, lease.processStartTime)) {
    return { fenced: false, reason: `pid ${lease.pid} identity mismatch (PID reuse) — refusing to kill` };
  }
  try {
    process.kill(lease.pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') return { fenced: false, reason: `kill failed: ${String(error)}` };
  }
  // Wait for the corpse to disappear so its election binding is gone.
  for (let i = 0; i < 50; i++) {
    if ((await processStartTime(lease.pid)) === undefined) return { fenced: true, reason: 'terminated' };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { fenced: false, reason: `pid ${lease.pid} did not exit after kill` };
}

/**
 * Cross-platform "when did this pid start" — the identity fact fencing keys
 * on. Undefined means either the process is gone or the platform cannot
 * answer (caller must treat unverifiable as no-takeover).
 */
export async function processStartTime(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') {
    const out = await run('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`]);
    return out?.trim() || undefined;
  }
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // Field 22 (starttime, clock ticks since boot), after the parenthesized comm.
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return afterComm[19];
    } catch {
      return undefined;
    }
  }
  const out = await run('ps', ['-p', String(pid), '-o', 'lstart=']);
  return out?.trim() || undefined;
}

export function currentProcessStartTime(): Promise<string | undefined> {
  return processStartTime(process.pid);
}

function startTimesMatch(observed: string, recorded: string): boolean {
  return observed.trim() === recorded.trim();
}

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });
}

type BindResult = { kind: 'bound'; server: Server } | { kind: 'in-use' };

async function tryBind(endpoint: string): Promise<BindResult> {
  try {
    return await new Promise<BindResult>((resolve, reject) => {
      const server = createServer();
      server.once('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') resolve({ kind: 'in-use' });
        else reject(error);
      });
      server.listen(endpoint, () => resolve({ kind: 'bound', server }));
    });
  } catch (error) {
    // Bun (≤1.3) throws SYNCHRONOUSLY (ERR_INVALID_ARG_TYPE) when another
    // PROCESS holds a Windows named pipe, instead of emitting EADDRINUSE.
    // Only classify as in-use when a live listener actually answers.
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return { kind: 'in-use' };
    if (endpoint.startsWith('\\\\.\\pipe\\') && (await endpointIsLive(endpoint))) return { kind: 'in-use' };
    throw error;
  }
}

function endpointIsLive(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    const done = (live: boolean) => {
      socket.destroy();
      resolve(live);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 250).unref();
  });
}
