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
  const e = env({ kind: 'init-session', task: 't', agents: ['claude', 'codex', 'agy'], driver: 'claude' }, 'claude', 'm1');
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
