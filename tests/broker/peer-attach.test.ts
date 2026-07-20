import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerCore, DEFAULT_CONFIG } from '../../src/broker/server.ts';
import { FsMirrors, fsMessageCodec } from '../../src/adapters/fs/brokerMirrors.ts';
import { systemClock, systemIds } from '../../src/adapters/clock/index.ts';
import type { PeerSession } from '../../src/core/types.ts';

/**
 * Peer 1A-2/3 (rev 4 approved): connection-bound agent identity + the
 * admitting bootstrap. Credentials are agent-generated; the broker keeps
 * only a PRIVATE sha256 verifier (journal privateBindings — never in any
 * event, state, outcome, or projection); principals derive from connection
 * tags with auth BEFORE dedup; admission is attach-driven and the last
 * expected admission atomically leaves 'admitting'.
 */

const CRED = {
  claude: 'a'.repeat(64),
  codex: 'b'.repeat(64),
  agy: 'c'.repeat(64),
};

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'claudex-peer-attach-'));
}

function makeCore(root: string) {
  return new BrokerCore(
    join(root, '.pair'),
    { clock: systemClock, ids: systemIds, mirrors: new FsMirrors(root), codec: fsMessageCodec },
    DEFAULT_CONFIG,
    { onStopped: () => undefined, pid: process.pid, epoch: 3, endpoint: 'test-endpoint', heartbeatAt: () => systemClock.now() },
  );
}

/** Peer session seeded through the REAL bootstrap: init on a live tagged
 * connection carrying the initiator credential at the transport edge. */
async function peerCore(root: string, expected: string[] = ['claude', 'codex']) {
  const core = makeCore(root);
  await core.recover();
  core.onConnection('conn-claude', 'open');
  const init = await core.execute('init-1', 'client-claude', 'claude', {
    command: { kind: 'init-session', task: 'peer', agents: expected, driver: 'claude', sessionId: 'session-peer-01', topology: 'peer' },
    credential: CRED.claude,
  }, 'conn-claude');
  expect(init.ok).toBeTrue();
  return core;
}

const session = async (core: BrokerCore): Promise<PeerSession> => {
  const status = await core.query('st', 'status');
  if (!status.ok) throw new Error('status failed');
  return (status.data as { session: PeerSession }).session;
};

describe('peer init bootstrap: implicit initiator attach', () => {
  test('TOFU binds v1, tags the connection, raises durable attention; the verifier never leaves privateBindings', async () => {
    const root = await tempRoot();
    const core = await peerCore(root);
    const s = await session(core);
    expect(s.registry.agents['claude']!.binding).toMatchObject({ credentialVersion: 1 });
    expect(s.attention.some((a) => a.category === 'tofu-bind' && a.detail.includes('claude'))).toBeTrue();

    // The tagged connection executes; an untagged one is rejected.
    core.onConnection('conn-other', 'open');
    const untagged = await core.execute('x1', 'client-x', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'info', turn: 'keep', body: 'x' } }, 'conn-other');
    expect(untagged.ok).toBeFalse();
    expect((untagged as { error?: { code?: string } }).error?.code).toBe('agent-not-attached');

    // Secrecy: the journal's PUBLIC record parts never contain the hash;
    // only privateBindings does. (The credential itself appears nowhere.)
    const dir = join(root, '.pair', 'journal');
    const segments = (await readdir(dir)).filter((n) => n.startsWith('segment-'));
    const raw = await readFile(join(dir, segments[0]!), 'utf8');
    for (const line of raw.split('\n').filter(Boolean)) {
      const record = JSON.parse(line) as { privateBindings?: Record<string, { hash: string }>; [k: string]: unknown };
      const { privateBindings, ...publicParts } = record;
      expect(JSON.stringify(publicParts)).not.toContain(CRED.claude);
      for (const v of Object.values(privateBindings ?? {})) {
        expect(JSON.stringify(publicParts)).not.toContain(v!.hash);
      }
    }
  });

  test('peer init without the transport-edge credential is rejected; nothing is created', async () => {
    const core = makeCore(await tempRoot());
    await core.recover();
    core.onConnection('c1', 'open');
    const r = await core.execute('init-x', 'client-x', 'claude', {
      command: { kind: 'init-session', task: 'peer', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-peer-02', topology: 'peer' },
    }, 'c1');
    expect(r.ok).toBeFalse();
    expect((r as { error?: { code?: string } }).error?.code).toBe('invalid-credential');
    expect((await core.query('st', 'status')).ok).toBeFalse();
  });
});

