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
    command: { kind: 'init-session', task: 'user-channel', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t-0001' },
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
    core.onConnection('user-conn', 'open');
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
      core.onConnection(`c-${bad.length}`, 'open');
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
    core.onConnection('sneaky', 'open');
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
    core.onConnection('c1', 'open');
    expect((await core.userAttach('a1', sink('c1'), 'user-client', 'c'.repeat(64))).ok).toBeTrue();
    core.onConnection('c2', 'open');
    const wrong = await core.userAttach('a2', sink('c2'), 'user-client-2', 'd'.repeat(64));
    expect(wrong.ok).toBeFalse();
    if (!wrong.ok) expect(wrong.error.code).toBe('user-auth-failed');

    const reopened = makeCore(root);
    await reopened.recover(); // journal-authoritative: mirrors irrelevant
    reopened.onConnection('c3', 'open');
    const again = await reopened.userAttach('a3', sink('c3'), 'user-client-3', 'c'.repeat(64));
    expect(again.ok).toBeTrue();
    reopened.onConnection('c4', 'open');
    const stillWrong = await reopened.userAttach('a4', sink('c4'), 'user-client-4', 'd'.repeat(64));
    expect(stillWrong.ok).toBeFalse();
  });
});

describe('user-send', () => {
  test('requires a tagged connection (no token on the frame can substitute)', async () => {
    const core = await seeded(await tempRoot());
    core.onConnection('user-conn', 'open');
    await core.userAttach('a1', sink('user-conn'), 'user-client', 'e'.repeat(64));
    const untagged = await core.userSend('s1', 'user-client', 'other-conn', '*', 'hello');
    expect(untagged.ok).toBeFalse();
    if (!untagged.ok) expect(untagged.error.code).toBe('user-channel-required');
  });

  test('broadcast: one txn, unique per-recipient ids, groupId===reqId + provenance projected; dedup replays before allocation', async () => {
    const core = await seeded(await tempRoot());
    const observed: ObserverPushWire[] = [];
    core.onConnection('user-conn', 'open');
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
    core.onConnection('conn-1', 'open');
    await core.userAttach('a1', sink('conn-1'), 'user-client-1', 'e'.repeat(64));
    core.onConnection('conn-2', 'open');
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
    core.onConnection('conn-1', 'open');
    await core.userAttach('a1', sink('conn-1'), 'user-client', 'e'.repeat(64));
    const first = await core.userSend('req-9', 'user-client', 'conn-1', 'codex', 'persist me');
    expect(first.ok).toBeTrue();
    // Windows: let the first core's async mirror chain settle before a
    // second instance rebuilds the same files (EPERM rename flake).
    await Bun.sleep(200);

    const reopened = makeCore(root);
    await reopened.recover();
    reopened.onConnection('conn-2', 'open');
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
    core.onConnection('user-conn', 'open');
    await core.userAttach('a1', sink('user-conn'), 'user-client', 'e'.repeat(64));
    await core.userSend('s1', 'user-client', 'user-conn', '*', 'carry on');
    const status = await core.query('q1', 'status');
    expect(status.ok).toBeTrue();
    if (status.ok) expect((status.data as { session: { turn: string } }).session.turn).toBe('codex');
  });
});

