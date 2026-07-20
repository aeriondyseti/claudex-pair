import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorruptJournalError, Journal } from '../../src/broker/journal.ts';
import { decide } from '../../src/core/decide.ts';
import type { CommandEnvelope } from '../../src/core/commands.ts';

/** BROKER-SPEC failure matrix — journal slice: F1, F2, F6, F11, F12. */

const env = (command: unknown, principal: string, id: string): CommandEnvelope =>
  ({ command, meta: { id, at: '2026-07-12 19:30:00', principal } }) as CommandEnvelope;

async function freshJournal(): Promise<{ journal: Journal; pairDir: string }> {
  const pairDir = mkdtempSync(join(tmpdir(), 'claudex-journal-'));
  const journal = new Journal(pairDir);
  await journal.recover();
  return { journal, pairDir };
}

async function commitInit(journal: Journal, clientId = 'c1', reqId = 'r1') {
  const e = env({ kind: 'init-session', task: 't', agents: ['claude', 'codex', 'agy'], driver: 'claude', sessionId: 'session-j-0001' }, 'claude', 'm1');
  const decided = decide(journal.sessionState, e);
  if (!decided.ok) throw decided.error;
  return journal.commit(e, decided.value, { ok: true, seq: 1 }, { clientId, reqId });
}

async function commitEnd(journal: Journal, clientId = 'c1', reqId = 'r2') {
  const e = env({ kind: 'end-session', summary: 'bye' }, 'claude', 'm2');
  const decided = decide(journal.sessionState, e);
  if (!decided.ok) throw decided.error;
  return journal.commit(e, decided.value, { ok: true, seq: 2 }, { clientId, reqId });
}

describe('journal (BROKER-SPEC F1/F2/F6/F11/F12)', () => {
  test('F1: torn tail truncated on recover; state consistent', async () => {
    const { journal, pairDir } = await freshJournal();
    await commitInit(journal);
    const segments = (await readdir(join(pairDir, 'journal'))).filter((n) => n.startsWith('segment-'));
    const seg = join(pairDir, 'journal', segments[0]!);
    await appendFile(seg, '{"seq":2,"txn":{"clientId":"c1","reqId"', 'utf8'); // torn write

    const reopened = new Journal(pairDir);
    await reopened.recover();
    expect(reopened.headSeq).toBe(1);
    expect(reopened.sessionState?.status).toBe('active');
    // The torn bytes are gone from disk.
    expect((await readFile(seg, 'utf8')).includes('"reqId"\n')).toBe(false);
  });

  test('F2: committed outcome replayed for retried (clientId, reqId) after restart', async () => {
    const { journal, pairDir } = await freshJournal();
    await commitInit(journal, 'cli-a', 'req-42');
    const reopened = new Journal(pairDir);
    await reopened.recover();
    expect(reopened.recordedOutcome('cli-a', 'req-42')).toEqual({ ok: true, seq: 1 });
    expect(reopened.recordedOutcome('cli-a', 'req-nope')).toBeUndefined();
  });

  test('F6: corruption mid-history refuses start with doctor guidance', async () => {
    const { journal, pairDir } = await freshJournal();
    await commitInit(journal);
    const segments = (await readdir(join(pairDir, 'journal'))).filter((n) => n.startsWith('segment-'));
    const seg = join(pairDir, 'journal', segments[0]!);
    const original = await readFile(seg, 'utf8');
    // Corrupt the FIRST record, then append a valid-looking second record so the
    // corruption is mid-history, not a torn tail.
    await Bun.write(seg, `{"garbage":true}\n${original}`);

    const reopened = new Journal(pairDir);
    await expect(reopened.recover()).rejects.toThrow(CorruptJournalError);
  });

  test('F11: unacked deliveries survive restart; acked ones do not', async () => {
    const { journal, pairDir } = await freshJournal();
    await commitInit(journal);
    await commitEnd(journal); // fans out 2 done deliveries (codex, agy)
    const open = journal.openDeliveries();
    expect(open.length).toBe(2);
    await journal.ackDelivery(open[0]!.deliveryId, 'cli-codex', 't');

    const reopened = new Journal(pairDir);
    await reopened.recover();
    const reopenedOpen = reopened.openDeliveries();
    expect(reopenedOpen.length).toBe(1);
    expect(reopenedOpen[0]!.deliveryId).toBe(open[1]!.deliveryId);
    expect(reopenedOpen[0]!.message.to).toBe(open[1]!.message.to);
  });

  test('F12: snapshot boundary — recovery consistent from snapshot plus later records', async () => {
    const { journal, pairDir } = await freshJournal();
    await commitInit(journal);
    await journal.snapshot();
    await commitEnd(journal); // lands in a post-snapshot segment

    const reopened = new Journal(pairDir);
    await reopened.recover();
    expect(reopened.headSeq).toBe(2);
    expect(reopened.sessionState?.status).toBe('completed');
    expect(reopened.openDeliveries().length).toBe(2);
    // Stale tmp snapshot files are ignored (crash before rename).
    await Bun.write(join(pairDir, 'journal', 'snapshot.json.99999.tmp'), 'garbage');
    const again = new Journal(pairDir);
    await again.recover();
    expect(again.headSeq).toBe(2);
  });

  test('delivery cursor is monotonic across commits and restarts', async () => {
    const { journal, pairDir } = await freshJournal();
    await commitInit(journal);
    await commitEnd(journal);
    const before = journal.deliveryHead;
    const reopened = new Journal(pairDir);
    await reopened.recover();
    expect(reopened.deliveryHead).toBe(before);
  });
});


