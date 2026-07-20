import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerCore, DEFAULT_CONFIG } from '../../src/broker/server.ts';
import { FsMirrors, fsMessageCodec } from '../../src/adapters/fs/brokerMirrors.ts';
import { systemClock, systemIds } from '../../src/adapters/clock/index.ts';
import type { PeerSession } from '../../src/core/types.ts';

/** Peer 1B-a: sealed store, propose, collecting rulings, atomic reveal,
 * PlanningArtifacts durable discriminant + query (approved design rev 4). */

const CRED = { claude: 'a'.repeat(64), codex: 'b'.repeat(64), agy: 'c'.repeat(64) };
const BODY = { claude: 'claude plan:\r\nCRLF survives byte-exact\r\n', codex: 'codex plan: do it differently\n' };

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'claudex-peer-collect-'));
}
function makeCore(root: string) {
  return new BrokerCore(
    join(root, '.pair'),
    { clock: systemClock, ids: systemIds, mirrors: new FsMirrors(root), codec: fsMessageCodec },
    DEFAULT_CONFIG,
    { onStopped: () => undefined, pid: process.pid, epoch: 3, endpoint: 'test-endpoint', heartbeatAt: () => systemClock.now() },
  );
}
/** Full bootstrap to COLLECTING: peer init + all expected attached. */
async function collectingCore(root: string, expected: string[] = ['claude', 'codex']) {
  const core = makeCore(root);
  await core.recover();
  core.onConnection('conn-claude', 'open');
  const init = await core.execute('init-1', 'client-claude', 'claude', {
    command: { kind: 'init-session', task: 'peer', agents: expected, driver: 'claude', sessionId: 'session-collect-01', topology: 'peer' },
    credential: CRED.claude,
  }, 'conn-claude');
  expect(init.ok).toBeTrue();
  for (const agent of expected.filter((a) => a !== 'claude')) {
    core.onConnection(`conn-${agent}`, 'open');
    expect((await core.agentAttach(`at-${agent}`, `conn-${agent}`, `client-${agent}`, agent, CRED[agent as keyof typeof CRED])).ok).toBeTrue();
  }
  return core;
}
const session = async (core: BrokerCore): Promise<PeerSession> => {
  const status = await core.query('st', 'status');
  if (!status.ok) throw new Error('status failed');
  return (status.data as { session: PeerSession }).session;
};
const propose = (core: BrokerCore, agent: string, content: string, reqId: string) =>
  core.execute(reqId, `client-${agent}`, agent, { command: { kind: 'propose', content } }, `conn-${agent}`);

describe('sealed submission + secrecy', () => {
  test('the body lives ONLY in record.sealed; events/outcome/status/artifacts-query stay blind; CRLF hashes byte-exact', async () => {
    const root = await tempRoot();
    const core = await collectingCore(root);
    const r = await propose(core, 'claude', BODY.claude, 'p-1');
    expect(r.ok).toBeTrue();
    expect(JSON.stringify((r as { events?: unknown[] }).events)).not.toContain('CRLF survives');

    const s = await session(core);
    if (s.planning?.substate !== 'collecting') throw new Error('shape');
    expect(s.planning.submitted['claude']).toMatchObject({ bytes: Buffer.byteLength(BODY.claude, 'utf8') });
    expect(JSON.stringify(s)).not.toContain('CRLF survives');

    const q = await core.query('qa-1', 'planning-artifacts');
    expect((q as { data?: { phase?: string } }).data?.phase).toBe('sealed');
    expect(JSON.stringify(q)).not.toContain('CRLF survives');

    await core.quiesce();
    const dir = join(root, '.pair', 'journal');
    const segments = (await readdir(dir)).filter((n) => n.startsWith('segment-'));
    let sealedSeen = 0;
    for (const seg of segments) {
      for (const line of (await readFile(join(dir, seg), 'utf8')).split('\n').filter(Boolean)) {
        const record = JSON.parse(line) as { sealed?: Record<string, { body: string }>; [k: string]: unknown };
        const { sealed, ...publicParts } = record;
        expect(JSON.stringify(publicParts)).not.toContain('CRLF survives');
        if (sealed && Object.values(sealed).some((b) => b.body.includes('CRLF survives'))) sealedSeen += 1;
      }
    }
    expect(sealedSeen).toBe(1); // exactly one sealed home
  });

  test('a restart mid-collecting preserves sealed bodies; the eventual reveal serves them byte-exact', async () => {
    const root = await tempRoot();
    const core = await collectingCore(root);
    expect((await propose(core, 'claude', BODY.claude, 'p-1')).ok).toBeTrue();
    await core.quiesce();

    const reopened = makeCore(root);
    expect(await reopened.recover()).not.toBe('conflict');
    reopened.onConnection('conn-codex', 'open');
    expect((await reopened.agentAttach('re-at', 'conn-codex', 'client-codex', 'codex', CRED.codex)).ok).toBeTrue();
    const closing = await propose(reopened, 'codex', BODY.codex, 'p-2');
    expect(closing.ok).toBeTrue();

    const q = await reopened.query('qa-2', 'planning-artifacts');
    const data = (q as { data?: { phase?: string; proposals?: Record<string, { body: string }> } }).data;
    expect(data?.phase).toBe('revealed');
    expect(data?.proposals?.['claude']?.body).toBe(BODY.claude); // byte-exact incl. CRLF
    expect(data?.proposals?.['codex']?.body).toBe(BODY.codex);
  });
});

