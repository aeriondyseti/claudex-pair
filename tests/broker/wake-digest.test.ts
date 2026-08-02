import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { systemClock, systemIds } from '@adapters/clock/index.ts';
import { FsMirrors, fsMessageCodec } from '@adapters/fs/brokerMirrors.ts';
import type { DeliveryPush, DeliverySink } from '@broker/ports.ts';
import { BrokerCore, DEFAULT_CONFIG } from '@broker/server.ts';

/** T2 (THROUGHPUT-SPRINT): every pushed delivery carries the wake packet —
 * per-recipient protocol orientation computed at push time — and the
 * sender-declared review scope survives event → envelope → header → raw. */

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'claudex-digest-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.pair'), { recursive: true });
  return root;
}

function makeCore(root: string): BrokerCore {
  return new BrokerCore(
    join(root, '.pair'),
    { clock: systemClock, ids: systemIds, mirrors: new FsMirrors(root), codec: fsMessageCodec },
    DEFAULT_CONFIG,
    { onStopped: () => undefined, pid: process.pid, epoch: 1, endpoint: 'test', heartbeatAt: () => systemClock.now() },
  );
}

function sink(id: string, got: DeliveryPush[]): DeliverySink {
  return { id, sendDelivery: async (push) => void got.push(push), sendError: async () => undefined };
}

/** Pushes ride #afterCommit (post-ack, async) — settle them before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('T2 wake digest', () => {
  test('a pushed ask carries turn/driver orientation, the open ask, and the review scope', async () => {
    const core = makeCore(await tempRoot());
    await core.recover();
    expect((await core.execute('r-init', 'c1', 'claude', { command: { kind: 'init-session', task: 't2', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t2-001' } })).ok).toBeTrue();
    const got: DeliveryPush[] = [];
    core.onConnection('conn-codex', 'open');
    expect((await core.subscribe('r-sub', sink('conn-codex', got), 'codex', 0)).ok).toBeTrue();
    const send = await core.execute('r-send', 'c1', 'claude', {
      command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'review the stats fold', reviewScope: 'main..HEAD -- src/core/stats.ts' },
    });
    expect(send.ok).toBeTrue();
    await settle();
    expect(got).toHaveLength(1);
    const push = got[0]!;
    expect(push.message.header.reviewScope).toBe('main..HEAD -- src/core/stats.ts');
    expect(push.message.raw).toContain('review_scope: main..HEAD -- src/core/stats.ts');
    expect(push.digest).toBeDefined();
    expect(push.digest!.status).toBe('active');
    expect(push.digest!.turn).toBe('codex'); // post-commit: the turn already moved
    expect(push.digest!.driver).toBe('claude');
    expect(push.digest!.awaiting.map((a) => [a.from, a.to])).toEqual([['claude', 'codex']]);
  });

  test('digest awaiting is filtered to the recipient and an answer clears it', async () => {
    const core = makeCore(await tempRoot());
    await core.recover();
    expect((await core.execute('r-init', 'c1', 'claude', { command: { kind: 'init-session', task: 't2', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t2-002' } })).ok).toBeTrue();
    const askOutcome = await core.execute('r-ask', 'c1', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    expect(askOutcome.ok).toBeTrue();
    const askId = (askOutcome as { events?: readonly { kind: string; id?: string }[] }).events?.find((e) => e.kind === 'message-sent')?.id;
    const got: DeliveryPush[] = [];
    core.onConnection('conn-claude', 'open');
    expect((await core.subscribe('r-sub', sink('conn-claude', got), 'claude', 0)).ok).toBeTrue();
    const answer = await core.execute('r-answer', 'c2', 'codex', { command: { kind: 'send-message', to: 'claude', type: 'answer', turn: 'pass', body: 'a', replyTo: askId } });
    expect(answer.ok).toBeTrue();
    await settle();
    expect(got).toHaveLength(1);
    // The answer resolved the ask in the same txn — the digest shows no debt.
    expect(got[0]!.digest!.awaiting).toEqual([]);
    expect(got[0]!.digest!.turn).toBe('claude');
  });

  test('decide rejects a multi-line or oversized review scope fail-closed', async () => {
    const core = makeCore(await tempRoot());
    await core.recover();
    expect((await core.execute('r-init', 'c1', 'claude', { command: { kind: 'init-session', task: 't2', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t2-003' } })).ok).toBeTrue();
    const newline = await core.execute('r-bad1', 'c1', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'q', reviewScope: 'main..HEAD\ninjected: line' } });
    expect(newline.ok).toBeFalse();
    if (!newline.ok) expect(newline.error.code).toBe('invalid-review-scope');
    const oversized = await core.execute('r-bad2', 'c1', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'q', reviewScope: 'x'.repeat(300) } });
    expect(oversized.ok).toBeFalse();
    if (!oversized.ok) expect(oversized.error.code).toBe('invalid-review-scope');
  });
});