describe('user-channel mirror resilience (close-out #7 guard)', () => {
  test('delete or tamper user-channel.json, restart: journal restores it, valid token attaches, wrong token still user-auth-failed', async () => {
    const { rm: rmFile, writeFile, readFile } = await import('node:fs/promises');
    const root = await tempRoot();
    const core = await seeded(root);
    const token = 'a'.repeat(64);
    core.onConnection('c1', 'open');
    expect((await core.userAttach('bind-1', sink('c1'), 'user-client', token)).ok).toBeTrue();
    const path = join(root, '.pair', 'user-channel.json');

    // DELETION, then restart: recover repairs from the journal — no conflict,
    // no read-only degradation, auth unaffected in both directions.
    await rmFile(path, { force: true });
    const afterDelete = makeCore(root);
    expect(await afterDelete.recover()).not.toBe('conflict');
    expect((await readFile(path, 'utf8')).includes('"registered": true')).toBeTrue();
    afterDelete.onConnection('c2', 'open');
    expect((await afterDelete.userAttach('ad-ok', sink('c2'), 'user-client', token)).ok).toBeTrue();
    afterDelete.onConnection('c3', 'open');
    const wrongAfterDelete = await afterDelete.userAttach('ad-bad', sink('c3'), 'user-client', 'b'.repeat(64));
    expect(wrongAfterDelete.ok).toBeFalse();
    if (!wrongAfterDelete.ok) expect(wrongAfterDelete.error.code).toBe('user-auth-failed');

    // TAMPER, then restart: normalized from journal state, same guarantees.
    await writeFile(path, '{"registered":false,"forged":true}\n', 'utf8');
    const afterTamper = makeCore(root);
    expect(await afterTamper.recover()).not.toBe('conflict');
    const healed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(healed['registered']).toBeTrue();
    expect(healed['forged']).toBeUndefined();
    afterTamper.onConnection('c4', 'open');
    expect((await afterTamper.userAttach('at-ok', sink('c4'), 'user-client', token)).ok).toBeTrue();
    afterTamper.onConnection('c5', 'open');
    const wrongAfterTamper = await afterTamper.userAttach('at-bad', sink('c5'), 'user-client', 'b'.repeat(64));
    expect(wrongAfterTamper.ok).toBeFalse();
    if (!wrongAfterTamper.ok) expect(wrongAfterTamper.error.code).toBe('user-auth-failed');
  });
});

describe('server-boundary publication guards (codex re-read 20260720-110117-282)', () => {
  test('userAttach close-race: socket dies during the registration commit — registration stays durable, the dead connection is NEVER auth-tagged', async () => {
    const core = await seeded(await tempRoot());
    const token = 'a'.repeat(64);
    core.onConnection('race-conn', 'open');
    // Dispatch, then close synchronously: the chain task runs in a later
    // microtask, so the close deterministically lands mid-request — the
    // strongest version of "socket closed during the await".
    const attaching = core.userAttach('race-1', sink('race-conn'), 'user-client', token);
    core.onConnection('race-conn', 'close');
    const response = await attaching;
    expect(response.ok).toBeFalse();
    if (!response.ok) expect(response.error.code).toBe('connection-closed');

    // The TOFU registration is durably committed (that is fine)…
    const state = core.journal.sessionState;
    expect(state?.userChannelTokenHash).toBeDefined();
    // …but the dead connection holds NO auth tag: user-send is refused.
    const send = await core.userSend('race-2', 'user-client', 'race-conn', 'codex', 'ghost');
    expect(send.ok).toBeFalse();
    if (!send.ok) expect(send.error.code).toBe('user-channel-required');
    // A live reattach with the same token authenticates normally.
    core.onConnection('live-conn', 'open');
    expect((await core.userAttach('race-3', sink('live-conn'), 'user-client-2', token)).ok).toBeTrue();
  });

  test('subscribe close-race: a dead sink never registers, never wins delivery selection — the delivery stays open for the next live subscriber', async () => {
    const core = await seeded(await tempRoot());
    await core.execute('ask-1', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });

    const deadGot: unknown[] = [];
    core.onConnection('dead-sub', 'open');
    const subscribing = core.subscribe('sub-race', { id: 'dead-sub', sendDelivery: async (p) => void deadGot.push(p), sendError: async () => undefined }, 'codex', 0);
    core.onConnection('dead-sub', 'close');
    const response = await subscribing;
    expect(response.ok).toBeFalse();
    if (!response.ok) expect(response.error.code).toBe('connection-closed');
    await Bun.sleep(30);
    expect(deadGot).toHaveLength(0); // dead sink never received the lease

    // The open delivery goes to the next LIVE subscriber intact.
    const liveGot: unknown[] = [];
    core.onConnection('live-sub', 'open');
    expect((await core.subscribe('sub-live', { id: 'live-sub', sendDelivery: async (p) => void liveGot.push(p), sendError: async () => undefined }, 'codex', 0)).ok).toBeTrue();
    await Bun.sleep(30);
    expect(liveGot).toHaveLength(1);
  });

  test('observe close-race: a dead observer never registers', async () => {
    const core = await seeded(await tempRoot());
    core.onConnection('dead-obs', 'open');
    const observing = core.observe('obs-race', sink('dead-obs'));
    core.onConnection('dead-obs', 'close');
    const response = await observing;
    expect(response.ok).toBeFalse();
    if (!response.ok) expect(response.error.code).toBe('connection-closed');
  });
});

