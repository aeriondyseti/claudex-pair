import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerCore, DEFAULT_CONFIG } from '../../src/broker/server.ts';
import { CorruptJournalError } from '../../src/broker/journal.ts';
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
const draftAmend = (core: BrokerCore, agent: string, content: string, baseRevision: number, reqId: string) =>
  core.execute(reqId, `client-${agent}`, agent, { command: { kind: 'draft-amend', content, baseRevision } }, `conn-${agent}`);
const critique = (core: BrokerCore, agent: string, anchor: unknown, severity: string, agreement: string, text: string, reqId: string) =>
  core.execute(reqId, `client-${agent}`, agent, { command: { kind: 'critique', anchor, severity, agreement, text } }, `conn-${agent}`);
const respondCritique = (core: BrokerCore, agent: string, findingId: string, disposition: string, text: string, reqId: string) =>
  core.execute(reqId, `client-${agent}`, agent, { command: { kind: 'respond-critique', findingId, disposition, text } }, `conn-${agent}`);
const confirmCritique = (core: BrokerCore, agent: string, findingId: string, verdict: string, text: string, reqId: string) =>
  core.execute(reqId, `client-${agent}`, agent, { command: { kind: 'confirm-critique', findingId, verdict, text } }, `conn-${agent}`);
const callQuestion = (core: BrokerCore, agent: string, reqId: string) =>
  core.execute(reqId, `client-${agent}`, agent, { command: { kind: 'call-question' } }, `conn-${agent}`);
const castVote = (core: BrokerCore, agent: string, approve: boolean, revisionHash: string, reqId: string, reasons?: string) =>
  core.execute(reqId, `client-${agent}`, agent, { command: { kind: 'vote', approve, revisionHash, ...(reasons === undefined ? {} : { reasons }) } }, `conn-${agent}`);
const addressAgenda = (core: BrokerCore, agent: string, agendaId: string, reqId: string) =>
  core.execute(reqId, `client-${agent}`, agent, { command: { kind: 'address-agenda', agendaId } }, `conn-${agent}`);
/** Bring both members through collecting to converging via both proposals. */
async function convergingCore(root: string) {
  const core = await collectingCore(root);
  expect((await propose(core, 'claude', BODY.claude, 'p-1')).ok).toBeTrue();
  expect((await propose(core, 'codex', BODY.codex, 'p-2')).ok).toBeTrue();
  return core;
}

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

describe('peer 1B-b: draft through the broker', () => {
  const DRAFT_BODY = 'DRAFT v1:\r\nsecond line survives CRLF\r\n';

  test('holder amend is readable byte-exact; a non-holder amend rejects; a restart preserves the draft', async () => {
    const root = await tempRoot();
    const core = await convergingCore(root);
    const s0 = await session(core);
    if (s0.planning?.substate !== 'converging') throw new Error('expected converging');
    expect(s0.planning.rotation.holder).toBe('claude');

    const amend = await draftAmend(core, 'claude', DRAFT_BODY, 0, 'd-1');
    expect(amend.ok).toBeTrue();
    const events = (amend as { events?: { kind: string; revision?: number; author?: string }[] }).events ?? [];
    expect(events).toEqual([expect.objectContaining({ kind: 'draft-amended', revision: 1, author: 'claude' })]);

    const q = await core.query('qa-d1', 'planning-artifacts');
    const data = (q as { data?: { draft?: { revision: number; author: string | null; body: string }; revisionLog?: unknown[] } }).data;
    expect(data?.draft?.revision).toBe(1);
    expect(data?.draft?.author).toBe('claude');
    expect(data?.draft?.body).toBe(DRAFT_BODY); // byte-exact incl. CRLF
    expect(data?.revisionLog).toHaveLength(2); // revision 0 (reveal) + revision 1

    // A second amend from the non-holder is rejected — the draft is untouched.
    const rejected = await draftAmend(core, 'codex', 'nope, not mine to amend', 1, 'd-2');
    expect((rejected as { error?: { code?: string } }).error?.code).toBe('not-convergence-holder');
    const qAfterReject = await core.query('qa-d2', 'planning-artifacts');
    expect((qAfterReject as { data?: { draft?: { revision: number } } }).data?.draft?.revision).toBe(1);

    await core.quiesce();
    const reopened = makeCore(root);
    expect(await reopened.recover()).not.toBe('conflict');
    const q2 = await reopened.query('qa-d3', 'planning-artifacts');
    const data2 = (q2 as { data?: { draft?: { revision: number; body: string } } }).data;
    expect(data2?.draft?.revision).toBe(1);
    expect(data2?.draft?.body).toBe(DRAFT_BODY);
  });

  test('TAMPER: a mutated planningArtifacts.revisionLog in the snapshot fails recovery closed', async () => {
    const root = await tempRoot();
    const core = await convergingCore(root);
    expect((await draftAmend(core, 'claude', DRAFT_BODY, 0, 'd-1')).ok).toBeTrue();
    await core.quiesce();
    await core.journal.snapshot(); // force snapshot.json to exist for the tamper

    const snapshotPath = join(root, '.pair', 'journal', 'snapshot.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as { planningArtifacts?: { revisionLog?: unknown[] } };
    const revisionLog = snapshot.planningArtifacts?.revisionLog;
    expect(revisionLog?.length).toBeGreaterThan(0);
    snapshot.planningArtifacts!.revisionLog = revisionLog!.slice(0, -1); // drop the last entry
    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));

    const reopened = makeCore(root);
    await expect(reopened.recover()).rejects.toThrow(CorruptJournalError);
  });

  test('MIRROR: phases/planning/draft.md + proposals/<author>.md are byte-exact and self-heal on reconcile', async () => {
    const root = await tempRoot();
    const core = await convergingCore(root);
    expect((await draftAmend(core, 'claude', DRAFT_BODY, 0, 'd-1')).ok).toBeTrue();
    await core.quiesce();

    const draftPath = join(root, '.pair', 'phases', 'planning', 'draft.md');
    const claudeProposalPath = join(root, '.pair', 'phases', 'planning', 'proposals', 'claude.md');
    const codexProposalPath = join(root, '.pair', 'phases', 'planning', 'proposals', 'codex.md');
    expect(await readFile(draftPath, 'utf8')).toBe(DRAFT_BODY);
    expect(await readFile(claudeProposalPath, 'utf8')).toBe(BODY.claude);
    expect(await readFile(codexProposalPath, 'utf8')).toBe(BODY.codex);

    await rm(draftPath, { force: true });
    const reopened = makeCore(root);
    expect(await reopened.recover()).toBe('rebuilt');
    expect(await readFile(draftPath, 'utf8')).toBe(DRAFT_BODY); // restored byte-exact
  });
});

