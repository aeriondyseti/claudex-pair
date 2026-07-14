import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { systemClock, systemIds } from '@adapters/clock/index.ts';
import { FsMirrors, fsMessageCodec } from '@adapters/fs/brokerMirrors.ts';
import {
  ElectionLock,
  electionEndpointFor,
  fenceByVerifiedTermination,
  processStartTime,
  writeLease,
  type LeaseRecord,
} from '@broker/election.ts';
import { BrokerCore, DEFAULT_CONFIG, type BrokerResponse } from '@broker/server.ts';

/**
 * Server-side conversions of the F-matrix (W2b split: F7/F8/F10 here;
 * F3/F4/F5/F9/F14 are client-driven and live with the client tests).
 * Spec quotes match tests/broker/matrix.test.ts todos, which these replace.
 */

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'claudex-matrix-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function spawnEndpointHolder(endpoint: string): Promise<ChildProcess> {
  // A minimal foreign process that binds the election endpoint and idles —
  // the "hung broker": lock held (bound), heartbeat about to be stale.
  const code = `const s=require('node:net').createServer();s.listen(${JSON.stringify(endpoint)},()=>console.log('held'));setInterval(()=>{},1e6);`;
  const child = spawn('bun', ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  cleanups.push(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  });
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', () => resolve(child));
    child.once('error', reject);
    child.once('exit', () => reject(new Error('holder exited before binding')));
  });
}

async function staleLeaseFor(root: string, pid: number, startTime: string, endpoint: string): Promise<LeaseRecord> {
  const lease: LeaseRecord = {
    pid,
    processStartTime: startTime,
    nonce: 'test-nonce',
    epoch: 7,
    endpoint,
    heartbeatAt: '2020-01-01 00:00:00', // decades stale
  };
  await writeLease(root, lease);
  return lease;
}

describe('F7', () => {
  test('hung broker (lock held, heartbeat stale) → fencing by verified termination of the exact {pid, startTime, nonce} identity, then normal acquisition with epoch bump', async () => {
    const root = await tempRoot();
    await mkdirPair(root);
    const endpoint = electionEndpointFor(root);
    const holder = await spawnEndpointHolder(endpoint);
    const realStart = await processStartTime(holder.pid!);
    expect(realStart).toBeDefined();
    await staleLeaseFor(root, holder.pid!, realStart!, endpoint);

    const attempt = await ElectionLock.acquire(root, endpoint);
    expect(attempt.kind).toBe('hung');
    if (attempt.kind !== 'hung') return;

    const fenced = await fenceByVerifiedTermination(attempt.lease);
    expect(fenced.fenced).toBeTrue();

    const retry = await ElectionLock.acquire(root, endpoint);
    expect(retry.kind).toBe('acquired');
    if (retry.kind === 'acquired') {
      expect(retry.epoch).toBe(8); // recorded epoch 7 + 1
      await retry.lock.release();
    }
  }, 30_000);

  test('identity mismatch (PID reuse) → refuse and report', async () => {
    const root = await tempRoot();
    await mkdirPair(root);
    const endpoint = electionEndpointFor(root);
    const holder = await spawnEndpointHolder(endpoint);
    const lease = await staleLeaseFor(root, holder.pid!, 'not-the-real-start-time', endpoint);

    const fenced = await fenceByVerifiedTermination(lease);
    expect(fenced.fenced).toBeFalse();
    expect(fenced.reason).toContain('PID reuse');
    // The mismatched process must NOT have been killed.
    expect(await processStartTime(holder.pid!)).toBeDefined();
    holder.kill();
  }, 30_000);

  test('termination unavailable → "broker hung" surfaced, no takeover', async () => {
    const lease: LeaseRecord = {
      pid: 4_999_999, // cannot exist → start time unverifiable
      processStartTime: 'whatever',
      nonce: 'n',
      epoch: 1,
      endpoint: 'unused',
      heartbeatAt: '2020-01-01 00:00:00',
    };
    const fenced = await fenceByVerifiedTermination(lease);
    expect(fenced.fenced).toBeFalse();
    expect(fenced.reason).toContain('cannot verify');
  }, 15_000);
});

async function mkdirPair(root: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, '.pair'), { recursive: true });
}

function makeCore(root: string) {
  return new BrokerCore(
    join(root, '.pair'),
    { clock: systemClock, ids: systemIds, mirrors: new FsMirrors(root), codec: fsMessageCodec },
    { ...DEFAULT_CONFIG, idleGraceMs: 60_000 },
    { onStopped: () => undefined, pid: process.pid, epoch: 1, endpoint: 'test-endpoint', heartbeatAt: () => systemClock.now() },
  );
}

async function seedSession(core: BrokerCore, reqPrefix: string): Promise<void> {
  const init = await core.execute(`${reqPrefix}-init`, 'test-client', 'claude', {
    command: { kind: 'init-session', task: 'matrix', agents: ['claude', 'codex'], driver: 'claude' },
  });
  expect(init.ok).toBeTrue();
}

