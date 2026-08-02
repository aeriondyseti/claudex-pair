import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandEnvelope } from '../../src/core/commands.ts';
import type { Event } from '../../src/core/events.ts';
import { Journal } from '../../src/broker/journal.ts';
import { readJournalRecords } from '../../src/apps/cli/stats.ts';
import { foldStats } from '../../src/core/stats.ts';

/** T1: the CLI's direct segment reader against a REAL journal — CRC-verified
 * records committed by the Journal class, including an ack txn (events: [])
 * which the fold must pass through without counting anything. */

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'claudex-stats-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const env = (id: string, principal: string, at: string): CommandEnvelope =>
  ({ command: { kind: 'send-message' }, meta: { id, principal, at } }) as unknown as CommandEnvelope;

describe('T1 stats journal reader', () => {
  test('reads committed records back and folds them', async () => {
    const journal = new Journal(join(root, '.pair'));
    await journal.recover();
    const at0 = '2026-08-01 09:00:00';
    const at1 = '2026-08-01 09:10:00';
    const init: Event = { kind: 'session-initialized', task: 'integration', agents: ['claude', 'codex'], driver: 'claude', at: at0, sessionId: 's-int' };
    const ask: Event = { kind: 'message-sent', id: 'a1', from: 'claude', to: 'codex', type: 'ask', turn: 'pass', body: 'q', at: at1 };
    await journal.commit(env('e1', 'claude', at0), [init], { ok: true }, { clientId: 'c1', reqId: 'r1' });
    await journal.commit(env('e2', 'claude', at1), [ask, { kind: 'turn-passed', to: 'codex' }], { ok: true }, { clientId: 'c1', reqId: 'r2' });
    await journal.ackDelivery('a1:codex', 'c2', at1);

    const records = await readJournalRecords(root);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);

    const stats = foldStats(records);
    expect(stats.task).toBe('integration');
    expect(stats.messages.total).toBe(1);
    expect(stats.asks.open).toEqual([{ messageId: 'a1', from: 'claude', to: 'codex', ageSec: 0 }]);
    expect(stats.turns.byAgent['claude']).toEqual({ totalSec: 600, holds: 1 });
  });

  test('stops at a torn tail instead of failing', async () => {
    const journal = new Journal(join(root, '.pair'));
    await journal.recover();
    const at0 = '2026-08-01 09:00:00';
    await journal.commit(env('e1', 'claude', at0), [{ kind: 'session-initialized', task: 't', agents: ['claude', 'codex'], driver: 'claude', at: at0 }], { ok: true }, { clientId: 'c1', reqId: 'r1' });
    const segment = join(root, '.pair', 'journal', 'segment-000001.jsonl');
    await Bun.write(segment, `${await Bun.file(segment).text()}{"torn`);
    const records = await readJournalRecords(root);
    expect(records).toHaveLength(1);
  });
});