describe('peer 1B-c: findings + yield + departure through the broker', () => {
  const findingId = (r: unknown): string => {
    const events = (r as { events?: { kind: string; id?: string }[] }).events ?? [];
    const filed = events.find((e) => e.kind === 'finding-filed');
    if (!filed?.id) throw new Error('no finding-filed event');
    return filed.id;
  };

  test('critique/respond/confirm accumulate self-verifying findingTexts; restart preserves metadata + texts', async () => {
    const root = await tempRoot();
    const core = await convergingCore(root);
    const filed = await critique(core, 'claude', { kind: 'proposal', author: 'codex' }, 'HIGH', 'disputed', 'the codex plan races on shutdown', 'ct-1');
    expect(filed.ok).toBeTrue();
    const fid = findingId(filed);
    // the text is PUBLIC post-reveal — it rides the event.
    expect(JSON.stringify((filed as { events?: unknown }).events)).toContain('races on shutdown');
    expect((await respondCritique(core, 'codex', fid, 'resolve', 'guarded the shutdown path', 'rs-1')).ok).toBeTrue();
    expect((await confirmCritique(core, 'claude', fid, 'accept', 'confirmed fixed', 'cf-1')).ok).toBeTrue();

    const q = await core.query('qf-1', 'planning-artifacts');
    const ft = (q as { data?: { findingTexts?: Record<string, { actor: string; kind: string; text: string }[]> } }).data?.findingTexts?.[fid];
    expect(ft).toHaveLength(3);
    expect(ft?.[0]).toMatchObject({ kind: 'filed', actor: 'claude', text: 'the codex plan races on shutdown' });
    expect(ft?.[1]).toMatchObject({ kind: 'responded', actor: 'codex', text: 'guarded the shutdown path' });
    expect(ft?.[2]).toMatchObject({ kind: 'confirmed', actor: 'claude', text: 'confirmed fixed' });

    // restart: metadata (state) and texts (artifacts) survive.
    await core.quiesce();
    const reopened = makeCore(root);
    expect(await reopened.recover()).not.toBe('conflict');
    const s = await session(reopened);
    if (s.planning?.substate !== 'converging') throw new Error('expected converging');
    expect(s.planning.findings[fid]).toMatchObject({ author: 'claude', addressedTo: 'codex', lifecycle: 'resolved' });
    const q2 = await reopened.query('qf-2', 'planning-artifacts');
    expect((q2 as { data?: { findingTexts?: Record<string, unknown[]> } }).data?.findingTexts?.[fid]).toHaveLength(3);
  });

  test('TAMPER: a removed findingTexts entry in the snapshot fails recovery closed (Ruling C)', async () => {
    const root = await tempRoot();
    const core = await convergingCore(root);
    const fid = findingId(await critique(core, 'claude', { kind: 'proposal', author: 'codex' }, 'MED', 'partial', 'first finding text', 'ct-1'));
    expect((await respondCritique(core, 'codex', fid, 'dispute', 'I disagree', 'rs-1')).ok).toBeTrue();
    await core.quiesce();
    await core.journal.snapshot();

    const snapshotPath = join(root, '.pair', 'journal', 'snapshot.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as { planningArtifacts?: { findingTexts?: Record<string, unknown[]> } };
    const entries = snapshot.planningArtifacts?.findingTexts?.[fid];
    expect(entries?.length).toBe(2);
    snapshot.planningArtifacts!.findingTexts![fid] = entries!.slice(0, -1); // drop one -> count mismatch vs state history
    await writeFile(snapshotPath, JSON.stringify(snapshot));

    const reopened = makeCore(root);
    await expect(reopened.recover()).rejects.toThrow(CorruptJournalError);
  });

  test('yield through execute passes the turn; the now-non-holder draft-amend is rejected', async () => {
    const core = await convergingCore(await tempRoot());
    const s0 = await session(core);
    if (s0.planning?.substate !== 'converging') throw new Error('shape');
    expect(s0.planning.rotation.holder).toBe('claude');

    const y = await core.execute('yl-1', 'client-claude', 'claude', { command: { kind: 'yield-turn' } }, 'conn-claude');
    expect(y.ok).toBeTrue();
    const passed = ((y as { events?: { kind: string; to?: string }[] }).events ?? []).find((e) => e.kind === 'convergence-turn-passed');
    expect(passed).toMatchObject({ to: 'codex' });
    const s1 = await session(core);
    if (s1.planning?.substate !== 'converging') throw new Error('shape');
    expect(s1.planning.rotation.holder).toBe('codex');

    const rejected = await draftAmend(core, 'claude', 'not mine to amend now', 0, 'da-1');
    expect((rejected as { error?: { code?: string } }).error?.code).toBe('not-convergence-holder');
  });

  test('holder departure via leave-session passes the turn in the SAME txn', async () => {
    const core = await convergingCore(await tempRoot());
    const d = await core.execute('lv-1', 'client-claude', 'claude', { command: { kind: 'leave-session' } }, 'conn-claude');
    expect(d.ok).toBeTrue();
    const kinds = ((d as { events?: { kind: string }[] }).events ?? []).map((e) => e.kind);
    expect(kinds).toContain('agent-left');
    expect(kinds).toContain('convergence-turn-passed');
    const s = await session(core);
    if (s.planning?.substate !== 'converging') throw new Error('shape');
    expect(s.planning.rotation.holder).toBe('codex');
  });

  test('a departing member with open findings raises a findings-blocked attention item', async () => {
    const core = await convergingCore(await tempRoot());
    // claude files a finding addressed to codex (stays open).
    expect((await critique(core, 'claude', { kind: 'proposal', author: 'codex' }, 'MED', 'partial', 'open concern', 'ct-1')).ok).toBeTrue();
    const d = await core.execute('lv-2', 'client-codex', 'codex', { command: { kind: 'leave-session' } }, 'conn-codex');
    expect(d.ok).toBeTrue();
    expect(((d as { events?: { kind: string; category?: string }[] }).events ?? []).some((e) => e.kind === 'attention-raised' && e.category === 'findings-blocked')).toBeTrue();
    const s = await session(core);
    expect(s.attention.some((a) => a.category === 'findings-blocked')).toBeTrue();
  });
});

describe('peer 1C: the ballot / round automaton through the broker', () => {
  const PLAN_BLOCK = {
    plan: { wip_cap: 1, verification: { fast_gate: 'bun test', full_suite: 'bun run check' } },
    tasks: [
      { id: 't1', title: 'Core', class: 'production', description: 'build it', acceptance: ['works'], deps: [] },
      { id: 't2', title: 'Verify', class: 'assist', merges: false, description: 'test it', acceptance: ['passes'], deps: ['t1'] },
    ],
  };
  const PLAN_DRAFT = `# Plan\r\nprose and rationale.\r\n\r\n\`\`\`json\n${JSON.stringify(PLAN_BLOCK, null, 2)}\n\`\`\`\r\n`;
  const calledHash = (r: unknown): string => {
    const called = ((r as { events?: { kind: string; revisionHash?: string }[] }).events ?? []).find((e) => e.kind === 'question-called');
    if (!called?.revisionHash) throw new Error('no question-called event');
    return called.revisionHash;
  };

  test('full happy path: draft with a valid json block -> call-question -> unanimous approve -> provisioning + frozen plan; artifacts stay revealed; vote notices ride @broker; restart preserves the plan', async () => {
    const root = await tempRoot();
    const core = await convergingCore(root);
    expect((await draftAmend(core, 'claude', PLAN_DRAFT, 0, 'd-1')).ok).toBeTrue();

    const called = await callQuestion(core, 'claude', 'cq-1');
    expect(called.ok).toBeTrue();
    const hash = calledHash(called);
    const q = ((called as { events?: { kind: string; electorate?: string[] }[] }).events ?? []).find((e) => e.kind === 'question-called');
    expect(q).toMatchObject({ electorate: ['claude', 'codex'] });

    expect((await castVote(core, 'claude', true, hash, 'vt-1')).ok).toBeTrue(); // non-final
    const s1 = await session(core);
    if (s1.planning?.substate !== 'converging') throw new Error('still converging until unanimous');

    const final = await castVote(core, 'codex', true, hash, 'vt-2'); // final
    expect(final.ok).toBeTrue();
    const kinds = ((final as { events?: { kind: string }[] }).events ?? []).map((e) => e.kind);
    expect(kinds).toContain('ballot-passed');
    expect(kinds).toContain('phase-transition');
    // Vote records project as derived @broker archive notices.
    expect(((final as { events?: { kind: string; from?: string }[] }).events ?? []).some((e) => e.kind === 'message-sent' && e.from === '@broker')).toBeTrue();

    const s2 = await session(core);
    expect(s2.phase).toBe('provisioning');
    expect(s2.planning).toBeUndefined();
    expect(s2.plan).toBeDefined();
    expect(s2.plan?.hash).toBe(hash);
    expect(s2.plan?.taskBlock.tasks.map((t) => t.id)).toEqual(['t1', 't2']);

    // The planning artifacts stay 'revealed' — the plan is carried on the session.
    const qa = await core.query('qa-c1', 'planning-artifacts');
    expect((qa as { data?: { phase?: string } }).data?.phase).toBe('revealed');

    // Restart: the frozen plan survives recovery.
    await core.quiesce();
    const reopened = makeCore(root);
    expect(await reopened.recover()).not.toBe('conflict');
    const s3 = await session(reopened);
    expect(s3.phase).toBe('provisioning');
    expect(s3.plan?.hash).toBe(hash);
    expect(s3.plan?.taskBlock.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  test('a reject closes the ballot; the recorded agenda blocks a re-call until it is addressed', async () => {
    const core = await convergingCore(await tempRoot());
    expect((await draftAmend(core, 'claude', PLAN_DRAFT, 0, 'd-1')).ok).toBeTrue();
    const hash = calledHash(await callQuestion(core, 'claude', 'cq-1'));

    const rej = await castVote(core, 'codex', false, hash, 'vt-1', 'the task ordering is wrong');
    expect(rej.ok).toBeTrue();
    const recorded = ((rej as { events?: { kind: string; items?: { id: string }[] }[] }).events ?? []).find((e) => e.kind === 'agenda-recorded');
    const agendaId = recorded?.items?.[0]?.id;
    expect(agendaId).toBeDefined();
    const sRej = await session(core);
    if (sRej.planning?.substate !== 'converging') throw new Error('shape');
    expect(sRej.planning.ballot).toBeUndefined(); // ballot closed
    expect(sRej.planning.agenda.filter((a) => !a.addressed)).toHaveLength(1);

    // A re-call is refused until the agenda is addressed.
    const blocked = await callQuestion(core, 'claude', 'cq-2');
    expect((blocked as { error?: { code?: string } }).error?.code).toBe('agenda-unaddressed');

    expect((await addressAgenda(core, 'claude', agendaId!, 'aa-1')).ok).toBeTrue();
    const reopenBallot = await callQuestion(core, 'claude', 'cq-3');
    expect(reopenBallot.ok).toBeTrue();
    const s2 = await session(core);
    if (s2.planning?.substate !== 'converging') throw new Error('shape');
    expect(s2.planning.ballot).toBeDefined();
  });

  test('call-question with an unparseable task block is rejected invalid-task-block (nothing committed)', async () => {
    const core = await convergingCore(await tempRoot());
    // A draft with NO json fence — the normative task block cannot be extracted.
    expect((await draftAmend(core, 'claude', 'just prose, no fenced block\r\n', 0, 'd-1')).ok).toBeTrue();
    const r = await callQuestion(core, 'claude', 'cq-1');
    expect((r as { error?: { code?: string } }).error?.code).toBe('invalid-task-block');
    const s = await session(core);
    if (s.planning?.substate !== 'converging') throw new Error('shape');
    expect(s.planning.ballot).toBeUndefined();
  });
});