describe('F8', () => {
  test("mirror states: manifest behind journal head (incl. mismatched hashes from the broker's own partial update) → unconditional rebuild", async () => {
    const root = await tempRoot();
    const core = makeCore(root);
    await core.recover();
    await seedSession(core, 'f8a');
    const send = await core.execute('f8a-send', 'test-client', 'claude', {
      command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'mirror me' },
    });
    expect(send.ok).toBeTrue();
    await Bun.sleep(200); // let post-ack mirroring settle

    // Simulate the broker's own partial update: mirrors mutated, manifest stale.
    const sessionPath = join(root, '.pair', 'session.json');
    await writeFile(sessionPath, '{"scrambled": "by-partial-write"}', 'utf8');
    const manifestPath = join(root, '.pair', 'journal', 'mirror-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.mirroredSeq = 0; // behind head — hashes now ALSO mismatched
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const fresh = makeCore(root);
    const mode = await fresh.recover();
    expect(mode).toBe('rebuilt'); // never conflict when behind head
    const rebuilt = JSON.parse(await readFile(sessionPath, 'utf8'));
    expect(rebuilt.task).toBe('matrix');
    expect(rebuilt.turn).toBe('codex');
  }, 20_000);

  test('divergence AT parity → read-only conflict state', async () => {
    const root = await tempRoot();
    const core = makeCore(root);
    await core.recover();
    await seedSession(core, 'f8b');
    const send = await core.execute('f8b-send', 'test-client', 'claude', {
      command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'tamper target' },
    });
    expect(send.ok).toBeTrue();
    await Bun.sleep(200);

    // External mutation at parity: mirror changed, manifest seq untouched.
    const sessionPath = join(root, '.pair', 'session.json');
    const disk = JSON.parse(await readFile(sessionPath, 'utf8'));
    disk.turn = 'claude'; // an outsider "hands back" the turn
    await writeFile(sessionPath, JSON.stringify(disk, null, 2), 'utf8');

    const fresh = makeCore(root);
    const mode = await fresh.recover();
    expect(mode).toBe('conflict');
    // Read-only: mutations refused, loudly.
    const refused = await fresh.execute('f8b-refused', 'test-client', 'claude', {
      command: { kind: 'send-message', to: 'codex', type: 'info', turn: 'keep', body: 'should not commit' },
    });
    expect(refused.ok).toBeFalse();
    if (!refused.ok) expect(refused.error.code).toBe('mirror-conflict');
  }, 20_000);
});

describe('F10', () => {
  test('end-vs-grant-accept race → broker-serialized, grant mutation rejected post-end', async () => {
    const root = await tempRoot();
    const core = makeCore(root);
    await core.recover();
    await seedSession(core, 'f10');
    const issue = await core.execute('f10-grant', 'test-client', 'claude', {
      command: { kind: 'issue-grant', grantId: 'g-f10', to: 'codex', task: 'race', scope: { mode: 'worktree', worktree: 'wt' }, agreedIn: '' },
    });
    expect(issue.ok).toBeTrue();

    // Fire both without awaiting: the single-writer chain serializes them in
    // arrival order — end commits first, the accept is decided post-end.
    const [endR, acceptR] = (await Promise.all([
      core.execute('f10-end', 'client-a', 'claude', { command: { kind: 'end-session', summary: 'done' } }),
      core.execute('f10-accept', 'client-b', 'codex', { command: { kind: 'accept-grant', grantId: 'g-f10' } }),
    ])) as [BrokerResponse, BrokerResponse];

    expect(endR.ok).toBeTrue();
    expect(acceptR.ok).toBeFalse();
    if (endR.ok && !acceptR.ok) {
      const post = (endR.data as { session: { status: string; grants: Record<string, { state: string }> } }).session;
      expect(post.status).toBe('completed');
      // The losing envelope made no state change: grant still 'offered'.
      const grants = await core.query('f10-grants', 'grants');
      if (grants.ok) {
        const g = (grants.data as { id: string; state: string }[]).find((x) => x.id === 'g-f10');
        expect(g?.state).toBe('offered');
      }
    }
  }, 20_000);
});

function makeSink(as: string, got: unknown[]): import('@broker/ports.ts').DeliverySink {
  return {
    id: `sink-${as}`,
    sendDelivery: async (push) => {
      got.push(push);
    },
    sendError: async () => undefined,
  };
}