/** Item 7 — the journal-authoritative awaiting-set (codex blockers 3+4).
 * Events are hand-built: the journal replays records as given; decide-level
 * validation is pinned in tests/core. */
describe('journal item-7 awaiting-set', () => {
  const at = '2026-07-20 13:00:00';
  const msg = (id: string, from: string, to: string, type: string, replyTo?: string) =>
    [{ kind: 'message-sent', id, from, to, type, turn: 'keep', body: 'b', at, ...(replyTo ? { replyTo } : {}) }] as never[];
  const commitMsg = (journal: Journal, id: string, from: string, to: string, type: string, replyTo?: string) =>
    journal.commit(env({ kind: 'send-message' }, from, id), msg(id, from, to, type, replyTo), { ok: true }, { clientId: 'c', reqId: `r-${id}` });

  test('an acked unresolved ask survives ring cap pressure, snapshot, and restart (blocker 3)', async () => {
    const { journal, pairDir } = await freshJournal();
    await commitInit(journal);
    await commitMsg(journal, 'a1', 'claude', 'codex', 'ask');
    await journal.ackDelivery('a1:codex', 'c', at); // consumed but NOT answered
    for (let i = 0; i < 205; i++) {
      await commitMsg(journal, `n${i}`, 'claude', 'codex', 'info');
      await journal.ackDelivery(`n${i}:codex`, 'c', at);
    }
    // The ring dropped the acked ask; the awaiting-set did not.
    expect(journal.transcript().some((t) => t.deliveryId === 'a1:codex')).toBeFalse();
    expect(journal.awaiting()).toEqual([{ messageId: 'a1', from: 'claude', to: 'codex', sentAt: at }]);

    await journal.snapshot();
    const reopened = new Journal(pairDir);
    await reopened.recover();
    expect(reopened.awaiting()).toEqual([{ messageId: 'a1', from: 'claude', to: 'codex', sentAt: at }]);

    await commitMsg(reopened, 'ans', 'codex', 'claude', 'answer', 'a1');
    expect(reopened.awaiting()).toEqual([]);
  }, 60_000);

  test('resolution demands a valid reply type on the reverse endpoints (blocker 4)', async () => {
    const { journal } = await freshJournal();
    await commitInit(journal);
    await commitMsg(journal, 'a9', 'claude', 'codex', 'ask');

    await commitMsg(journal, 'w1', 'codex', 'claude', 'info', 'a9'); // wrong type
    await commitMsg(journal, 'w2', 'agy', 'claude', 'answer', 'a9'); // wrong sender
    await commitMsg(journal, 'w3', 'codex', 'agy', 'answer', 'a9'); // wrong recipient
    await commitMsg(journal, 'w4', 'codex', 'claude', 'answer', 'nope'); // unknown id
    expect(journal.awaiting().map((a) => a.messageId)).toEqual(['a9']);

    await commitMsg(journal, 'ok', 'codex', 'claude', 'review', 'a9'); // review resolves too
    expect(journal.awaiting()).toEqual([]);
  });

  test('membership cleanup: kick, leave, and session end clear entries the agent can no longer settle', async () => {
    const { journal } = await freshJournal();
    await commitInit(journal);
    await commitMsg(journal, 'k1', 'claude', 'codex', 'ask');
    await journal.commit(env({ kind: 'kick-agent' }, 'claude', 'kk'), [{ kind: 'agent-kicked', agent: 'codex', reason: '', at }] as never[], { ok: true }, { clientId: 'c', reqId: 'r-kk' });
    expect(journal.awaiting()).toEqual([]);

    await commitMsg(journal, 'l1', 'claude', 'agy', 'ask');
    await journal.commit(env({ kind: 'leave-session' }, 'agy', 'll'), [{ kind: 'agent-left', agent: 'agy', at }] as never[], { ok: true }, { clientId: 'c', reqId: 'r-ll' });
    expect(journal.awaiting()).toEqual([]);

    await commitMsg(journal, 'e1', 'claude', 'agy', 'ask');
    await journal.commit(env({ kind: 'end-session' }, 'claude', 'ee'), [{ kind: 'session-ended', by: 'claude', summary: 's', at }] as never[], { ok: true }, { clientId: 'c', reqId: 'r-ee' });
    expect(journal.awaiting()).toEqual([]);
  });

  test('legacy snapshot without awaiting seeds best-effort from the transcript', async () => {
    const { journal, pairDir } = await freshJournal();
    await commitInit(journal);
    await commitMsg(journal, 'a2', 'claude', 'codex', 'ask');
    await journal.snapshot();
    const snapPath = join(pairDir, 'journal', 'snapshot.json');
    const snap = JSON.parse(await readFile(snapPath, 'utf8')) as { awaiting?: unknown };
    delete snap.awaiting; // simulate a pre-item-7 snapshot
    await Bun.write(snapPath, JSON.stringify(snap));

    const reopened = new Journal(pairDir);
    await reopened.recover();
    expect(reopened.awaiting().map((a) => a.messageId)).toEqual(['a2']);
  });
});