describe('agent-attach: TOFU admission, reconnect proof, rejection matrix', () => {
  test('authorized agent TOFU-binds and is ADMITTED; the last expected admission atomically leaves admitting', async () => {
    const core = await peerCore(await tempRoot());
    core.onConnection('conn-codex', 'open');
    const attach = await core.agentAttach('at-1', 'conn-codex', 'client-codex', 'codex', CRED.codex);
    expect(attach.ok).toBeTrue();
    expect((attach as { data?: { admitted?: boolean } }).data?.admitted).toBeTrue();

    const s = await session(core);
    expect([...s.agents].sort()).toEqual(['claude', 'codex']);
    expect(s.planning).toMatchObject({ substate: 'collecting', barrier: { members: ['claude', 'codex'] } }); // atomic barrier-open fact (round 2 #4)
    expect(s.registry.agents['codex']!.binding).toMatchObject({ credentialVersion: 1 });
    // Admission is the membership change: fresh joinedAt at admission time.
    expect(s.registry.agents['codex']!.status).toBe('active');
  });

  test('a partial admission stays admitting; unauthorized and wrong-credential attaches are rejected', async () => {
    const core = await peerCore(await tempRoot(), ['claude', 'codex', 'agy']);
    core.onConnection('conn-codex', 'open');
    expect((await core.agentAttach('at-1', 'conn-codex', 'client-codex', 'codex', CRED.codex)).ok).toBeTrue();

    const s = await session(core);
    expect(s.planning?.substate).toBe('admitting'); // agy still missing
    if (s.planning?.substate === 'admitting') expect([...s.planning.admitted].sort()).toEqual(['claude', 'codex']);

    core.onConnection('conn-evil', 'open');
    const stranger = await core.agentAttach('at-2', 'conn-evil', 'client-evil', 'gemini', CRED.agy);
    expect((stranger as { error?: { code?: string } }).error?.code).toBe('admission-not-authorized');

    const wrongCred = await core.agentAttach('at-3', 'conn-evil', 'client-evil', 'codex', CRED.agy);
    expect((wrongCred as { error?: { code?: string } }).error?.code).toBe('agent-auth-failed');
  });

  test('reconnect proves the same secret across a broker RESTART (bindings persist privately)', async () => {
    const root = await tempRoot();
    const core = await peerCore(root);
    core.onConnection('conn-codex', 'open');
    expect((await core.agentAttach('at-1', 'conn-codex', 'client-codex', 'codex', CRED.codex)).ok).toBeTrue();

    const reopened = makeCore(root);
    expect(await reopened.recover()).not.toBe('conflict');
    reopened.onConnection('conn-codex-2', 'open');
    const again = await reopened.agentAttach('at-2', 'conn-codex-2', 'client-codex', 'codex', CRED.codex);
    expect(again.ok).toBeTrue();
    const forged = await reopened.agentAttach('at-3', 'conn-codex-2', 'client-codex', 'codex', CRED.agy);
    expect((forged as { error?: { code?: string } }).error?.code).toBe('agent-auth-failed');
  });

  test('multiple concurrent tagged connections per agent are legal', async () => {
    const core = await peerCore(await tempRoot());
    core.onConnection('conn-a', 'open');
    core.onConnection('conn-b', 'open');
    expect((await core.agentAttach('at-a', 'conn-a', 'client-codex', 'codex', CRED.codex)).ok).toBeTrue();
    expect((await core.agentAttach('at-b', 'conn-b', 'client-codex', 'codex', CRED.codex)).ok).toBeTrue();
    const viaA = await core.execute('s1', 'client-codex', 'codex', { command: { kind: 'send-message', to: 'claude', type: 'info', turn: 'keep', body: 'a' } }, 'conn-a');
    const viaB = await core.execute('s2', 'client-codex', 'codex', { command: { kind: 'send-message', to: 'claude', type: 'info', turn: 'keep', body: 'b' } }, 'conn-b');
    expect(viaA.ok).toBeTrue();
    expect(viaB.ok).toBeTrue();
  });
});