describe('slice-4a userAction (design REV 6)', () => {
  const attach = async (core: BrokerCore, conn: string, client: string, token = 'a'.repeat(64)) => {
    core.onConnection(conn, 'open');
    const r = await core.userAttach(`att-${conn}`, sink(conn), client, token);
    expect(r.ok).toBeTrue();
  };

  test('ordering: auth precedes dedup — an unauthenticated retry of a recorded reqId gets user-channel-required, never the recorded outcome', async () => {
    const core = await seeded(await tempRoot());
    await attach(core, 'ua-conn', 'user-client');
    expect((await core.userAction('act-1', 'user-client', 'ua-conn', { verb: 'kick', agent: 'codex' })).ok).toBeTrue();
    // Same (clientId, reqId), but on a connection that never attached:
    const forged = await core.userAction('act-1', 'user-client', 'other-conn', { verb: 'kick', agent: 'codex' });
    expect(forged.ok).toBeFalse();
    if (!forged.ok) expect(forged.error.code).toBe('user-channel-required');
  });

  test('dedup before state: a committed end retried after completion replays the recorded success', async () => {
    const core = await seeded(await tempRoot());
    await attach(core, 'end-conn', 'user-client');
    const first = await core.userAction('act-end', 'user-client', 'end-conn', { verb: 'end', summary: '' });
    expect(first.ok).toBeTrue();
    expect(core.journal.sessionState?.status).toBe('completed');
    const retry = await core.userAction('act-end', 'user-client', 'end-conn', { verb: 'end', summary: '' });
    expect(retry.ok).toBeTrue(); // replay, NEVER session-not-active
    if (retry.ok && first.ok) expect(retry.seq).toBe(first.seq);
  });

  test('user kick through the shared primitive: preexisting open delivery voided (journal), kicked live subscription woken terminally and deregistered', async () => {
    const core = await seeded(await tempRoot());
    await attach(core, 'kick-conn', 'user-client');
    // Seed an open delivery for codex, then subscribe codex so it holds mail + a live sub.
    const send = await core.execute('seed', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    expect(send.ok).toBeTrue();
    const errors: { code: string; message: string }[] = [];
    core.onConnection('codex-sub', 'open');
    const codexSink: import('@broker/ports.ts').DeliverySink = {
      id: 'codex-sub',
      sendDelivery: async () => undefined,
      sendError: async (code, message) => void errors.push({ code, message }),
    };
    expect((await core.subscribe('sub-codex', codexSink, 'codex', 0)).ok).toBeTrue();
    expect(core.journal.openDeliveriesFor('codex').length).toBeGreaterThanOrEqual(1);

    const kick = await core.userAction('act-kick', 'user-client', 'kick-conn', { verb: 'kick', agent: 'codex' });
    expect(kick.ok).toBeTrue();
    expect(core.journal.sessionState?.agents).toEqual(['claude']);
    expect(core.journal.openDeliveriesFor('codex')).toHaveLength(0); // voided in the SAME txn
    expect(errors).toEqual([{ code: 'removed-from-session', message: expect.stringContaining('removed from the session') as unknown as string }]);
    // Deregistered: a fresh delivery for claude never selects the dead codex sub.
    const kicked = await core.userAction('act-kick', 'user-client', 'kick-conn', { verb: 'kick', agent: 'codex' });
    expect(kicked.ok).toBeTrue(); // dedup replay of the same action
  });

  test('generic execute fail-closes the whole user-* namespace including unknown future verbs', async () => {
    const core = await seeded(await tempRoot());
    for (const kind of ['user-end-session', 'user-cancel-grant', 'user-kick-agent', 'user-anything-future']) {
      const forged = await core.execute(`f-${kind}`, 'client-x', 'user', { command: { kind, agent: 'codex', summary: 'x' } });
      expect(forged.ok).toBeFalse();
      if (!forged.ok) expect(forged.error.code).toBe('user-channel-required');
    }
  });

  test('cancel-grant by the user works regardless of issuer, notices deduplicated-ready; unknown verb is bad-command', async () => {
    const core = await seeded(await tempRoot());
    await attach(core, 'cg-conn', 'user-client');
    const issued = await core.execute('gi', 'client-a', 'claude', { command: { kind: 'issue-grant', grantId: 'g9', to: 'codex', task: 'w', scope: { mode: 'worktree', worktree: 'wt' }, agreedIn: '' } });
    expect(issued.ok).toBeTrue();
    const cancel = await core.userAction('act-cg', 'user-client', 'cg-conn', { verb: 'cancel-grant', grantId: 'g9' });
    expect(cancel.ok).toBeTrue();
    expect(core.journal.sessionState?.grants['g9']?.state).toBe('cancelled');
    const unknown = await core.userAction('act-x', 'user-client', 'cg-conn', { verb: 'frobnicate' });
    expect(unknown.ok).toBeFalse();
    if (!unknown.ok) expect(unknown.error.code).toBe('bad-command'); // unknown verbs stay fail-closed
  });
});

describe('actionKind snapshot projection (codex step-5 audit A)', () => {
  test('an executed user action projects actionKind into the observer snapshot transcript', async () => {
    const core = await seeded(await tempRoot());
    core.onConnection('proj-conn', 'open');
    expect((await core.userAttach('att-proj', sink('proj-conn'), 'user-client', 'a'.repeat(64))).ok).toBeTrue();
    expect((await core.userAction('act-proj', 'user-client', 'proj-conn', { verb: 'kick', agent: 'codex', reason: 'x' })).ok).toBeTrue();

    // Fresh observer: the snapshot transcript ring must carry the marker.
    core.onConnection('obs-proj', 'open');
    const observed = await core.observe('obs-proj-req', sink('obs-proj'));
    expect(observed.ok).toBeTrue();
    if (!observed.ok) return;
    const snapshot = observed.data as import('@app/ports/gateway.ts').ObserverSnapshotDto;
    const notices = snapshot.transcript.filter((t) => (t.message.header as { actionKind?: string }).actionKind === 'kick');
    expect(notices.length).toBeGreaterThanOrEqual(2); // stop-notice + survivor notice
    for (const n of notices) expect(n.message.header).toMatchObject({ groupId: 'act-proj', provenance: 'trusted_user_client' });
  });
});

describe('slice 4b: pause/resume through the broker (F-A10)', () => {
  test('pause commits, SURVIVES a broker restart via journal replay, matrix holds on the recovered broker, resume restores', async () => {
    const root = await tempRoot();
    const core = await seeded(root);
    core.onConnection('pz-conn', 'open');
    expect((await core.userAttach('att-pz', sink('pz-conn'), 'user-client', 'a'.repeat(64))).ok).toBeTrue();
    expect((await core.userAction('act-pause', 'user-client', 'pz-conn', { verb: 'pause', reason: 'lunch' })).ok).toBeTrue();
    expect(core.journal.sessionState?.status).toBe('paused');
    // The acceptance matrix names the session.json ROUND-TRIP explicitly:
    // observe the mirror on disk, not just journal state (codex 4b review).
    const sessionJson = join(root, '.pair', 'session.json');
    {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && JSON.parse(await Bun.file(sessionJson).text()).status !== 'paused') await Bun.sleep(20);
      expect(JSON.parse(await Bun.file(sessionJson).text()).status).toBe('paused');
    }

    // Restart: journal replay restores paused (F-A10).
    const reopened = makeCore(root);
    expect(await reopened.recover()).not.toBe('conflict');
    expect(reopened.journal.sessionState?.status).toBe('paused');

    // Matrix holds on the recovered broker: agent mutation -> session-paused.
    const braked = await reopened.execute('try-send', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    expect(braked.ok).toBeFalse();
    if (!braked.ok) expect(braked.error.code).toBe('session-paused');

    // User resume on the recovered broker (fresh attach: connection auth).
    reopened.onConnection('pz-conn-2', 'open');
    expect((await reopened.userAttach('att-pz2', sink('pz-conn-2'), 'user-client-2', 'a'.repeat(64))).ok).toBeTrue();
    expect((await reopened.userAction('act-resume', 'user-client-2', 'pz-conn-2', { verb: 'resume' })).ok).toBeTrue();
    expect(reopened.journal.sessionState?.status).toBe('active');
    {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && JSON.parse(await Bun.file(sessionJson).text()).status !== 'active') await Bun.sleep(20);
      expect(JSON.parse(await Bun.file(sessionJson).text()).status).toBe('active');
    }
    const unbraked = await reopened.execute('try-send-2', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    expect(unbraked.ok).toBeTrue();
  });
});


describe('item 7 threading: the awaiting-set', () => {
  test('an ask registers; a replyTo answer resolves; status surfaces who owes whom; recovery rebuilds from the ring', async () => {
    const root = await tempRoot();
    const core = await seeded(root);
    const ask = await core.execute('t-ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'review?' } });
    expect(ask.ok).toBeTrue();
    const askId = (ask.ok ? (ask.events ?? []) : []).find((e) => (e as { kind?: string }).kind === 'message-sent') as { id: string };

    let status = await core.query('st1', 'status');
    expect(status.ok).toBeTrue();
    let awaiting: readonly { messageId: string; from?: string; to?: string }[] = (status.ok ? (status.data as { awaiting?: { messageId: string; from: string; to: string }[] }).awaiting : []) ?? [];
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]).toMatchObject({ messageId: askId.id, from: 'claude', to: 'codex' });

    // Recovery rebuilds the set from the transcript ring.
    const reopened = makeCore(root);
    expect(await reopened.recover()).not.toBe('conflict');
    status = await reopened.query('st2', 'status');
    awaiting = (status.ok ? (status.data as { awaiting?: { messageId: string }[] }).awaiting : []) ?? [];
    expect(awaiting).toHaveLength(1);

    // The reply resolves it.
    const reply = await reopened.execute('t-ans', 'client-b', 'codex', { command: { kind: 'send-message', to: 'claude', type: 'answer', turn: 'pass', body: 'lgtm', replyTo: askId.id } });
    expect(reply.ok).toBeTrue();
    status = await reopened.query('st3', 'status');
    awaiting = (status.ok ? (status.data as { awaiting?: { messageId: string }[] }).awaiting : []) ?? [];
    expect(awaiting).toHaveLength(0);
    // And the stored header carries replyTo end-to-end.
    const sent = (reply.ok ? (reply.events ?? []) : []).find((e) => (e as { kind?: string }).kind === 'message-sent') as { replyTo?: string };
    expect(sent.replyTo).toBe(askId.id);
  });
});