describe('journal item-7 untagged compatibility rule (round 2)', () => {
  const at = '2026-07-20 13:00:00';
  const msg2 = (id: string, from: string, to: string, type: string, replyTo?: string) =>
    [{ kind: 'message-sent', id, from, to, type, turn: 'keep', body: 'b', at, ...(replyTo ? { replyTo } : {}) }] as never[];
  const commit2 = (journal: Journal, id: string, from: string, to: string, type: string, replyTo?: string) =>
    journal.commit(env({ kind: 'send-message' }, from, id), msg2(id, from, to, type, replyTo), { ok: true }, { clientId: 'c', reqId: `r2-${id}` });

  test('an untagged answer settles the OLDEST reverse-endpoint debt only — no phantom debts', async () => {
    const { journal } = await freshJournal();
    await commitInit(journal);
    await commit2(journal, 'a1', 'claude', 'codex', 'ask');
    await commit2(journal, 'a2', 'claude', 'codex', 'ask');
    await commit2(journal, 'b1', 'codex', 'claude', 'ask'); // other direction

    await commit2(journal, 'ans1', 'codex', 'claude', 'answer'); // untagged
    expect(journal.awaiting().map((a) => a.messageId)).toEqual(['a2', 'b1']);

    await commit2(journal, 'ans2', 'codex', 'claude', 'answer'); // untagged again
    expect(journal.awaiting().map((a) => a.messageId)).toEqual(['b1']); // b1 is claude's debt, untouched

    await commit2(journal, 'noise', 'agy', 'claude', 'answer'); // wrong direction pair
    expect(journal.awaiting().map((a) => a.messageId)).toEqual(['b1']);
  });
});


