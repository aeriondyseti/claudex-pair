import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerCore, DEFAULT_CONFIG } from '../../src/broker/server.ts';
import { FsMirrors, fsMessageCodec } from '../../src/adapters/fs/brokerMirrors.ts';
import { systemClock, systemIds } from '../../src/adapters/clock/index.ts';
import type { PeerSession } from '../../src/core/types.ts';

/**
 * Peer slice 2: barrier deadline timers + no-show paging (approved design —
 * .pair/memory.md "PEER 1B DESIGN" + "Slice 2"). Deadlines are ABSOLUTE
 * timestamps stored in state; the watcher is DERIVED from them (never an
 * in-memory-only schedule) so a restart re-arms correctly; EXPIRY NEVER
 * AUTO-ACTS — it pages the human (durable attention) and waits.
 */

const CRED = { claude: 'a'.repeat(64), codex: 'b'.repeat(64), agy: 'c'.repeat(64) };
/** Guaranteed-past under the shared UTC-interpreted parse, for any real
 * wall-clock this suite ever runs at. */
const PAST_DEADLINE = '2000-01-01 00:00:00';
const FUTURE_DEADLINE = '2099-01-01 00:00:00';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'claudex-peer-deadline-'));
}
function makeCore(root: string) {
  return new BrokerCore(
    join(root, '.pair'),
    { clock: systemClock, ids: systemIds, mirrors: new FsMirrors(root), codec: fsMessageCodec },
    DEFAULT_CONFIG,
    { onStopped: () => undefined, pid: process.pid, epoch: 3, endpoint: 'test-endpoint', heartbeatAt: () => systemClock.now() },
  );
}

const session = async (core: BrokerCore): Promise<PeerSession> => {
  const status = await core.query('st', 'status');
  if (!status.ok) throw new Error('status failed');
  return (status.data as { session: PeerSession }).session;
};
const pendingBodies = async (core: BrokerCore, agent: string): Promise<string[]> => {
  const status = await core.query('st', 'status');
  if (!status.ok) throw new Error('status failed');
  const pending = (status.data as { pending: Record<string, { body: string }[]> }).pending;
  return (pending[agent] ?? []).map((m) => m.body);
};

/** Peer init with an ADMITTING deadline already in the past (seeded via the
 * -DeadlineAt flag's command shape, init-session.deadlineAt). Only claude
 * attaches — codex/agy stay outstanding absentees. */
async function admittingPastDeadlineCore(root: string, expected: string[] = ['claude', 'codex']) {
  const core = makeCore(root);
  await core.recover();
  core.onConnection('conn-claude', 'open');
  const init = await core.execute('init-1', 'client-claude', 'claude', {
    command: { kind: 'init-session', task: 'peer', agents: expected, driver: 'claude', sessionId: 'session-deadline-01', topology: 'peer', deadlineAt: PAST_DEADLINE },
    credential: CRED.claude,
  }, 'conn-claude');
  expect(init.ok).toBeTrue();
  return core;
}

/** Full bootstrap to COLLECTING (no deadline yet — collecting.deadlineAt is
 * seeded only via a later wait ruling, per design). */
async function collectingCore(root: string, expected: string[] = ['claude', 'codex']) {
  const core = makeCore(root);
  await core.recover();
  core.onConnection('conn-claude', 'open');
  const init = await core.execute('init-1', 'client-claude', 'claude', {
    command: { kind: 'init-session', task: 'peer', agents: expected, driver: 'claude', sessionId: 'session-deadline-02', topology: 'peer' },
    credential: CRED.claude,
  }, 'conn-claude');
  expect(init.ok).toBeTrue();
  for (const agent of expected.filter((a) => a !== 'claude')) {
    core.onConnection(`conn-${agent}`, 'open');
    expect((await core.agentAttach(`at-${agent}`, `conn-${agent}`, `client-${agent}`, agent, CRED[agent as keyof typeof CRED])).ok).toBeTrue();
  }
  return core;
}

