import { open, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandEnvelope } from '@core/commands.ts';
import type { Event } from '@core/events.ts';
import { evolve } from '@core/evolve.ts';
import type { SessionState } from '@core/types.ts';

/**
 * WAL journal per docs/BROKER-SPEC.md rev 4. Authoritative store: transaction
 * records (fsync-before-ack), durable dedup for committed successes, journaled
 * delivery ledger, torn-tail recovery, crash-safe snapshot/rotation.
 */

export type DeliveryRef = { deliveryId: string; deliverySeq: number };

export type TxnRecord = {
  seq: number;
  txn: { clientId: string; reqId: string };
  envelopeId: string;
  principal: string;
  at: string;
  events: Event[];
  deliveries: DeliveryRef[];
  /**
   * Deliveries CLOSED by this txn without consumption (F18/F21): a removed
   * agent's undelivered mail — including notices enqueued by this very txn —
   * voided to the archive in the same committed record. Optional for
   * backward compatibility with pre-W2c journals.
   */
  voided?: DeliveryRef[];
  outcome: unknown;
  crc32: number;
};

export type OpenDelivery = {
  deliveryId: string;
  deliverySeq: number;
  /** message-sent event this delivery carries (needed for redelivery). */
  message: Extract<Event, { kind: 'message-sent' }>;
};

/**
 * One transcript entry in the journal's bounded recent-history ring —
 * authoritative message history for observer snapshots (watch), so the
 * broker never has to trust a mirror read for its own served views.
 */
export type TranscriptRecord = {
  deliveryId: string;
  message: Extract<Event, { kind: 'message-sent' }>;
  state: 'open' | 'acked' | 'voided';
};

export type Snapshot = {
  state: SessionState | undefined;
  lastSeq: number;
  lastDeliverySeq: number;
  dedup: Record<string, Record<string, unknown>>; // clientId → reqId → outcome
  openDeliveries: OpenDelivery[];
};

export class CorruptJournalError extends Error {
  constructor(segment: string, line: number) {
    super(
      `Journal corruption in ${segment} at line ${line} (not a torn tail). ` +
        `Refusing to start; inspect the segment or run pair doctor.`,
    );
    this.name = 'CorruptJournalError';
  }
}

const DEDUP_WINDOW_PER_CLIENT = 32;
const SEGMENT_ROTATE_BYTES = 4 * 1024 * 1024;
/** Transcript ring cap. Bounded so a long session cannot grow the broker's
 * memory; observers see at most this much history (older history lives in
 * the archive mirrors, which are a diagnostic view, not this snapshot). */
const TRANSCRIPT_RING_MAX = 200;