describe('auth BEFORE dedup; tag-derived principal; mailbox ownership', () => {
  test('forged `as` rejects without touching recorded outcomes; replay namespace is per-agent', async () => {
    const core = await peerCore(await tempRoot());
    core.onConnection('conn-codex', 'open');
    expect((await core.agentAttach('at-1', 'conn-codex', 'client-codex', 'codex', CRED.codex)).ok).toBeTrue();

    // codex commits under reqId 'shared-req'.
    const sent = await core.execute('shared-req', 'client-codex', 'codex', { command: { kind: 'send-message', to: 'claude', type: 'info', turn: 'keep', body: 'mine' } }, 'conn-codex');
    expect(sent.ok).toBeTrue();

    // Forged as: the codex-tagged connection claiming claude — rejected
    // BEFORE dedup even though 'shared-req' has a recorded outcome.
    const forged = await core.execute('shared-req', 'client-codex', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'info', turn: 'keep', body: 'forged' } }, 'conn-codex');
    expect((forged as { error?: { code?: string } }).error?.code).toBe('identity-mismatch');

    // Same reqId from CLAUDE's own tagged connection: a DIFFERENT dedup
    // namespace — executes fresh instead of replaying codex's outcome.
    const claudes = await core.execute('shared-req', 'client-claude', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'info', turn: 'keep', body: 'independent' } }, 'conn-claude');
    expect(claudes.ok).toBeTrue();
    const claudeEvent = (claudes as { events?: { body?: string }[] }).events?.find((e) => e.body !== undefined);
    expect(claudeEvent?.body).toBe('independent'); // not codex's replayed 'mine'
  });

  test('subscribe and ack are recipient-owned via the connection tag', async () => {
    const core = await peerCore(await tempRoot());
    core.onConnection('conn-codex', 'open');
    expect((await core.agentAttach('at-1', 'conn-codex', 'client-codex', 'codex', CRED.codex)).ok).toBeTrue();

    // Subscribe as someone else on a codex-tagged connection: rejected.
    const got: unknown[] = [];
    const foreign = await core.subscribe('sub-1', { id: 'conn-codex', sendDelivery: async (p) => void got.push(p), sendError: async () => undefined }, 'claude', 0);
    expect((foreign as { error?: { code?: string } }).error?.code).toBe('identity-mismatch');

    // claude sends codex mail; claude cannot ack codex's delivery.
    const sent = await core.execute('m1', 'client-claude', 'claude', { command: { kind: 'send-message', to: 'codex', type: 'info', turn: 'keep', body: 'x' } }, 'conn-claude');
    expect(sent.ok).toBeTrue();
    const deliveryId = `${(sent as { events?: { id?: string; kind?: string }[] }).events?.find((e) => e.kind === 'message-sent')?.id}:codex`;
    const crossAck = await core.ack('ack-1', deliveryId, 'client-claude', 'conn-claude');
    expect((crossAck as { error?: { code?: string } }).error?.code).toBe('identity-mismatch');
    const ownAck = await core.ack('ack-2', deliveryId, 'client-codex', 'conn-codex');
    expect(ownAck.ok).toBeTrue();
  });
});


describe('user-rebind-agent: pending-new-binding, revoked tags, TOFU at version+1', () => {
  test('rebind clears the private verifier, revokes+wakes old tags, and the next attach TOFUs at v2', async () => {
    const core = await peerCore(await tempRoot());
    core.onConnection('conn-codex', 'open');
    expect((await core.agentAttach('at-1', 'conn-codex', 'client-codex', 'codex', CRED.codex)).ok).toBeTrue();

    // A blocked wait on the codex tag observes the wake.
    const errors: unknown[] = [];
    const sub = await core.subscribe('sub-1', { id: 'conn-codex', sendDelivery: async () => undefined, sendError: async (code) => void errors.push(code) }, 'codex', 0);
    expect(sub.ok).toBeTrue();

    // User channel + rebind action.
    core.onConnection('conn-user', 'open');
    const attach = await core.userAttach('uat-1', { id: 'conn-user', sendObserver: async () => undefined }, 'client-user', 'f'.repeat(64));
    expect(attach.ok).toBeTrue();
    const rebind = await core.userAction('ract-1', 'client-user', 'conn-user', { verb: 'rebind', agent: 'codex' });
    expect(rebind.ok).toBeTrue();
    expect(errors).toContain('credential-revoked'); // blocked wait woken

    // The old tag is gone: execute on it fails closed.
    const stale = await core.execute('x1', 'client-codex', 'codex', { command: { kind: 'send-message', to: 'claude', type: 'info', turn: 'keep', body: 'x' } }, 'conn-codex');
    expect((stale as { error?: { code?: string } }).error?.code).toBe('agent-not-attached');

    // Next attach TOFUs at version+1 with a FRESH credential.
    core.onConnection('conn-codex-2', 'open');
    const again = await core.agentAttach('at-2', 'conn-codex-2', 'client-codex', 'codex', 'd'.repeat(64));
    expect(again.ok).toBeTrue();
    expect((again as { data?: { credentialVersion?: number } }).data?.credentialVersion).toBe(2);
  });
});


