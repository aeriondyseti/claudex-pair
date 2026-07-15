import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { systemClock, systemIds } from '@adapters/clock/index.ts';
import { FsMirrors, fsMessageCodec } from '@adapters/fs/brokerMirrors.ts';
import type { ObserverPushWire, ObserverSink } from '@broker/ports.ts';
import { BrokerCore, DEFAULT_CONFIG } from '@broker/server.ts';
import type { ObserverSnapshotDto } from '@app/ports/gateway.ts';

/**
 * U1 broker user-channel contract (U1-SLICE3-DESIGN.md, approved):
 * transport gate, connection-bound auth, TOFU registration through the
 * journal, dedup-before-allocate, and groupId/provenance projection.
 */

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'claudex-user-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.pair'), { recursive: true });
  return root;
}

function makeCore(root: string) {
  return new BrokerCore(
    join(root, '.pair'),
    { clock: systemClock, ids: systemIds, mirrors: new FsMirrors(root), codec: fsMessageCodec },
    DEFAULT_CONFIG,
    { onStopped: () => undefined, pid: process.pid, epoch: 1, endpoint: 'test-endpoint', heartbeatAt: () => systemClock.now() },
  );
}

async function seeded(root: string): Promise<BrokerCore> {
  const core = makeCore(root);
  await core.recover();
  const init = await core.execute('init', 'client-a', 'claude', {
    command: { kind: 'init-session', task: 'user-channel', agents: ['claude', 'codex'], driver: 'claude' },
  });
  expect(init.ok).toBeTrue();
  return core;
}

const sink = (id: string, got: ObserverPushWire[] = []): ObserverSink => ({ id, sendObserver: async (push) => void got.push(push) });

describe('transport gate', () => {
  test('generic execute rejects user-channel kinds with a specific error, even forged as user', async () => {
    const core = await seeded(await tempRoot());
    const forged = await core.execute('forge', 'client-x', 'user', {
      command: { kind: 'user-message', groupId: 'g', recipients: [{ to: 'codex', messageId: 'm' }], body: 'fake' },
    });
    expect(forged.ok).toBeFalse();
    if (!forged.ok) expect(forged.error.code).toBe('user-channel-required');
    const forgedReg = await core.execute('forge2', 'client-x', 'user', { command: { kind: 'register-user-channel', tokenHash: 'h' } });
    expect(forgedReg.ok).toBeFalse();
    if (!forgedReg.ok) expect(forgedReg.error.code).toBe('user-channel-required');
  });
});

describe('user-attach', () => {
  test('TOFU registers through the journal (loud notices as inbox deliveries) and tags the connection', async () => {
    const core = await seeded(await tempRoot());
    const response = await core.userAttach('attach-1', sink('user-conn'), 'user-client', 'a'.repeat(64));
    expect(response.ok).toBeTrue();
    if (!response.ok) return;
    const snapshot = response.data as ObserverSnapshotDto;
    expect(snapshot.userChannel).toEqual({ registered: true, authenticated: true });
    expect(snapshot.session.userChannelTokenHash).toBeDefined();
    // Registration notices are ordinary open deliveries, one per agent.
    expect(core.journal.openDeliveriesFor('claude').length).toBe(1);
    expect(core.journal.openDeliveriesFor('codex').length).toBe(1);
  });

  test('malformed tokens are rejected before TOFU — no binding from empty/short tokens', async () => {
    const core = await seeded(await tempRoot());
    for (const bad of ['', 'short', 'Z'.repeat(64), 'a'.repeat(63)]) {
      const r = await core.userAttach(`bad-${bad.length}`, sink(`c-${bad.length}`), 'user-client', bad);
      expect(r.ok).toBeFalse();
      if (!r.ok) expect(r.error.code).toBe('user-auth-failed');
    }
    const status = await core.query('q', 'status');
    if (status.ok) expect((status.data as { session: { userChannelTokenHash?: string } }).session.userChannelTokenHash).toBeUndefined();
  });

  test('a reqId colliding with an unrelated recorded outcome fails loudly — never a silent tag (auth bypass fix)', async () => {
    const core = await seeded(await tempRoot());
    // 'init' + 'client-a' already has a recorded outcome from seeding.
    const collided = await core.userAttach('init', sink('sneaky'), 'client-a', 'f'.repeat(64));
    expect(collided.ok).toBeFalse();
    if (!collided.ok) expect(collided.error.code).toBe('user-auth-failed');
    // The connection must NOT be tagged: a user-send on it is rejected.
    const send = await core.userSend('s1', 'client-a', 'sneaky', '*', 'hi');
    expect(send.ok).toBeFalse();
    if (!send.ok) expect(send.error.code).toBe('user-channel-required');
  });

  test('wrong token after binding fails constant-time; correct token attaches; binding survives restart', async () => {
    const root = await tempRoot();
    const core = await seeded(root);
    expect((await core.userAttach('a1', sink('c1'), 'user-client', 'c'.repeat(64))).ok).toBeTrue();
    const wrong = await core.userAttach('a2', sink('c2'), 'user-client-2', 'd'.repeat(64));
    expect(wrong.ok).toBeFalse();
    if (!wrong.ok) expect(wrong.error.code).toBe('user-auth-failed');

    const reopened = makeCore(root);
    await reopened.recover(); // journal-authoritative: mirrors irrelevant
    const again = await reopened.userAttach('a3', sink('c3'), 'user-client-3', 'c'.repeat(64));
    expect(again.ok).toBeTrue();
    const stillWrong = await reopened.userAttach('a4', sink('c4'), 'user-client-4', 'd'.repeat(64));
    expect(stillWrong.ok).toBeFalse();
  });
});