describe('atomic reveal: both closing paths, @broker provenance, deterministic identity', () => {
  test('the closing SUBMISSION appends barrier-revealed + one manifest notice per agent from @broker', async () => {
    const core = await collectingCore(await tempRoot());
    expect((await propose(core, 'claude', BODY.claude, 'p-1')).ok).toBeTrue();
    const closing = await propose(core, 'codex', BODY.codex, 'p-2');
    const events = (closing as { events?: { kind: string; from?: string; to?: string; id?: string; type?: string; provenance?: string; body?: string }[] }).events ?? [];
    expect(events.map((e) => e.kind)).toEqual(['proposal-submitted', 'barrier-revealed', 'message-sent', 'message-sent']);
    const notices = events.filter((e) => e.kind === 'message-sent');
    expect(notices.every((n) => n.from === '@broker' && n.type === 'proposal' && n.provenance === 'broker')).toBeTrue();
    expect(notices.map((n) => n.to)).toEqual(['claude', 'codex']); // registry order
    expect(new Set(notices.map((n) => n.id)).size).toBe(2); // deterministic distinct ids
    expect(notices[0]!.body).toContain('pair artifacts');
    expect(notices[0]!.body).not.toContain('CRLF survives'); // manifest, never bodies

    const s = await session(core);
    expect(s.planning?.substate).toBe('converging');
    const status = await core.query('st-aw', 'status');
    expect(((status as { data?: { awaiting?: unknown[] } }).data?.awaiting ?? []).length).toBe(0); // notices never register debts
  });

  test('the closing ABSTAIN ruling reveals with identical provenance; the abstained member is excluded from the electorate', async () => {
    const core = await collectingCore(await tempRoot(), ['claude', 'codex', 'agy']);
    expect((await propose(core, 'claude', BODY.claude, 'p-1')).ok).toBeTrue();
    expect((await propose(core, 'codex', BODY.codex, 'p-2')).ok).toBeTrue();
    core.onConnection('conn-user', 'open');
    expect((await core.userAttach('uat-1', { id: 'conn-user', sendObserver: async () => undefined }, 'client-user', 'f'.repeat(64))).ok).toBeTrue();
    const ruling = await core.userAction('ract-1', 'client-user', 'conn-user', { verb: 'rule-absentee', agent: 'agy', ruling: 'abstain' });
    expect(ruling.ok).toBeTrue();
    const events = (ruling as { events?: { kind: string; from?: string; electorate?: string[] }[] }).events ?? [];
    const revealed = events.find((e) => e.kind === 'barrier-revealed') as { electorate?: string[] } | undefined;
    expect(revealed?.electorate).toEqual(['claude', 'codex']);
    expect(events.filter((e) => e.kind === 'message-sent' && e.from === '@broker').length).toBeGreaterThan(0);
    const q = await core.query('qa-3', 'planning-artifacts');
    expect(Object.keys((q as { data?: { proposals?: object } }).data?.proposals ?? {})).toEqual(['claude', 'codex']);
  });
});

describe('Ruling A + artifact lifecycle discriminant', () => {
  test('empty-electorate rejection commits NOTHING and the same reqId re-evaluates', async () => {
    const core = await collectingCore(await tempRoot());
    core.onConnection('conn-user', 'open');
    expect((await core.userAttach('uat-1', { id: 'conn-user', sendObserver: async () => undefined }, 'client-user', 'f'.repeat(64))).ok).toBeTrue();
    expect((await core.userAction('r-1', 'client-user', 'conn-user', { verb: 'rule-absentee', agent: 'claude', ruling: 'abstain' })).ok).toBeTrue();

    const before = await core.query('st-b', 'status');
    const headBefore = (before as { seq?: number }).seq;
    const reject = await core.userAction('r-2', 'client-user', 'conn-user', { verb: 'rule-absentee', agent: 'codex', ruling: 'abstain' });
    expect((reject as { error?: { code?: string } }).error?.code).toBe('empty-electorate');
    const after = await core.query('st-a', 'status');
    expect(JSON.stringify((after as { data?: unknown }).data)).toBe(JSON.stringify((before as { data?: unknown }).data));
    void headBefore;

    // Same reqId, DIFFERENT (valid) action: re-evaluated, not replayed.
    const retried = await core.userAction('r-2', 'client-user', 'conn-user', { verb: 'rule-absentee', agent: 'codex', ruling: 'wait', newDeadlineAt: '2026-07-21 09:00:00' });
    expect(retried.ok).toBeTrue();
  });

  test("force-phase from collecting: sealed purged, phase 'discarded' STICKS through completion", async () => {
    const root = await tempRoot();
    const core = await collectingCore(root);
    expect((await propose(core, 'claude', BODY.claude, 'p-1')).ok).toBeTrue();
    core.onConnection('conn-user', 'open');
    expect((await core.userAttach('uat-1', { id: 'conn-user', sendObserver: async () => undefined }, 'client-user', 'f'.repeat(64))).ok).toBeTrue();
    expect((await core.userAction('force-1', 'client-user', 'conn-user', { verb: 'force-phase', to: 'provisioning' })).ok).toBeTrue();

    const q = await core.query('qa-4', 'planning-artifacts');
    expect((q as { data?: { phase?: string } }).data?.phase).toBe('discarded');
    expect(JSON.stringify(q)).not.toContain('CRLF survives');

    expect((await core.userAction('end-1', 'client-user', 'conn-user', { verb: 'end', summary: 'done' })).ok).toBeTrue();
    const q2 = await core.query('qa-5', 'planning-artifacts');
    expect((q2 as { data?: { phase?: string } }).data?.phase).toBe('discarded'); // durable discriminant

    await core.quiesce();
    const reopened = makeCore(root);
    expect(await reopened.recover()).not.toBe('conflict');
    const q3 = await reopened.query('qa-6', 'planning-artifacts');
    expect((q3 as { data?: { phase?: string } }).data?.phase).toBe('discarded'); // survives restart
  });
});
