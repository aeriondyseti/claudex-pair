import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRecord, type TxnRecord } from '@broker/journal.ts';
import { foldStats, latencySummary, MESSAGE_TYPE_ORDER, type SessionStats } from '@core/stats.ts';

/**
 * Throughput sprint T1 — `pair stats`. A read-only diagnostic in the
 * status/log/doctor class (ARCHITECTURE/ENHANCEMENTS: diagnostics stay
 * file-native): it reads `.pair/journal/` segments directly, CRC-verifies
 * each record, and folds them with the pure core fold. It never writes and
 * never needs the broker to be running.
 */

const out = (s: string) => process.stdout.write(`${s}\n`);

export async function readJournalRecords(root: string): Promise<TxnRecord[]> {
  const dir = join(root, '.pair', 'journal');
  const names = (await readdir(dir)).filter((n) => /^segment-\d{6}\.jsonl$/.test(n)).sort();
  const records: TxnRecord[] = [];
  for (const name of names) {
    const raw = await readFile(join(dir, name), 'utf8');
    for (const line of raw.split('\n')) {
      if (line === '') continue;
      const record = decodeRecord(line);
      // A torn tail is the broker's to repair on recovery; a read-only
      // diagnostic just stops at the last valid record.
      if (!record) break;
      records.push(record);
    }
  }
  return records.sort((a, b) => a.seq - b.seq);
}

export async function runStats(root: string, json: boolean): Promise<number> {
  if (!existsSync(join(root, '.pair', 'journal'))) {
    out('stats requires the broker journal (.pair/journal). This session predates the broker or runs in fs mode — no throughput data is recorded there.');
    return 1;
  }
  const records = await readJournalRecords(root);
  if (!records.length) { out('The journal holds no records yet.'); return 0; }
  const stats = foldStats(records);
  if (json) { out(JSON.stringify(stats, null, 2)); return 0; }
  render(stats);
  return 0;
}

function render(s: SessionStats): void {
  out(`Task:      ${s.task ?? '(unknown — history trimmed)'}${s.sessionId ? `   Session: ${s.sessionId}` : ''}`);
  const cov = s.coverage;
  out(`Coverage:  records ${cov.firstSeq}..${cov.lastSeq} (${cov.firstAt} -> ${cov.lastAt}${cov.spanSec !== null ? `, ${dur(cov.spanSec)}` : ''})${cov.complete ? '' : '  PARTIAL — earlier history was trimmed into a snapshot'}`);
  out(`Session:   ${s.topology ?? '?'} topology, ${s.agents.join(', ') || '?'} — ${s.ended ? 'ended' : 'ongoing at journal head'}`);

  const types = Object.entries(s.messages.byType).sort(([a], [b]) => order(a) - order(b)).map(([t, n]) => `${t} ${n}`).join(', ');
  out(`Messages:  ${s.messages.total} total${types ? ` — ${types}` : ''}`);
  const froms = Object.entries(s.messages.byFrom).map(([f, n]) => `${f} ${n}`).join(', ');
  if (froms) out(`           by sender: ${froms}`);

  const span = cov.spanSec;
  const holds = Object.entries(s.turns.byAgent)
    .sort(([, a], [, b]) => b.totalSec - a.totalSec)
    .map(([agent, h]) => `${agent} ${dur(h.totalSec)}${span ? ` (${Math.round((100 * h.totalSec) / Math.max(1, span))}%)` : ''} over ${h.holds} hold${h.holds === 1 ? '' : 's'}${h.holds ? `, avg ${dur(Math.round(h.totalSec / h.holds))}` : ''}`);
  out(`Turns:     ${s.turns.passes} passes${holds.length ? `; held: ${holds.join('; ')}` : ''}`);

  const lat = latencySummary(s.asks.resolved);
  const latText = lat ? ` — latency avg ${dur(lat.meanSec)}, p50 ${dur(lat.p50Sec)}, p90 ${dur(lat.p90Sec)}` : '';
  out(`Asks:      ${s.asks.asked} asked, ${s.asks.resolved.length} resolved${latText}${s.asks.lapsed ? `; ${s.asks.lapsed} lapsed to recorded consent (watch this rate)` : ''}`);
  for (const open of s.asks.open) out(`           OPEN: ${open.to} owes ${open.from} a reply to ${open.messageId}${open.ageSec !== null ? ` (${dur(open.ageSec)} old at journal head)` : ''}`);

  if (s.attention.raised) out(`Attention: ${s.attention.raised} raised, ${s.attention.cleared} cleared — ${dur(s.attention.blockedSec)} human-blocked${s.attention.openIds.length ? `; still open: ${s.attention.openIds.join(', ')}` : ''}`);

  const p = s.planning;
  if (p.barrierOpenSec !== null || p.findingsFiled || p.ballots.called) {
    const parts = [
      ...(p.barrierOpenSec !== null ? [`barrier open ${dur(p.barrierOpenSec)}`] : []),
      ...(p.rounds ? [`${p.rounds} round${p.rounds === 1 ? '' : 's'}`] : []),
      ...(p.findingsFiled ? [`findings ${p.findingsFiled} filed / ${p.findingsSettled} settled`] : []),
      ...(p.ballots.called ? [`ballots ${p.ballots.called} called (${p.ballots.passed} passed, ${p.ballots.rejected} rejected, ${p.ballots.voided} voided)`] : []),
    ];
    out(`Planning:  ${parts.join('; ')}`);
  }
}

const order = (t: string): number => { const i = MESSAGE_TYPE_ORDER.indexOf(t as (typeof MESSAGE_TYPE_ORDER)[number]); return i === -1 ? MESSAGE_TYPE_ORDER.length : i; };

/** Compact duration: 45s, 3m25s, 1h12m. */
export function dur(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (m < 60) return sec ? `${m}m${String(sec).padStart(2, '0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return min ? `${h}h${String(min).padStart(2, '0')}m` : `${h}h`;
}