const userSink = { id: 'conn-user', sendObserver: async () => undefined };
async function attachUser(core: BrokerCore) {
  core.onConnection('conn-user', 'open');
  expect((await core.userAttach('uat-1', userSink, 'client-user', 'f'.repeat(64))).ok).toBeTrue();
}

describe('admitting substate: expiry pages, never acts', () => {
  test('past deadline -> one durable attention item + @broker notices to every current agent; no state transition', async () => {
    const core = await admittingPastDeadlineCore(await tempRoot());
    const before = await session(core);
    expect(before.planning?.substate).toBe('admitting');

    await core.runDeadlineSweepOnceForTest();
    const s = await session(core);
    if (s.planning?.substate !== 'admitting') throw new Error('shape');
    expect(s.planning.substate).toBe('admitting'); // PIN: no transition
    expect(s.planning.admitted).toEqual(before.planning?.substate === 'admitting' ? before.planning.admitted : []); // PIN: no auto-admit
    const items = s.attention.filter((a) => a.category === 'deadline-expired');
    expect(items).toHaveLength(1);
    expect(items[0]!.detail).toContain('admitting');
    expect(items[0]!.detail).toContain('codex'); // the outstanding absentee is named
    expect(items[0]!.detail).toContain('rule each with');

    // @broker notice reached the only current member (claude).
    const bodies = await pendingBodies(core, 'claude');
    expect(bodies.some((b) => b.includes('deadline expired'))).toBeTrue();
  });

  test('idempotent: a second tick raises no duplicate attention', async () => {
    const core = await admittingPastDeadlineCore(await tempRoot());
    await core.runDeadlineSweepOnceForTest();
    await core.runDeadlineSweepOnceForTest();
    const s = await session(core);
    expect(s.attention.filter((a) => a.category === 'deadline-expired')).toHaveLength(1);
  });

  test('a future deadline never raises', async () => {
    const core = makeCore(await tempRoot());
    await core.recover();
    core.onConnection('conn-claude', 'open');
    const init = await core.execute('init-1', 'client-claude', 'claude', {
      command: { kind: 'init-session', task: 'peer', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-deadline-03', topology: 'peer', deadlineAt: FUTURE_DEADLINE },
      credential: CRED.claude,
    }, 'conn-claude');
    expect(init.ok).toBeTrue();
    await core.runDeadlineSweepOnceForTest();
    const s = await session(core);
    expect(s.attention.filter((a) => a.category === 'deadline-expired')).toHaveLength(0);
  });

  test('attach and submissions still work after an expiry paged the human (no gating)', async () => {
    const core = await admittingPastDeadlineCore(await tempRoot());
    await core.runDeadlineSweepOnceForTest();
    core.onConnection('conn-codex', 'open');
    const attach = await core.agentAttach('at-1', 'conn-codex', 'client-codex', 'codex', CRED.codex);
    expect(attach.ok).toBeTrue(); // the LAST expected admission still atomically opens the barrier
    const s = await session(core);
    expect(s.planning?.substate).toBe('collecting');
  });

  test('a wait ruling with a FUTURE deadline clears the attention; a later tick with the new deadline stays quiet', async () => {
    const core = await admittingPastDeadlineCore(await tempRoot());
    await core.runDeadlineSweepOnceForTest();
    let s = await session(core);
    expect(s.attention.filter((a) => a.category === 'deadline-expired')).toHaveLength(1);

    await attachUser(core);
    const ruling = await core.userAction('ract-1', 'client-user', 'conn-user', { verb: 'rule-absentee', agent: 'codex', ruling: 'wait', newDeadlineAt: FUTURE_DEADLINE });
    expect(ruling.ok).toBeTrue();
    s = await session(core);
    expect(s.attention.filter((a) => a.category === 'deadline-expired')).toHaveLength(0); // cleared in the SAME ruling txn
    if (s.planning?.substate !== 'admitting') throw new Error('shape');
    expect(s.planning.deadlineAt).toBe(FUTURE_DEADLINE);

    await core.runDeadlineSweepOnceForTest();
    s = await session(core);
    expect(s.attention.filter((a) => a.category === 'deadline-expired')).toHaveLength(0); // still future: quiet
  });

  test('restart re-arms the watcher from journal/WAL timestamps and re-raises (no in-memory-only schedule)', async () => {
    const root = await tempRoot();
    const core = await admittingPastDeadlineCore(root);
    // Deliberately NEVER ticked before the restart — the watcher must not
    // rely on anything carried over from the old process.
    await core.quiesce();

    const reopened = makeCore(root);
    expect(await reopened.recover()).not.toBe('conflict');
    await reopened.runDeadlineSweepOnceForTest();
    const s = await session(reopened);
    const items = s.attention.filter((a) => a.category === 'deadline-expired');
    expect(items).toHaveLength(1);
    if (s.planning?.substate !== 'admitting') throw new Error('shape');
    expect(s.planning.substate).toBe('admitting'); // PIN: still no transition post-restart
  });
});

describe('collecting substate: expiry pages, never acts', () => {
  test('a wait ruling with a PAST deadline -> a tick pages the human; still collecting, submissions unaffected', async () => {
    const core = await collectingCore(await tempRoot());
    await attachUser(core);
    const ruling = await core.userAction('ract-1', 'client-user', 'conn-user', { verb: 'rule-absentee', agent: 'codex', ruling: 'wait', newDeadlineAt: PAST_DEADLINE });
    expect(ruling.ok).toBeTrue();
    let s = await session(core);
    if (s.planning?.substate !== 'collecting') throw new Error('shape');
    expect(s.planning.deadlineAt).toBe(PAST_DEADLINE);
    expect(s.attention.filter((a) => a.category === 'deadline-expired')).toHaveLength(0); // not yet ticked

    await core.runDeadlineSweepOnceForTest();
    s = await session(core);
    if (s.planning?.substate !== 'collecting') throw new Error('shape');
    expect(s.planning.substate).toBe('collecting'); // PIN: no transition, no auto-abstain
    expect(s.planning.abstained).toEqual([]);
    expect(s.planning.submitted).toEqual({});
    const items = s.attention.filter((a) => a.category === 'deadline-expired');
    expect(items).toHaveLength(1);
    expect(items[0]!.detail).toContain('collecting');
    expect(items[0]!.detail).toContain('claude'); // neither member submitted yet
    expect(items[0]!.detail).toContain('codex');

    // Idempotent: a second tick raises no duplicate.
    await core.runDeadlineSweepOnceForTest();
    s = await session(core);
    expect(s.attention.filter((a) => a.category === 'deadline-expired')).toHaveLength(1);

    // Submission still works post-expiry (no gating).
    const proposed = await core.execute('p-1', 'client-claude', 'claude', { command: { kind: 'propose', content: 'still works' } }, 'conn-claude');
    expect(proposed.ok).toBeTrue();
  });

  test('a completing (closing) abstain ruling clears the deadline-expired attention', async () => {
    const core = await collectingCore(await tempRoot());
    await attachUser(core);
    expect((await core.userAction('ract-1', 'client-user', 'conn-user', { verb: 'rule-absentee', agent: 'codex', ruling: 'wait', newDeadlineAt: PAST_DEADLINE })).ok).toBeTrue();
    await core.runDeadlineSweepOnceForTest();
    let s = await session(core);
    expect(s.attention.filter((a) => a.category === 'deadline-expired')).toHaveLength(1);

    // claude submits, then codex's abstain is the CLOSING ruling — it reveals
    // the barrier AND clears the expired-deadline attention in the same txn.
    expect((await core.execute('p-1', 'client-claude', 'claude', { command: { kind: 'propose', content: 'claude plan' } }, 'conn-claude')).ok).toBeTrue();
    const closing = await core.userAction('ract-2', 'client-user', 'conn-user', { verb: 'rule-absentee', agent: 'codex', ruling: 'abstain' });
    expect(closing.ok).toBeTrue();
    s = await session(core);
    expect(s.planning?.substate).toBe('converging'); // reveal completed
    expect(s.attention.filter((a) => a.category === 'deadline-expired')).toHaveLength(0);
  });
});