/** CRC-32 (IEEE), table-based, over the record JSON without the crc32 field. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodeRecord(record: Omit<TxnRecord, 'crc32'>): string {
  const body = JSON.stringify(record);
  return JSON.stringify({ ...record, crc32: crc32(body) });
}

function decodeRecord(line: string): TxnRecord | undefined {
  let parsed: TxnRecord;
  try {
    parsed = JSON.parse(line) as TxnRecord;
  } catch {
    return undefined;
  }
  const { crc32: stored, ...rest } = parsed;
  if (crc32(JSON.stringify(rest)) !== stored) return undefined;
  return parsed;
}

const segmentName = (n: number) => `segment-${String(n).padStart(6, '0')}.jsonl`;

export class Journal {
  private state: SessionState | undefined;
  private lastSeq = 0;
  private lastDeliverySeq = 0;
  private dedup = new Map<string, Map<string, unknown>>();
  private open_ = new Map<string, OpenDelivery>();
  /** Insertion-ordered (= commit-ordered) recent messages, capped. Rebuilt
   * on recover from the replayed tail — a fresh restart serves only the
   * post-snapshot history, which is honest: it is what the journal holds. */
  private transcript_ = new Map<string, TranscriptRecord>();
  private segmentIndex = 1;
  private segmentBytes = 0;
  readonly dir: string;

  constructor(pairDir: string) {
    this.dir = join(pairDir, 'journal');
  }

  get sessionState(): SessionState | undefined {
    return this.state;
  }
  get headSeq(): number {
    return this.lastSeq;
  }
  get deliveryHead(): number {
    return this.lastDeliverySeq;
  }
  openDeliveries(): OpenDelivery[] {
    return [...this.open_.values()].sort((a, b) => a.deliverySeq - b.deliverySeq);
  }
  openDeliveriesFor(recipient: string): OpenDelivery[] {
    return this.openDeliveries().filter((d) => d.message.to === recipient);
  }
  /** Commit-ordered recent message history (authoritative, journal-derived). */
  transcript(): TranscriptRecord[] {
    return [...this.transcript_.values()];
  }

  /** Committed-success dedup lookup (spec: rejections re-evaluate). */
  recordedOutcome(clientId: string, reqId: string): unknown | undefined {
    return this.dedup.get(clientId)?.get(reqId);
  }

  async recover(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const snapshot = await this.loadSnapshot();
    if (snapshot) {
      this.state = snapshot.state;
      this.lastSeq = snapshot.lastSeq;
      this.lastDeliverySeq = snapshot.lastDeliverySeq;
      this.dedup = new Map(Object.entries(snapshot.dedup).map(([c, m]) => [c, new Map(Object.entries(m))]));
      this.open_ = new Map(snapshot.openDeliveries.map((d) => [d.deliveryId, d]));
    }
    const segments = (await readdir(this.dir)).filter((n) => /^segment-\d{6}\.jsonl$/.test(n)).sort();
    for (let s = 0; s < segments.length; s++) {
      const name = segments[s]!;
      const path = join(this.dir, name);
      const raw = await readFile(path, 'utf8');
      const lines = raw.split('\n');
      let validBytes = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line === '') {
          continue;
        }
        const record = decodeRecord(line);
        if (!record) {
          const isLastSegment = s === segments.length - 1;
          const restIsEmpty = lines.slice(i + 1).every((l) => l === '');
          if (isLastSegment && restIsEmpty) {
            // Torn tail (F1): truncate to the last valid record.
            await writeFile(path, raw.slice(0, validBytes), 'utf8');
            break;
          }
          throw new CorruptJournalError(name, i + 1); // F6
        }
        if (record.seq > this.lastSeq) this.applyRecord(record);
        validBytes += Buffer.byteLength(line, 'utf8') + 1;
      }
      this.segmentIndex = Number(name.slice(8, 14));
      this.segmentBytes = validBytes;
    }
    if (segments.length === 0) {
      this.segmentIndex = 1;
      this.segmentBytes = 0;
    }
  }

  private applyRecord(record: TxnRecord): void {
    for (const event of record.events) {
      this.state = evolve(this.state, event);
      if (event.kind === 'message-sent') {
        const ref = record.deliveries.find((d) => d.deliveryId === `${event.id}:${event.to}`);
        if (ref) {
          this.open_.set(ref.deliveryId, { ...ref, message: event });
          this.transcript_.set(ref.deliveryId, { deliveryId: ref.deliveryId, message: event, state: 'open' });
          while (this.transcript_.size > TRANSCRIPT_RING_MAX) {
            const oldest = this.transcript_.keys().next().value;
            if (oldest === undefined) break;
            this.transcript_.delete(oldest);
          }
        }
      }
    }
    // Ack txns carry events: [] and list the acked ids in `deliveries`.
    if (record.events.length === 0) {
      for (const d of record.deliveries) {
        this.open_.delete(d.deliveryId);
        const entry = this.transcript_.get(d.deliveryId);
        if (entry) entry.state = 'acked';
      }
    }
    // Voided deliveries close in the SAME txn (F18/F21) — after enqueues, so
    // a notice enqueued and voided by one record nets out closed on replay.
    for (const d of record.voided ?? []) {
      this.open_.delete(d.deliveryId);
      const entry = this.transcript_.get(d.deliveryId);
      if (entry) entry.state = 'voided';
    }
    this.lastSeq = record.seq;
    for (const d of record.deliveries) {
      if (d.deliverySeq > this.lastDeliverySeq) this.lastDeliverySeq = d.deliverySeq;
    }
    this.rememberOutcome(record.txn.clientId, record.txn.reqId, record.outcome);
  }

  private rememberOutcome(clientId: string, reqId: string, outcome: unknown): void {
    let m = this.dedup.get(clientId);
    if (!m) {
      m = new Map();
      this.dedup.set(clientId, m);
    }
    m.set(reqId, outcome);
    while (m.size > DEDUP_WINDOW_PER_CLIENT) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }

  /**
   * Commit an effectful transaction: fsync before returning (spec: before
   * ack). `voidRecipients` closes every open delivery addressed to those
   * agents — pre-existing AND enqueued by this very txn — in the same record
   * (F18/F21: removal voids undelivered mail, including the stop-notice).
   */
  async commit(
    envelope: CommandEnvelope,
    events: readonly Event[],
    outcome: unknown,
    reqIdentity: { clientId: string; reqId: string },
    voidRecipients: readonly string[] = [],
  ): Promise<TxnRecord> {
    const deliveries: DeliveryRef[] = [];
    for (const event of events) {
      if (event.kind === 'message-sent') {
        deliveries.push({ deliveryId: `${event.id}:${event.to}`, deliverySeq: ++this.lastDeliverySeq });
      }
    }
    const voided: DeliveryRef[] = [];
    if (voidRecipients.length) {
      for (const open of this.open_.values()) {
        if (voidRecipients.includes(open.message.to)) voided.push({ deliveryId: open.deliveryId, deliverySeq: open.deliverySeq });
      }
      for (const event of events) {
        if (event.kind === 'message-sent' && voidRecipients.includes(event.to)) {
          const ref = deliveries.find((d) => d.deliveryId === `${event.id}:${event.to}`);
          if (ref) voided.push(ref);
        }
      }
    }
    const record: Omit<TxnRecord, 'crc32'> = {
      seq: this.lastSeq + 1,
      txn: reqIdentity,
      envelopeId: envelope.meta.id,
      principal: envelope.meta.principal,
      at: envelope.meta.at,
      events: [...events],
      deliveries,
      ...(voided.length ? { voided } : {}),
      outcome,
    };
    await this.appendLine(encodeRecord(record));
    this.applyRecord({ ...record, crc32: 0 });
    return { ...record, crc32: 0 };
  }

  /** Journal a delivery ack as its own txn (events: []). */
  async ackDelivery(deliveryId: string, byClientId: string, at: string): Promise<void> {
    if (!this.open_.has(deliveryId)) return; // idempotent
    const record: Omit<TxnRecord, 'crc32'> = {
      seq: this.lastSeq + 1,
      txn: { clientId: byClientId, reqId: `ack:${deliveryId}` },
      envelopeId: deliveryId,
      principal: byClientId,
      at,
      events: [],
      deliveries: [{ deliveryId, deliverySeq: this.open_.get(deliveryId)!.deliverySeq }],
      outcome: { ok: true },
    };
    await this.appendLine(encodeRecord(record));
    this.applyRecord({ ...record, crc32: 0 });
  }

  private async appendLine(line: string): Promise<void> {
    if (this.segmentBytes > SEGMENT_ROTATE_BYTES) {
      this.segmentIndex += 1;
      this.segmentBytes = 0;
    }
    const path = join(this.dir, segmentName(this.segmentIndex));
    const handle = await open(path, 'a');
    try {
      await handle.writeFile(`${line}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.segmentBytes += Buffer.byteLength(line, 'utf8') + 1;
  }

  /** Crash-safe snapshot (F12): write-new → fsync → rename → only then trim. */
  async snapshot(): Promise<void> {
    const snap: Snapshot = {
      state: this.state,
      lastSeq: this.lastSeq,
      lastDeliverySeq: this.lastDeliverySeq,
      dedup: Object.fromEntries([...this.dedup].map(([c, m]) => [c, Object.fromEntries(m)])),
      openDeliveries: this.openDeliveries(),
    };
    const target = join(this.dir, 'snapshot.json');
    const tmp = join(this.dir, `snapshot.json.${process.pid}.tmp`);
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(snap), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
    // Trim: only segments fully covered by the snapshot, never the active one.
    const segments = (await readdir(this.dir)).filter((n) => /^segment-\d{6}\.jsonl$/.test(n)).sort();
    for (const name of segments) {
      if (Number(name.slice(8, 14)) < this.segmentIndex) await rm(join(this.dir, name));
    }
    this.segmentIndex += 1;
    this.segmentBytes = 0;
  }

  private async loadSnapshot(): Promise<Snapshot | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, 'snapshot.json'), 'utf8')) as Snapshot;
    } catch {
      return undefined;
    }
  }
}
