import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { systemClock, systemIds } from '@adapters/clock/index.ts';
import { FsMirrors, fsMessageCodec } from '@adapters/fs/brokerMirrors.ts';
import type { DeliverySink, ObserverPushWire, ObserverSink } from '@broker/ports.ts';
import { BrokerCore, DEFAULT_CONFIG } from '@broker/server.ts';
import type { ObserverSnapshotDto } from '@app/ports/gateway.ts';

/**
 * Observer contract (TUI-UPGRADE-NOTES "Tests worth writing first"):
 * a watch observer receives ordered committed activity but never creates a
 * delivery lease, never acks/voids mail, never moves an agent cursor, and
 * never blocks revoke-turn as partner-active. Reattach = fresh snapshot.
 */

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'claudex-observer-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.pair'), { recursive: true });
  return root;
}

function makeCore(root: string, config: Partial<typeof DEFAULT_CONFIG> = {}) {
  return new BrokerCore(
    join(root, '.pair'),
    { clock: systemClock, ids: systemIds, mirrors: new FsMirrors(root), codec: fsMessageCodec },
    { ...DEFAULT_CONFIG, ...config },
    { onStopped: () => undefined, pid: process.pid, epoch: 3, endpoint: 'test-endpoint', heartbeatAt: () => systemClock.now() },
  );
}

function observerSink(id: string, got: ObserverPushWire[]): ObserverSink {
  return { id, sendObserver: async (push) => void got.push(push) };
}

function deliverySink(as: string, got: unknown[]): DeliverySink {
  return { id: `sink-${as}`, sendDelivery: async (push) => void got.push(push), sendError: async () => undefined };
}

async function seeded(root: string, config: Partial<typeof DEFAULT_CONFIG> = {}): Promise<BrokerCore> {
  const core = makeCore(root, config);
  await core.recover();
  const init = await core.execute('init', 'client-a', 'claude', {
    command: { kind: 'init-session', task: 'observe-me', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t-0001' },
  });
  expect(init.ok).toBeTrue();
  return core;
}

async function observe(core: BrokerCore, id: string, got: ObserverPushWire[]): Promise<ObserverSnapshotDto> {
  core.onConnection(id, 'open');
  const response = await core.observe(`obs-${id}`, observerSink(id, got));
  expect(response.ok).toBeTrue();
  if (!response.ok) throw new Error('unreachable');
  return response.data as ObserverSnapshotDto;
}

describe('observer attach', () => {
  test('snapshot carries session, authoritative head seq, broker identity, and liveness', async () => {
    const core = await seeded(await tempRoot());
    const snapshot = await observe(core, 'o1', []);
    expect(snapshot.session.task).toBe('observe-me');
    expect(snapshot.seq).toBe(1); // init is the only commit
    expect(snapshot.broker.epoch).toBe(3);
    expect(snapshot.broker.endpoint).toBe('test-endpoint');
    expect(snapshot.liveness.agents).toEqual({});
    expect(snapshot.transcript).toEqual([]);
  });

  test('snapshot transcript shows open deliveries as pending and acked mail as archived, no duplicates', async () => {
    const core = await seeded(await tempRoot());
    await core.execute('ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q1' } });
    // codex consumes it (subscribe → lease → ack), then a second one stays open.
    const got: { deliveryId?: string }[] = [];
    core.onConnection('sink-codex', 'open');
    await core.subscribe('sub1', deliverySink('codex', got), 'codex', 0);
    await Bun.sleep(50);
    await core.ack('a1', got[0]!.deliveryId!, 'client-b');
    const reply = await core.execute('answer', 'client-b', 'codex', { command: { kind: 'send-message', to: 'claude', type: 'answer', turn: 'pass', body: 'a1' } });
    expect(reply.ok).toBeTrue();
    core.onConnection('sink-codex', 'close');

    const snapshot = await observe(core, 'o1', []);
    const byBody = (body: string) => snapshot.transcript.filter((e) => e.message.body === body);
    expect(byBody('q1').length).toBe(1);
    expect(byBody('q1')[0]!.pending).toBeFalse(); // acked → archived, exactly once
    expect(byBody('a1').length).toBe(1);
    expect(byBody('a1')[0]!.pending).toBeTrue(); // never delivered
  });
});