describe('1A round 2: registry honesty, durable authorization, frozen electorate, churn, attention', () => {
  const userSink = { id: 'conn-user', sendObserver: async () => undefined };

  test('#2: init registers ONLY the initiator; restart while admitting changes nothing (version, records, agents.json)', async () => {
    const root = await tempRoot();
    const core = await peerCore(root, ['claude', 'codex', 'agy']);
    const before = await session(core);
    expect(Object.keys(before.registry.agents)).toEqual(['claude']);
    const versionBefore = before.registry.version;

    const reopened = makeCore(root);
    expect(await reopened.recover()).not.toBe('conflict');
    const after = await session(reopened);
    expect(Object.keys(after.registry.agents)).toEqual(['claude']);
    expect(after.registry.version).toBe(versionBefore);
    expect(Object.values(after.registry.agents).every((r) => r.status === 'active')).toBeTrue(); // nobody silently marked left
    const mirror = JSON.parse(await readFile(join(root, '.pair', 'agents.json'), 'utf8')) as { registry: { version: number; agents: Record<string, unknown> } };
    expect(Object.keys(mirror.registry.agents)).toEqual(['claude']);
    expect(mirror.registry.version).toBe(versionBefore);
  });

  test('#3+#4: closing abstain opens the FROZEN barrier; the abstained invitee attaches later as an observer outside it; post-barrier user admission works', async () => {
    const core = await peerCore(await tempRoot(), ['claude', 'codex', 'agy']);
    core.onConnection('conn-codex', 'open');
    expect((await core.agentAttach('at-1', 'conn-codex', 'client-codex', 'codex', CRED.codex)).ok).toBeTrue();

    core.onConnection('conn-user', 'open');
    expect((await core.userAttach('uat-1', userSink, 'client-user', 'f'.repeat(64))).ok).toBeTrue();
    const ruling = await core.userAction('ract-1', 'client-user', 'conn-user', { verb: 'rule-absentee', agent: 'agy', ruling: 'abstain' });
    expect(ruling.ok).toBeTrue();

    let s = await session(core);
    expect(s.planning).toMatchObject({ substate: 'collecting', barrier: { members: ['claude', 'codex'] } });
    expect(s.authorized).toContain('agy'); // abstain kept the DURABLE authorization

    // The abstained invitee attaches LATER: admitted as a member, but the
    // frozen electorate never grows.
    core.onConnection('conn-agy', 'open');
    const late = await core.agentAttach('at-2', 'conn-agy', 'client-agy', 'agy', CRED.agy);
    expect(late.ok).toBeTrue();
    s = await session(core);
    expect(s.agents).toContain('agy');
    if (s.planning?.substate !== 'collecting') throw new Error('shape');
    expect(s.planning.barrier.members).toEqual(['claude', 'codex']); // frozen

    // Post-barrier user admission: authorize + attach a brand-new observer.
    expect((await core.userAction('ract-2', 'client-user', 'conn-user', { verb: 'admit', agent: 'gemini' })).ok).toBeTrue();
    core.onConnection('conn-gem', 'open');
    expect((await core.agentAttach('at-3', 'conn-gem', 'client-gem', 'gemini', 'e'.repeat(64))).ok).toBeTrue();
    s = await session(core);
    expect(s.agents).toContain('gemini');
    if (s.planning?.substate !== 'collecting') throw new Error('shape');
    expect(s.planning.barrier.members).toEqual(['claude', 'codex']); // still frozen
  });

  test('#4: the closing attach txn is ATOMIC — exact event list incl. the barrier-open fact', async () => {
    const core = await peerCore(await tempRoot(), ['claude', 'codex']);
    core.onConnection('conn-codex', 'open');
    const closing = await core.agentAttach('at-1', 'conn-codex', 'client-codex', 'codex', CRED.codex);
    expect(closing.ok).toBeTrue();
    const kinds = ((closing as { events?: { kind: string }[] }).events ?? []).map((e) => e.kind);
    expect(kinds).toEqual(['registry-updated', 'registry-updated', 'agent-admitted', 'admission-completed', 'barrier-opened', 'attention-raised']);
  });

  test('#6: leave during admitting shrinks both sets; a bound leaver RE-ADMITS by reconnect; user kick revokes authorization', async () => {
    const core = await peerCore(await tempRoot(), ['claude', 'codex', 'agy']);
    core.onConnection('conn-codex', 'open');
    expect((await core.agentAttach('at-1', 'conn-codex', 'client-codex', 'codex', CRED.codex)).ok).toBeTrue();

    // codex leaves mid-admitting.
    const left = await core.execute('lv-1', 'client-codex', 'codex', { command: { kind: 'leave-session' } }, 'conn-codex');
    expect(left.ok).toBeTrue();
    let s = await session(core);
    if (s.planning?.substate !== 'admitting') throw new Error('shape');
    expect(s.planning.admitted).toEqual(['claude']);
    expect(s.planning.authorizedExpected).toEqual(['claude', 'agy']); // completion set shrank
    expect(s.authorized).toContain('codex'); // voluntary leave keeps durable authorization

    // agy attaching now COMPLETES the shrunken set.
    core.onConnection('conn-agy', 'open');
    expect((await core.agentAttach('at-2', 'conn-agy', 'client-agy', 'agy', CRED.agy)).ok).toBeTrue();
    s = await session(core);
    expect(s.planning).toMatchObject({ substate: 'collecting', barrier: { members: ['claude', 'agy'] } });

    // The bound leaver re-attaches: RE-ADMITTED (membership txn), frozen barrier unchanged.
    core.onConnection('conn-codex-2', 'open');
    const back = await core.agentAttach('at-3', 'conn-codex-2', 'client-codex', 'codex', CRED.codex);
    expect(back.ok).toBeTrue();
    s = await session(core);
    expect(s.agents).toContain('codex');
    if (s.planning?.substate !== 'collecting') throw new Error('shape');
    expect(s.planning.barrier.members).toEqual(['claude', 'agy']);

    // User kick revokes DURABLE authorization: re-attach is rejected.
    core.onConnection('conn-user', 'open');
    expect((await core.userAttach('uat-1', userSink, 'client-user', 'f'.repeat(64))).ok).toBeTrue();
    expect((await core.userAction('ract-1', 'client-user', 'conn-user', { verb: 'kick', agent: 'codex' })).ok).toBeTrue();
    core.onConnection('conn-codex-3', 'open');
    const rejected = await core.agentAttach('at-4', 'conn-codex-3', 'client-codex', 'codex', CRED.codex);
    expect((rejected as { error?: { code?: string } }).error?.code).toBe('admission-not-authorized');
  });

  test('#8: attention clears by user action with id correlation and STAYS cleared across restart', async () => {
    const root = await tempRoot();
    const core = await peerCore(root);
    let s = await session(core);
    const item = s.attention[0]!;
    expect(item.category).toBe('tofu-bind');

    core.onConnection('conn-user', 'open');
    expect((await core.userAttach('uat-1', userSink, 'client-user', 'f'.repeat(64))).ok).toBeTrue();
    const unknown = await core.userAction('ract-0', 'client-user', 'conn-user', { verb: 'clear-attention', id: 'nope' });
    expect((unknown as { error?: { code?: string } }).error?.code).toBe('unknown-attention');
    expect((await core.userAction('ract-1', 'client-user', 'conn-user', { verb: 'clear-attention', id: item.id })).ok).toBeTrue();
    s = await session(core);
    expect(s.attention.some((a) => a.id === item.id)).toBeFalse();

    const reopened = makeCore(root);
    expect(await reopened.recover()).not.toBe('conflict');
    expect((await session(reopened)).attention.some((a) => a.id === item.id)).toBeFalse();
  });
});
