import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { systemClock, systemIds } from '@adapters/clock/index.ts';
import { FsMirrors, fsMessageCodec } from '@adapters/fs/brokerMirrors.ts';
import type { DeliveryPush, DeliverySink } from '@broker/ports.ts';
import { BrokerCore, DEFAULT_CONFIG } from '@broker/server.ts';

/** T3: one committed batch = one txn, n deliveries, n awaiting entries; a
 * matching answer batch clears the whole debt in one txn. */

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'claudex-batch-'));
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

const sink = (id: string, got: DeliveryPush[]): DeliverySink =>
  ({ id, sendDelivery: async (push) => void got.push(push), sendError: async () => undefined });
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('T3 broker batch', () => {
  test('a 3-ask batch lands as one txn with 3 deliveries and 3 awaiting entries; the answer batch clears them', async () => {
    const core = makeCore(await tempRoot());
    await core.recover();
    expect((await core.execute('r-init', 'c1', 'claude', { command: { kind: 'init-session', task: 'batch', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-b3-001' } })).ok).toBeTrue();
    const got: DeliveryPush[] = [];
    core.onConnection('conn-codex', 'open');
    expect((await core.subscribe('r-sub', sink('conn-codex', got), 'codex', 0)).ok).toBeTrue();

    const headBefore = core.journal.headSeq;
    const batch = await core.execute('r-batch', 'c1', 'claude', {
      command: { kind: 'send-batch', to: 'codex', type: 'ask', turn: 'pass', items: [{ body: '## q1' }, { body: '## q2' }, { body: '## q3' }] },
    });
    expect(batch.ok).toBeTrue();
    expect(core.journal.headSeq).toBe(headBefore + 1); // ONE txn
    await settle();
    expect(got).toHaveLength(3);
    expect(got.map((p) => p.message.header.turn)).toEqual(['keep', 'keep', 'pass']);
    const askIds = got.map((p) => p.message.header.id);
    expect(core.journal.awaiting().map((a) => a.messageId).sort()).toEqual([...askIds].sort());
    // The digest on each delivery already shows the recipient's full debt.
    expect(got[2]!.digest!.awaiting).toHaveLength(3);

    const answers = await core.execute('r-answers', 'c2', 'codex', {
      command: { kind: 'send-batch', to: 'claude', type: 'answer', turn: 'pass', items: askIds.map((id, i) => ({ body: `answer ${i + 1}`, replyTo: id })) },
    });
    expect(answers.ok).toBeTrue();
    expect(core.journal.awaiting()).toEqual([]);
    const session = core.journal.sessionState;
    expect(session?.topology === 'pair' && session.turn).toBe('claude');
  });
});
