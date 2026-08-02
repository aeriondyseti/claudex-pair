import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { systemClock, systemIds } from '@adapters/clock/index.ts';
import { FsMirrors, fsMessageCodec } from '@adapters/fs/brokerMirrors.ts';
import { BrokerCore, DEFAULT_CONFIG } from '@broker/server.ts';

/** T4: the consent window end-to-end — an async review request past its
 * lapse deadline resolves as a RECORDED review-lapsed txn: awaiting debt
 * cleared, state request closed, both parties noticed with broker
 * provenance. Never a silent drop. */

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'claudex-lapse-'));
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('T4 review lapse sweep', () => {
  test('an expired async review request lapses: recorded event, debt cleared, both parties noticed', async () => {
    const core = makeCore(await tempRoot());
    await core.recover();
    expect((await core.execute('r-init', 'c1', 'claude', { command: { kind: 'init-session', task: 'lapse', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-l-001' } })).ok).toBeTrue();
    const ask = await core.execute('r-ask', 'c1', 'claude', {
      command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'review inc A', reviewAsync: true, lapseSec: 1 },
    });
    expect(ask.ok).toBeTrue();
    const askId = (ask as { events?: readonly { kind: string; id?: string; lapseAt?: string }[] }).events?.find((e) => e.kind === 'message-sent')?.id as string;
    expect(core.journal.awaiting().map((a) => a.messageId)).toEqual([askId]);
    expect(Object.keys(core.journal.sessionState?.reviewRequests ?? {})).toEqual([askId]);

    await sleep(2_500); // let the 1s window expire (second-granularity clock)
    await core.runDeadlineSweepOnceForTest();

    expect(core.journal.awaiting()).toEqual([]); // debt cleared, RECORDED
    expect(Object.keys(core.journal.sessionState?.reviewRequests ?? {})).toEqual([]);
    const claudeMail = core.journal.openDeliveriesFor('claude');
    const codexMail = core.journal.openDeliveriesFor('codex');
    expect(codexMail.some((d) => d.message.provenance === 'broker' && d.message.body.includes('LAPSED-CONSENT'))).toBeTrue();
    expect(claudeMail.some((d) => d.message.provenance === 'broker' && d.message.body.includes('consent recorded'))).toBeTrue();

    // Idempotent: a second sweep finds nothing to lapse.
    const head = core.journal.headSeq;
    await core.runDeadlineSweepOnceForTest();
    expect(core.journal.headSeq).toBe(head);
  });

  test('an answered request never lapses', async () => {
    const core = makeCore(await tempRoot());
    await core.recover();
    expect((await core.execute('r-init', 'c1', 'claude', { command: { kind: 'init-session', task: 'lapse2', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-l-002' } })).ok).toBeTrue();
    const ask = await core.execute('r-ask', 'c1', 'claude', {
      command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'review inc B', reviewAsync: true, lapseSec: 1 },
    });
    const askId = (ask as { events?: readonly { kind: string; id?: string }[] }).events?.find((e) => e.kind === 'message-sent')?.id as string;
    const verdict = await core.execute('r-rev', 'c2', 'codex', {
      command: { kind: 'send-message', to: 'claude', type: 'review', turn: 'keep', body: 'MED: rename the flag', replyTo: askId, severity: 'MED' },
    });
    expect(verdict.ok).toBeTrue();
    expect(Object.keys(core.journal.sessionState?.reviewRequests ?? {})).toEqual([]);
    expect(Object.keys(core.journal.sessionState?.reviewGates ?? {})).toHaveLength(1);

    await sleep(2_500);
    const head = core.journal.headSeq;
    await core.runDeadlineSweepOnceForTest();
    expect(core.journal.headSeq).toBe(head); // nothing lapsed

    // The gate blocks handoff until the driver answers the verdict.
    const gateId = Object.keys(core.journal.sessionState?.reviewGates ?? {})[0]!;
    const blocked = await core.execute('r-hand', 'c1', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'handoff', turn: 'pass', body: 'take over' } });
    expect(blocked.ok).toBeFalse();
    if (!blocked.ok) expect(blocked.error.code).toBe('unresolved-review-findings');
    expect((await core.execute('r-ans', 'c1', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'answer', turn: 'keep', body: 'renamed', replyTo: gateId } })).ok).toBeTrue();
    expect((await core.execute('r-hand2', 'c1', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'handoff', turn: 'pass', body: 'take over' } })).ok).toBeTrue();
  });
});