describe('observer non-interference', () => {
  test('an attached observer creates no lease: revoke-turn is NOT blocked as partner-active', async () => {
    const core = await seeded(await tempRoot());
    await core.execute('ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    await observe(core, 'watcher', []);
    // No codex subscription exists; only the observer is attached. If the
    // observer were a subscriber it would hold the lease and reject this.
    const revoke = await core.execute('revoke', 'client-a', 'claude', { command: { kind: 'revoke-turn', reason: 'gone' } });
    expect(revoke.ok).toBeTrue();
  });

  test('observer does not consume agent deliveries: the agent still receives and acks its own mail', async () => {
    const core = await seeded(await tempRoot());
    await observe(core, 'watcher', []);
    await core.execute('ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    const got: { deliveryId?: string }[] = [];
    core.onConnection('sink-codex', 'open');
    await core.subscribe('sub1', deliverySink('codex', got), 'codex', 0);
    await Bun.sleep(50);
    expect(got.length).toBe(1); // delivery reached the agent, not the observer
    const ack = await core.ack('a1', got[0]!.deliveryId!, 'client-b');
    expect(ack.ok).toBeTrue();
  });

  test('observer is invisible to agent liveness', async () => {
    const core = await seeded(await tempRoot());
    const snapshot = await observe(core, 'watcher', []);
    expect(Object.keys(snapshot.liveness.agents)).toEqual([]);
  });
});

describe('observer activity stream', () => {
  test('commits arrive in order with post-commit session state; acks flip pending; voids are labeled', async () => {
    const core = await seeded(await tempRoot());
    const got: ObserverPushWire[] = [];
    await observe(core, 'watcher', got);

    await core.execute('ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    const agentGot: { deliveryId?: string }[] = [];
    core.onConnection('sink-codex', 'open');
    await core.subscribe('sub1', deliverySink('codex', agentGot), 'codex', 0);
    await Bun.sleep(50);
    await core.ack('a1', agentGot[0]!.deliveryId!, 'client-b');
    await Bun.sleep(50);

    const activity = got.filter((p): p is Extract<ObserverPushWire, { kind: 'activity' }> => p.kind === 'activity');
    expect(activity.length).toBe(2); // send commit + ack txn
    const seqs = activity.map((a) => a.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs); // ordered
    expect(activity[0]!.events.some((e) => e.kind === 'message-sent')).toBeTrue();
    expect(activity[0]!.session.turn).toBe('codex'); // post-commit state rides along
    expect(activity[1]!.events).toEqual([]);
    expect(activity[1]!.ackedDeliveryIds.length).toBe(1);

    const presence = got.filter((p) => p.kind === 'presence');
    expect(presence.length).toBeGreaterThan(0); // listener appeared
  });

  test('roster removal streams voided delivery ids (kick voids undelivered mail)', async () => {
    const core = await seeded(await tempRoot());
    await core.execute('ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'unread' } });
    const got: ObserverPushWire[] = [];
    await observe(core, 'watcher', got);
    await core.execute('kick', 'client-a', 'claude', { command: { kind: 'kick-agent', agent: 'codex', reason: 'stalled' } });
    await Bun.sleep(50);
    const activity = got.filter((p): p is Extract<ObserverPushWire, { kind: 'activity' }> => p.kind === 'activity');
    const withVoids = activity.find((a) => a.voidedDeliveryIds.length > 0);
    expect(withVoids).toBeDefined();
    expect(withVoids!.session.agents).toEqual(['claude']);
  });

  test('a dead observer is dropped, not retried, and never wedges the commit path', async () => {
    const core = await seeded(await tempRoot());
    const dead: ObserverSink = { id: 'dead', sendObserver: async () => { throw new Error('gone'); } };
    core.onConnection('dead', 'open');
    expect((await core.observe('obs-dead', dead)).ok).toBeTrue();
    const send = await core.execute('ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    expect(send.ok).toBeTrue();
    await Bun.sleep(50);
    // Subsequent commits still work with the dead observer evicted.
    const revoke = await core.execute('revoke', 'client-a', 'claude', { command: { kind: 'revoke-turn', reason: 'x' } });
    expect(revoke.ok).toBeTrue();
  });

  test('reattach serves a fresh snapshot at the new head — no replay, no duplicates', async () => {
    const core = await seeded(await tempRoot());
    const first: ObserverPushWire[] = [];
    const snapshot1 = await observe(core, 'watcher', first);
    await core.execute('ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    await Bun.sleep(50);
    core.onConnection('watcher', 'close'); // watch pane died

    const second: ObserverPushWire[] = [];
    const snapshot2 = await observe(core, 'watcher-2', second);
    expect(snapshot2.seq).toBe(snapshot1.seq + 1);
    expect(snapshot2.transcript.filter((e) => e.message.body === 'q').length).toBe(1);
    expect(second.filter((p) => p.kind === 'activity').length).toBe(0); // nothing replayed
  });

  test('ack activity never overtakes the send activity it acknowledges, even with slow mirror IO', async () => {
    // Codex live review: execute fan-out formerly rode the mirror chain
    // while ack fan-out fired immediately — seq N+1 could beat seq N. The
    // fix emits all activity synchronously at commit; slow mirrors must
    // not reorder anything.
    const root = await tempRoot();
    const slow = new FsMirrors(root);
    const applyEvents = slow.applyEvents.bind(slow);
    slow.applyEvents = async (...args: Parameters<FsMirrors['applyEvents']>) => {
      await Bun.sleep(150); // mirror IO lags every commit
      return applyEvents(...args);
    };
    const core = new BrokerCore(
      join(root, '.pair'),
      { clock: systemClock, ids: systemIds, mirrors: slow, codec: fsMessageCodec },
      DEFAULT_CONFIG,
      { onStopped: () => undefined, pid: process.pid, epoch: 3, endpoint: 'test-endpoint', heartbeatAt: () => systemClock.now() },
    );
    await core.recover();
    await core.execute('init', 'client-a', 'claude', { command: { kind: 'init-session', task: 'slow-mirrors', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t-0001' } });
    const got: ObserverPushWire[] = [];
    await observe(core, 'watcher', got);
    await core.execute('ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'q' } });
    const agentGot: { deliveryId?: string }[] = [];
    core.onConnection('sink-codex', 'open');
    await core.subscribe('sub1', deliverySink('codex', agentGot), 'codex', 0);
    // The delivery push rides the (slow) mirror chain; wait for it.
    for (let i = 0; i < 40 && agentGot.length === 0; i++) await Bun.sleep(50);
    expect(agentGot.length).toBe(1);
    await core.ack('a1', agentGot[0]!.deliveryId!, 'client-b');

    const activity = got.filter((p): p is Extract<ObserverPushWire, { kind: 'activity' }> => p.kind === 'activity');
    const seqs = activity.map((a) => a.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs); // strict commit order
    const sendIndex = activity.findIndex((a) => a.events.some((e) => e.kind === 'message-sent'));
    const ackIndex = activity.findIndex((a) => a.ackedDeliveryIds.length > 0);
    expect(sendIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeGreaterThan(sendIndex); // ack never overtakes send
  }, 15_000);

  test('observe on an empty journal is rejected session-not-active', async () => {
    const core = makeCore(await tempRoot());
    await core.recover();
    core.onConnection('o', 'open');
    const response = await core.observe('obs-none', observerSink('o', []));
    expect(response.ok).toBeFalse();
    if (!response.ok) expect(response.error.code).toBe('session-not-active');
  });
});

describe('observer restart correctness (codex review round 2)', () => {
  test('transcript ring survives snapshot + restart: acked history and open mail both visible', async () => {
    const root = await tempRoot();
    const core = await seeded(root);
    await core.execute('ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'consumed' } });
    const got: { deliveryId?: string }[] = [];
    core.onConnection('sink-codex', 'open');
    await core.subscribe('sub1', deliverySink('codex', got), 'codex', 0);
    await Bun.sleep(50);
    await core.ack('a1', got[0]!.deliveryId!, 'client-b');
    await core.execute('answer', 'client-b', 'codex', { command: { kind: 'send-message', to: 'claude', type: 'answer', turn: 'pass', body: 'still-open' } });
    await core.journal.snapshot(); // compaction trims replayable history

    const reopened = makeCore(root);
    await reopened.recover();
    const snapshot = await observe(reopened, 'o2', []);
    const consumed = snapshot.transcript.filter((e) => e.message.body === 'consumed');
    const open = snapshot.transcript.filter((e) => e.message.body === 'still-open');
    expect(consumed.length).toBe(1);
    expect(consumed[0]!.pending).toBeFalse();
    expect(open.length).toBe(1);
    expect(open[0]!.pending).toBeTrue();
  });

  test('legacy snapshot without a transcript ring seeds from openDeliveries: open mail never invisible', async () => {
    const root = await tempRoot();
    const core = await seeded(root);
    await core.execute('ask', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'ask', turn: 'pass', body: 'unread' } });
    await core.journal.snapshot();
    const snapshotPath = join(root, '.pair', 'journal', 'snapshot.json');
    const legacy = JSON.parse(await Bun.file(snapshotPath).text()) as Record<string, unknown>;
    delete legacy['transcript']; // pre-ring snapshot format
    await Bun.write(snapshotPath, JSON.stringify(legacy));

    const reopened = makeCore(root);
    await reopened.recover();
    const snapshot = await observe(reopened, 'o3', []);
    const unread = snapshot.transcript.filter((e) => e.message.body === 'unread');
    expect(unread.length).toBe(1);
    expect(unread[0]!.pending).toBeTrue();
  });
});

describe('transcript ring cap (codex review round 2)', () => {
  test('cap evicts closed history only — open mail is always fully retained, even past the cap', async () => {
    const root = await tempRoot();
    let n = 0;
    const core = new BrokerCore(
      join(root, '.pair'),
      { clock: systemClock, ids: { messageId: () => `m${String(++n).padStart(4, '0')}` }, mirrors: new FsMirrors(root), codec: fsMessageCodec },
      DEFAULT_CONFIG,
      { onStopped: () => undefined, pid: process.pid, epoch: 3, endpoint: 'test-endpoint', heartbeatAt: () => systemClock.now() },
    );
    await core.recover();
    await core.execute('init', 'client-a', 'claude', { command: { kind: 'init-session', task: 'cap', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t-0001' } });
    for (let i = 0; i < 210; i++) {
      const r = await core.execute(`send-${i}`, 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'info', turn: 'keep', body: `q${i}` } });
      expect(r.ok).toBeTrue();
    }
    // 210 open messages with a cap of 200: nothing may be dropped.
    let snapshot = await observe(core, 'cap-1', []);
    expect(snapshot.transcript.length).toBe(210);
    expect(snapshot.transcript.every((e) => e.pending)).toBeTrue();
    core.onConnection('cap-1', 'close');

    // Close 15, then one more send triggers eviction of CLOSED entries only.
    const openIds = core.journal.openDeliveries().slice(0, 15).map((d) => d.deliveryId);
    for (const [i, id] of openIds.entries()) await core.ack(`ack-${i}`, id, 'client-b');
    await core.execute('send-final', 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'info', turn: 'keep', body: 'final' } });
    snapshot = await observe(core, 'cap-2', []);
    expect(snapshot.transcript.length).toBe(200); // trimmed back to cap
    expect(snapshot.transcript.filter((e) => e.pending).length).toBe(196); // 195 survivors + final, none evicted
  }, 30_000);

  test('acks alone trim the ring — no later send required (codex round 3)', async () => {
    const root = await tempRoot();
    let n = 0;
    const core = new BrokerCore(
      join(root, '.pair'),
      { clock: systemClock, ids: { messageId: () => `t${String(++n).padStart(4, '0')}` }, mirrors: new FsMirrors(root), codec: fsMessageCodec },
      DEFAULT_CONFIG,
      { onStopped: () => undefined, pid: process.pid, epoch: 3, endpoint: 'test-endpoint', heartbeatAt: () => systemClock.now() },
    );
    await core.recover();
    await core.execute('init', 'client-a', 'claude', { command: { kind: 'init-session', task: 'trim', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t-0001' } });
    for (let i = 0; i < 210; i++) {
      await core.execute(`send-${i}`, 'client-a', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'info', turn: 'keep', body: `q${i}` } });
    }
    const openIds = core.journal.openDeliveries().slice(0, 15).map((d) => d.deliveryId);
    for (const [i, id] of openIds.entries()) await core.ack(`ack-${i}`, id, 'client-b');
    // NO further send: the ack transitions themselves must trim.
    const snapshot = await observe(core, 'trim-1', []);
    expect(snapshot.transcript.length).toBe(200);
    expect(snapshot.transcript.filter((e) => e.pending).length).toBe(195); // every open record retained
  }, 30_000);
});

describe('observer idle semantics', () => {
  test('an attached observer does not pin the daemon against idle exit; a participant does', async () => {
    const root = await tempRoot();
    let stoppedIdle = 0;
    const core = new BrokerCore(
      join(root, '.pair'),
      { clock: systemClock, ids: systemIds, mirrors: new FsMirrors(root), codec: fsMessageCodec },
      { ...DEFAULT_CONFIG, idleGraceMs: 1_000 },
      { onStopped: (reason) => { if (reason === 'idle') stoppedIdle += 1; }, pid: process.pid, epoch: 3, endpoint: 'test-endpoint', heartbeatAt: () => systemClock.now() },
    );
    await core.recover();
    await core.execute('init', 'client-a', 'claude', { command: { kind: 'init-session', task: 'idle', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t-0001' } });
    // Observer-only connection: must NOT count as busyness.
    core.onConnection('watch-conn', 'open');
    const watchSink: ObserverSink = { id: 'watch-conn', sendObserver: async () => undefined };
    expect((await core.observe('obs', watchSink)).ok).toBeTrue();
    core.startIdleMonitor();
    for (let i = 0; i < 60 && stoppedIdle === 0; i++) await Bun.sleep(50);
    core.stopIdleMonitor();
    expect(stoppedIdle).toBeGreaterThan(0); // idle fired despite the observer

    // Control: a participant subscription DOES pin the broker.
    let stoppedIdle2 = 0;
    const root2 = await tempRoot();
    const core2 = new BrokerCore(
      join(root2, '.pair'),
      { clock: systemClock, ids: systemIds, mirrors: new FsMirrors(root2), codec: fsMessageCodec },
      { ...DEFAULT_CONFIG, idleGraceMs: 1_000 },
      { onStopped: (reason) => { if (reason === 'idle') stoppedIdle2 += 1; }, pid: process.pid, epoch: 3, endpoint: 'test-endpoint', heartbeatAt: () => systemClock.now() },
    );
    await core2.recover();
    await core2.execute('init', 'client-a', 'claude', { command: { kind: 'init-session', task: 'busy', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-t-0001' } });
    core2.onConnection('sub-conn', 'open');
    await core2.subscribe('sub', { id: 'sub-conn', sendDelivery: async () => undefined, sendError: async () => undefined }, 'codex', 0);
    core2.startIdleMonitor();
    await Bun.sleep(1_800);
    core2.stopIdleMonitor();
    expect(stoppedIdle2).toBe(0); // participant connection keeps it alive
  }, 15_000);
});


describe('M1: registry-updated reaches activity subscribers with the post-state version', () => {
  test('one registry-updated per membership commit; version equals status registry version', async () => {
    const core = await seeded(await tempRoot());
    const got: ObserverPushWire[] = [];
    await observe(core, 'obs-m1', got);

    const r = await core.execute('t-join', 'client-a', 'claude', { command: { kind: 'join-session', agent: 'agy', meta: { display: 'Antigravity' } } });
    expect(r.ok).toBeTrue();

    const activity = got.filter((p): p is Extract<ObserverPushWire, { kind: 'activity' }> => p.kind === 'activity');
    const regEvents = activity.flatMap((a) => a.events.filter((e) => e.kind === 'registry-updated'));
    expect(regEvents).toHaveLength(1);

    const status = await core.query('st-m1', 'status');
    expect(status.ok).toBeTrue();
    const session = (status.ok ? (status.data as { session: { registry: { version: number; agents: Record<string, { display: string }> } } }).session : undefined)!;
    expect((regEvents[0] as { version: number }).version).toBe(session.registry.version);
    expect(session.registry.agents['agy']!.display).toBe('Antigravity');
  });
});


describe('M1 round 3: direct broker init without sessionId is rejected, nothing created', () => {
  test('typed invalid-session-id; no journal record, no session', async () => {
    const core = makeCore(await tempRoot());
    expect(await core.recover()).not.toBe('conflict');
    const r = await core.execute('init-x', 'client-x', 'claude', {
      command: { kind: 'init-session', task: 'no-id', agents: ['claude', 'codex'], driver: 'claude' },
    });
    expect(r.ok).toBeFalse();
    expect((r as { error?: { code?: string } }).error?.code).toBe('invalid-session-id');
    const status = await core.query('st-x', 'status');
    expect(status.ok).toBeFalse(); // no session was created
    expect((status as { error?: { code?: string } }).error?.code).toBe('session-not-active');
  });
});