describe('F15', () => {
  test('revoke-vs-reply race → broker-serialized: whichever envelope commits first wins; the late reply is a rejected turn mutation — at no point do two agents hold the turn', async () => {
    // Order A: revoke enters the single-writer chain first.
    const rootA = await tempRoot();
    const coreA = makeCore(rootA);
    await coreA.recover();
    await seedSession(coreA, 'f15a');
    await coreA.execute('f15a-ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    const [revokeA, replyA] = await Promise.all([
      coreA.execute('f15a-revoke', 'client-a', 'claude', { command: { kind: 'revoke-turn', reason: 'stalled' } }),
      coreA.execute('f15a-reply', 'client-b', 'codex', { command: { kind: 'send-message', to: 'claude', type: 'answer', turn: 'pass', body: 'late' } }),
    ]);
    expect(revokeA.ok).toBeTrue();
    expect(replyA.ok).toBeFalse();
    if (!replyA.ok) expect(replyA.error.code).toBe('not-your-turn');
    const grantsA = await coreA.query('f15a-status', 'status');
    if (grantsA.ok) expect((grantsA.data as { session: { turn: string } }).session.turn).toBe('claude');

    // Order B: the reply lands first; the revoke is decided post-commit.
    const rootB = await tempRoot();
    const coreB = makeCore(rootB);
    await coreB.recover();
    await seedSession(coreB, 'f15b');
    await coreB.execute('f15b-ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    const [replyB, revokeB] = await Promise.all([
      coreB.execute('f15b-reply', 'client-b', 'codex', { command: { kind: 'send-message', to: 'claude', type: 'answer', turn: 'pass', body: 'in time' } }),
      coreB.execute('f15b-revoke', 'client-a', 'claude', { command: { kind: 'revoke-turn', reason: 'stalled' } }),
    ]);
    expect(replyB.ok).toBeTrue();
    expect(revokeB.ok).toBeFalse();
    if (!revokeB.ok) expect(revokeB.error.code).toBe('revoke-own-turn');
  }, 20_000);
});

describe('F16', () => {
  test('revoke attempt while the navigator holds a live delivery lease → rejected partner-active; after lease expiry with no ack, the same revoke commits', async () => {
    const root = await tempRoot();
    const core = new BrokerCore(
      join(root, '.pair'),
      { clock: systemClock, ids: systemIds, mirrors: new FsMirrors(root), codec: fsMessageCodec },
      { ...DEFAULT_CONFIG, idleGraceMs: 60_000, deliveryLeaseMs: 1_200 },
      { onStopped: () => undefined, pid: process.pid, epoch: 1, endpoint: 'test-endpoint', heartbeatAt: () => systemClock.now() },
    );
    await core.recover();
    await seedSession(core, 'f16');
    await core.execute('f16-ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    // A live subscriber takes the delivery lease (still working).
    const got: unknown[] = [];
    await core.subscribe('f16-sub', makeSink('codex', got), 'codex', 0);
    await Bun.sleep(100);
    expect(got.length).toBe(1);

    const early = await core.execute('f16-revoke-early', 'client-a', 'claude', { command: { kind: 'revoke-turn', reason: 'impatient' } });
    expect(early.ok).toBeFalse();
    if (!early.ok) expect(early.error.code).toBe('partner-active');

    await Bun.sleep(1_500); // lease expires, no ack
    const late = await core.execute('f16-revoke-late', 'client-a', 'claude', { command: { kind: 'revoke-turn', reason: 'now stale' } });
    expect(late.ok).toBeTrue();
  }, 20_000);
});

describe('F18 (server slice)', () => {
  test('kick with enqueued undelivered deliveries → voided to the archive in the same committed txn; nothing delivered to the removed agent; rejoin starts fresh', async () => {
    const root = await tempRoot();
    const core = makeCore(root);
    await core.recover();
    await seedSession(core, 'f18');
    await core.execute('f18-ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'pending one' } });
    const kick = await core.execute('f18-kick', 'client-a', 'claude', { command: { kind: 'kick-agent', agent: 'codex', reason: 'gone' } });
    expect(kick.ok).toBeTrue();
    // Same txn: no open deliveries remain for codex (incl. the kick notice).
    expect(core.journal.openDeliveriesFor('codex')).toHaveLength(0);
    await Bun.sleep(300); // post-ack mirror moves
    const inbox = await import('node:fs/promises').then((fs) => fs.readdir(join(root, '.pair', 'inbox', 'codex')).catch(() => []));
    expect(inbox).toHaveLength(0);
    const archive = await import('node:fs/promises').then((fs) => fs.readdir(join(root, '.pair', 'archive')).catch(() => []));
    expect(archive.length).toBeGreaterThanOrEqual(2); // pending ask + kick notice

    // A subscriber for the removed agent gets nothing redelivered.
    const got: unknown[] = [];
    await core.subscribe('f18-sub', makeSink('codex', got), 'codex', 0);
    await Bun.sleep(100);
    expect(got).toHaveLength(0);

    // Rejoin (driver-admitted) is a fresh roster entry — only the join
    // notice is open for it; nothing stale from before the kick.
    const rejoin = await core.execute('f18-join', 'client-a', 'claude', { command: { kind: 'join-session', agent: 'codex' } });
    expect(rejoin.ok).toBeTrue();
    const openNow = core.journal.openDeliveriesFor('codex');
    expect(openNow).toHaveLength(1);
    expect(openNow[0]!.message.type).toBe('join');
  }, 20_000);
});