describe('user-send', () => {
  test('requires a tagged connection (no token on the frame can substitute)', async () => {
    const core = await seeded(await tempRoot());
    await core.userAttach('a1', sink('user-conn'), 'user-client', 'e'.repeat(64));
    const untagged = await core.userSend('s1', 'user-client', 'other-conn', '*', 'hello');
    expect(untagged.ok).toBeFalse();
    if (!untagged.ok) expect(untagged.error.code).toBe('user-channel-required');
  });

  test('broadcast: one txn, unique per-recipient ids, groupId===reqId + provenance projected; dedup replays before allocation', async () => {
    const core = await seeded(await tempRoot());
    const observed: ObserverPushWire[] = [];
    await core.userAttach('a1', sink('user-conn', observed), 'user-client', 'e'.repeat(64));
    const first = await core.userSend('req-7', 'user-client', 'user-conn', '*', 'focus on tests');
    expect(first.ok).toBeTrue();
    // Registration notices are also from 'user' — key on the groupId.
    const open = core.journal.openDeliveries().filter((d) => d.message.groupId === 'req-7');
    expect(open.length).toBe(2);
    expect(new Set(open.map((d) => d.message.id)).size).toBe(2);
    for (const d of open) {
      expect(d.message.groupId).toBe('req-7');
      expect(d.message.provenance).toBe('trusted_user_client');
      expect(d.message.turn).toBe('keep');
    }
    const seqAfter = core.journal.headSeq;

    // Retry with the same (clientId, reqId): recorded outcome replayed,
    // nothing re-allocated or re-committed.
    const retry = await core.userSend('req-7', 'user-client', 'user-conn', '*', 'focus on tests');
    expect(retry.ok).toBeTrue();
    expect(core.journal.headSeq).toBe(seqAfter);
    expect(core.journal.openDeliveries().filter((d) => d.message.groupId === 'req-7').length).toBe(2);

    // The user connection saw its own send as committed activity (groupId
    // reconciliation path for the composer).
    const activity = observed.filter((p): p is Extract<ObserverPushWire, { kind: 'activity' }> => p.kind === 'activity');
    const sendActivity = activity.find((a) => a.events.some((e) => e.kind === 'message-sent' && e.from === 'user'));
    expect(sendActivity).toBeDefined();
  });

  test('two clients reusing the same reqId never collide in message ids', async () => {
    const core = await seeded(await tempRoot());
    await core.userAttach('a1', sink('conn-1'), 'user-client-1', 'e'.repeat(64));
    await core.userAttach('a2', sink('conn-2'), 'user-client-2', 'e'.repeat(64));
    await core.userSend('shared-req', 'user-client-1', 'conn-1', '*', 'from one');
    await core.userSend('shared-req', 'user-client-2', 'conn-2', '*', 'from two');
    const userMail = core.journal.openDeliveries().filter((d) => d.message.groupId === 'shared-req');
    expect(userMail.length).toBe(4); // both logical sends delivered in full
    expect(new Set(userMail.map((d) => d.message.id)).size).toBe(4); // no id collisions
  });

  test('restart replay of a committed user-send returns a complete outcome including session', async () => {
    const root = await tempRoot();
    const core = await seeded(root);
    await core.userAttach('a1', sink('conn-1'), 'user-client', 'e'.repeat(64));
    const first = await core.userSend('req-9', 'user-client', 'conn-1', 'codex', 'persist me');
    expect(first.ok).toBeTrue();

    const reopened = makeCore(root);
    await reopened.recover();
    await reopened.userAttach('a2', sink('conn-2'), 'user-client-2', 'e'.repeat(64));
    // Same identity replays the journaled outcome — it must be complete.
    const replayed = await reopened.userSend('req-9', 'user-client', 'conn-2', 'codex', 'persist me');
    expect(replayed.ok).toBeTrue();
    if (replayed.ok) {
      const data = replayed.data as { session?: { task?: string } };
      expect(data.session?.task).toBe('user-channel'); // not undefined after restart
    }
  });

  test('turn is never mutated by a user broadcast landing mid-exchange', async () => {
    const core = await seeded(await tempRoot());
    await core.execute('ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    await core.userAttach('a1', sink('user-conn'), 'user-client', 'e'.repeat(64));
    await core.userSend('s1', 'user-client', 'user-conn', '*', 'carry on');
    const status = await core.query('q1', 'status');
    expect(status.ok).toBeTrue();
    if (status.ok) expect((status.data as { session: { turn: string } }).session.turn).toBe('codex');
  });
});