describe('M1: legacy snapshot registry synthesis', () => {
  test('a pre-M1 snapshot (state without registry) recovers with a synthesized v0 registry', async () => {
    const { journal, pairDir } = await freshJournal();
    await commitInit(journal);
    await journal.snapshot();
    const snapPath = join(pairDir, 'journal', 'snapshot.json');
    const snap = JSON.parse(await readFile(snapPath, 'utf8')) as { state?: { registry?: unknown; agents?: string[] } };
    delete snap.state!.registry; // simulate a pre-M1 snapshot
    await Bun.write(snapPath, JSON.stringify(snap));

    const reopened = new Journal(pairDir);
    await reopened.recover();
    expect(reopened.sessionState?.registry.version).toBe(0);
    expect(Object.keys(reopened.sessionState?.registry.agents ?? {})).toEqual(['claude', 'codex', 'agy']);
    expect(reopened.sessionState?.registry.agents['claude']).toMatchObject({ status: 'active', display: 'claude' });
  });
});


describe('M1: legacy journal replay (pre-M1 segments, no registry-updated events)', () => {
  const at = '2026-07-20 14:00:00';
  test('membership-only history reconciles the registry to the live projection at v0', async () => {
    const { journal, pairDir } = await freshJournal();
    // Old-shape records: session-initialized + agent-joined/left WITHOUT
    // registry-updated companions (exactly what a pre-M1 broker journaled).
    await journal.commit(env({ kind: 'init-session' }, 'claude', 'i1'),
      [{ kind: 'session-initialized', task: 't', agents: ['claude', 'codex'], driver: 'claude', at }] as never[],
      { ok: true }, { clientId: 'c', reqId: 'r-i1' });
    await journal.commit(env({ kind: 'join-session' }, 'claude', 'j1'),
      [{ kind: 'agent-joined', agent: 'agy', at }] as never[],
      { ok: true }, { clientId: 'c', reqId: 'r-j1' });
    await journal.commit(env({ kind: 'leave-session' }, 'codex', 'l1'),
      [{ kind: 'agent-left', agent: 'codex', at }] as never[],
      { ok: true }, { clientId: 'c', reqId: 'r-l1' });

    const reopened = new Journal(pairDir);
    await reopened.recover();
    const reg = reopened.sessionState!.registry;
    expect(reg.version).toBe(0); // legacy history claims no versioned transitions
    expect(reg.agents['agy']).toMatchObject({ status: 'active' }); // joined without registry event → reconciled in
    expect(reg.agents['codex']).toMatchObject({ status: 'left' }); // departed → reconciled out
    expect(reg.agents['claude']).toMatchObject({ status: 'active' });
  });
});


describe('peer 1A round 2 #5: pending-rebind bindings survive snapshots', () => {
  test('a revoked (hash-less) binding keeps its version across snapshot+restart', async () => {
    const { journal, pairDir } = await freshJournal();
    await commitInit(journal);
    await journal.commit(env({ kind: 'bind-agent' }, 'codex', 'b1'), [] as never[], { ok: true }, { clientId: 'c', reqId: 'r-b1' }, [], { codex: { hash: 'h'.repeat(64), credentialVersion: 1 } });
    await journal.commit(env({ kind: 'user-rebind-agent' }, 'user', 'b2'), [] as never[], { ok: true }, { clientId: 'c', reqId: 'r-b2' }, [], { codex: null });
    expect(journal.binding('codex')).toEqual({ credentialVersion: 1, revokedHashes: ['h'.repeat(64)] }); // hash moved to the denylist

    // Round 4 #1: the denylist ACCUMULATES across rotations — a fresh v2
    // bind preserves v1's hash; a second revocation adds v2's.
    await journal.commit(env({ kind: 'bind-agent' }, 'codex', 'b3'), [] as never[], { ok: true }, { clientId: 'c', reqId: 'r-b3' }, [], { codex: { hash: 'i'.repeat(64), credentialVersion: 2 } });
    expect(journal.binding('codex')).toEqual({ hash: 'i'.repeat(64), credentialVersion: 2, revokedHashes: ['h'.repeat(64)] });
    await journal.commit(env({ kind: 'user-rebind-agent' }, 'user', 'b4'), [] as never[], { ok: true }, { clientId: 'c', reqId: 'r-b4' }, [], { codex: null });
    expect(journal.binding('codex')).toEqual({ credentialVersion: 2, revokedHashes: ['h'.repeat(64), 'i'.repeat(64)] });

    await journal.snapshot();
    const reopened = new Journal(pairDir);
    await reopened.recover();
    expect(reopened.binding('codex')).toEqual({ credentialVersion: 2, revokedHashes: ['h'.repeat(64), 'i'.repeat(64)] }); // full denylist survives the snapshot
  });
});
