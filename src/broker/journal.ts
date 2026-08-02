import { createHash } from 'node:crypto';
import { open, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandEnvelope } from '@core/commands.ts';
import type { Event } from '@core/events.ts';
import { evolve } from '@core/evolve.ts';
import { EMPTY_DRAFT_HASH } from '@core/types.ts';
import { applyMessageToAwaiting, removeAgentFromAwaiting, type AwaitingEntry } from '@core/awaiting.ts';
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
  /**
   * Peer 1A: BROKER-PRIVATE credential verifiers, CRC-covered with the
   * record but NEVER projected (no event, state, outcome, mirror, or
   * observer surface carries them — codex rev 4). null revokes.
   */
  privateBindings?: Record<string, { hash: string; credentialVersion: number } | null>;
  /**
   * Peer 1B: protocol-sealed proposal bodies — blind-by-conduct, NOT
   * cryptographically confidential (same-OS-user shell can read the
   * journal; agents are forbidden by instruction). CRC-covered; the ONLY
   * pre-reveal home of a body.
   */
  sealed?: Record<string, { bytes: number; contentHash: string; body: string }>;
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
  /** Bounded recent-history ring (observer snapshots). Optional: legacy
   * snapshots lack it — recovery then seeds the ring from openDeliveries so
   * pre-snapshot open mail is never invisible to watch (codex review). */
  transcript?: TranscriptRecord[];
  /** Peer 1B: unrevealed sealed bodies — inlined so segment trim can
   * never orphan one. */
  sealedProposals?: Record<string, { bytes: number; contentHash: string; body: string }>;
  /** Peer 1B: the durable artifact view (phase discriminant + bodies). */
  planningArtifacts?: PlanningArtifacts;
  /** Peer 1A: private verifier map persisted across snapshots. Entries
   * WITHOUT a hash are pending-rebind (revoked): the version must survive
   * restart so the next TOFU binds at version+1, and the REVOKED hash is
   * kept as a denylist so the old secret can never re-bind (round 3 #1). */
  bindings?: Record<string, { hash?: string; credentialVersion: number; revokedHashes?: string[] }>;
  /** Item 7: first-class awaiting-set (asks not yet validly answered).
   * Persisted so cap pressure on the transcript ring can never lose an
   * unresolved ask across restart. Optional: a legacy snapshot lacks it —
   * recovery then seeds best-effort from the (bounded) transcript. */
  awaiting?: AwaitingEntry[];
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

/** Peer 1B: the ONE authoritative artifact view (design rev 2 #7, rev 4
 * #5). `phase` is a DURABLE discriminant independent of session phase:
 * none -> sealed (first proposal) -> revealed (barrier) | discarded
 * (force-phase from collecting) — discarded/revealed stick forever. */
export type PlanningArtifacts = {
  phase: 'none' | 'sealed' | 'discarded' | 'revealed';
  proposals: Record<string, { contentHash: string; bytes: number; at: string; body: string }>;
  draft: { revision: number; hash: string; author: string | null; at: string; body: string } | null;
  revisionLog: { revision: number; hash: string; author: string | null; at: string }[];
  /** Ruling C: entries self-verify (kind/bytes/textHash) even after later
   * phases drop SessionState finding metadata. Populated in 1B-c. */
  findingTexts: Record<string, { actor: string; at: string; kind: string; disposition?: string; bytes: number; textHash: string; text: string }[]>;
};

const EMPTY_ARTIFACTS: PlanningArtifacts = { phase: 'none', proposals: {}, draft: null, revisionLog: [], findingTexts: {} };

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

/** Exported for read-only diagnostic consumers (`pair stats` reads segments
 * directly per the architecture's diagnostics rule) — decode + CRC-verify
 * one NDJSON line, undefined on any mismatch. */
export function decodeRecord(line: string): TxnRecord | undefined {
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

const sha256HexJournal = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Legacy-snapshot fallback only: replay the shared rule over the bounded
 * transcript. Honest gap — an ask already trimmed from a LEGACY snapshot's
 * ring is unrecoverable; every new snapshot persists awaiting first-class. */
/** M1 legacy tolerance: a pre-M1 snapshot's state has no registry —
 * synthesize v0 from the live roster (joinedAt = session start; correct
 * versioning begins with the next membership change). */
function normalizeRegistry(state: SessionState | undefined): SessionState | undefined {
  if (!state) return state;
  const legacy = state as SessionState & { registry?: SessionState['registry'] };
  if (legacy.registry) return state;
  return {
    ...legacy,
    registry: {
      version: 0,
      agents: Object.fromEntries(legacy.agents.map((a) => [a, { id: a, display: a, status: 'active' as const, joinedAt: legacy.started }])),
    },
  };
}

/** M1 legacy upgrade: add active records for live agents the replayed
 * registry never saw, and mark records for departed agents left. Version
 * is untouched (legacy history has no versioned transitions to claim). */
function reconcileRegistryProjection(state: SessionState | undefined): SessionState | undefined {
  // Pair only: legacy pre-M1 journals are pair by definition, and a PEER
  // session's registry legitimately holds authorized-but-unadmitted
  // records that agents[] does not include (1A bootstrap) — reconciling
  // those to 'left' would corrupt the admitting substate on restart.
  if (!state || state.topology !== 'pair') return state;
  const agents: Record<string, import('@core/types.ts').AgentRecord> = { ...state.registry.agents };
  let dirty = false;
  for (const a of state.agents) {
    if (agents[a]?.status !== 'active') {
      agents[a] = { id: a, display: agents[a]?.display ?? a, status: 'active', joinedAt: agents[a]?.joinedAt ?? state.started };
      dirty = true;
    }
  }
  for (const [id, rec] of Object.entries(agents)) {
    if (rec.status === 'active' && !state.agents.includes(id)) {
      agents[id] = { ...rec, status: 'left' };
      dirty = true;
    }
  }
  return dirty ? { ...state, registry: { ...state.registry, agents } } : state;
}

function legacyAwaitingFrom(transcript: readonly TranscriptRecord[]): AwaitingEntry[] {
  const map = new Map<string, AwaitingEntry>();
  for (const t of transcript) {
    const m = t.message;
    applyMessageToAwaiting(map, { id: m.id, from: m.from, to: m.to, type: m.type, sent: m.at, ...(m.replyTo === undefined ? {} : { replyTo: m.replyTo }) });
  }
  return [...map.values()];
}

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
  /** Item 7: authoritative awaiting-set — replayed with the records and
   * persisted in snapshots, NEVER derived from the bounded ring. */
  private awaiting_ = new Map<string, AwaitingEntry>();
  /** Peer 1A: broker-private credential verifiers (agent → hash+version).
   * A revoked binding keeps its version (hash cleared, moved to
   * revokedHash) so the next TOFU binds at version+1 AND the old secret
   * is rejected forever (round 3 #1). */
  private bindings_ = new Map<string, { hash?: string; credentialVersion: number; revokedHashes?: string[] }>();
  /** Peer 1B: pre-reveal sealed bodies (author → blob). */
  private sealed_ = new Map<string, { bytes: number; contentHash: string; body: string }>();
  private artifacts_: PlanningArtifacts = structuredClone(EMPTY_ARTIFACTS);
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
  /** Item 7: asks awaiting a valid reply (authoritative, journal-derived). */
  awaiting(): AwaitingEntry[] {
    return [...this.awaiting_.values()];
  }
  /** Peer 1A: the PRIVATE verifier for an agent (never projected). */
  binding(agent: string): { hash?: string; credentialVersion: number; revokedHashes?: string[] } | undefined {
    return this.bindings_.get(agent);
  }
  /** Peer 1B: the authoritative artifact view (broker shapes per-phase
   * query redaction; sealed bodies are NEVER in here pre-reveal). */
  planningArtifacts(): PlanningArtifacts {
    return this.artifacts_;
  }
  /** Peer 1B: pre-reveal sealed blob access for the broker's reveal
   * verification (never projected). */
  sealedProposal(author: string): { bytes: number; contentHash: string; body: string } | undefined {
    return this.sealed_.get(author);
  }

  /** 1B-c: the state Finding for `id` while converging/blocked, else
   * undefined — the stable author/addressedTo source for a findingTexts entry. */
  private findingFromState(id: string): import('@core/types.ts').Finding | undefined {
    const state = this.state;
    if (state?.topology !== 'peer') return undefined;
    if (state.planning?.substate !== 'converging' && state.planning?.substate !== 'convergence-blocked') return undefined;
    return state.planning.findings[id];
  }

  /** Committed-success dedup lookup (spec: rejections re-evaluate). */
  recordedOutcome(clientId: string, reqId: string): unknown | undefined {
    return this.dedup.get(clientId)?.get(reqId);
  }

  async recover(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const snapshot = await this.loadSnapshot();
    if (snapshot) {
      this.state = normalizeRegistry(snapshot.state);
      this.lastSeq = snapshot.lastSeq;
      this.lastDeliverySeq = snapshot.lastDeliverySeq;
      this.dedup = new Map(Object.entries(snapshot.dedup).map(([c, m]) => [c, new Map(Object.entries(m))]));
      this.open_ = new Map(snapshot.openDeliveries.map((d) => [d.deliveryId, d]));
      // Restore the transcript ring; a legacy snapshot without one still
      // must not hide real open mail from observers — seed from open set.
      const seeded = snapshot.transcript ?? snapshot.openDeliveries.map(
        (d): TranscriptRecord => ({ deliveryId: d.deliveryId, message: d.message, state: 'open' }),
      );
      this.transcript_ = new Map(seeded.map((t) => [t.deliveryId, t]));
      // Awaiting: first-class from the snapshot. A legacy snapshot without
      // it seeds best-effort from the bounded transcript — new snapshots
      // persist the set itself, closing the cap-pressure gap.
      const awaiting = snapshot.awaiting ?? legacyAwaitingFrom(seeded);
      this.awaiting_ = new Map(awaiting.map((a) => [a.messageId, a]));
      this.bindings_ = new Map(Object.entries(snapshot.bindings ?? {}));
      this.sealed_ = new Map(Object.entries(snapshot.sealedProposals ?? {}));
      this.artifacts_ = snapshot.planningArtifacts ?? structuredClone(EMPTY_ARTIFACTS);
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
    // M1 legacy upgrade: pre-M1 segments replay membership without
    // registry-updated events — force the registry to agree with the live
    // projection (new sessions are consistent by construction; this is a
    // no-op for them).
    this.state = reconcileRegistryProjection(this.state);
    this.verifyArtifactIntegrity();
  }

  /** Peer 1B: every cached body must hash-verify; while converging, the
   * revisionLog must deep-equal the state copy; findingTexts entries
   * self-verify per index (Ruling C). Any mismatch is fail-closed. */
  private verifyArtifactIntegrity(): void {
    const bad = (what: string): never => {
      throw new CorruptJournalError(`planning-artifacts (${what})`, 0);
    };
    for (const [author, blob] of this.sealed_) {
      if (sha256HexJournal(blob.body) !== blob.contentHash || Buffer.byteLength(blob.body, 'utf8') !== blob.bytes) bad(`sealed:${author}`);
    }
    for (const [author, p] of Object.entries(this.artifacts_.proposals)) {
      if (sha256HexJournal(p.body) !== p.contentHash || Buffer.byteLength(p.body, 'utf8') !== p.bytes) bad(`proposal:${author}`);
    }
    if (this.artifacts_.draft && this.artifacts_.draft.revision > 0 && sha256HexJournal(this.artifacts_.draft.body) !== this.artifacts_.draft.hash) bad('draft');
    for (const [id, entries] of Object.entries(this.artifacts_.findingTexts)) {
      for (const e of entries) {
        if (sha256HexJournal(e.text) !== e.textHash || Buffer.byteLength(e.text, 'utf8') !== e.bytes) bad(`finding:${id}`);
      }
    }
    const state = this.state;
    if (state?.topology === 'peer' && (state.planning?.substate === 'converging' || state.planning?.substate === 'convergence-blocked')) {
      if (JSON.stringify(state.planning.revisionLog) !== JSON.stringify(this.artifacts_.revisionLog)) bad('revision-log-divergence');
      // Ruling C cross-check: findingTexts and the state findings must agree.
      // No artifacts key may exist without a matching state finding, and each
      // finding's TEXT-BEARING history entries (bytes > 0) pair one-to-one, in
      // order, with the stored entries — a removed/reordered/extra entry fails
      // closed.
      const findings = state.planning.findings;
      for (const id of Object.keys(this.artifacts_.findingTexts)) {
        if (!findings[id]) bad(`finding-orphan:${id}`);
      }
      for (const [id, finding] of Object.entries(findings)) {
        const textBearing = finding.history.filter((e) => e.bytes > 0);
        const stored = this.artifacts_.findingTexts[id] ?? [];
        if (textBearing.length !== stored.length) bad(`finding-count:${id}`);
        for (let i = 0; i < textBearing.length; i++) {
          const h = textBearing[i]!;
          const t = stored[i]!;
          if (h.actor !== t.actor || h.at !== t.at || h.kind !== t.kind || h.bytes !== t.bytes || h.textHash !== t.textHash) bad(`finding-entry:${id}[${i}]`);
        }
      }
    }
  }

  private applyRecord(record: TxnRecord): void {
    for (const event of record.events) {
      this.state = evolve(this.state, event);
      // Item 7: the awaiting-set replays with the records themselves — the
      // shared core rule decides registration/resolution; membership events
      // clean up entries a removed agent can no longer answer.
      if (event.kind === 'message-sent') applyMessageToAwaiting(this.awaiting_, { id: event.id, from: event.from, to: event.to, type: event.type, sent: event.at, ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }) });
      else if (event.kind === 'agent-left' || event.kind === 'agent-kicked') removeAgentFromAwaiting(this.awaiting_, event.agent);
      // T4: lapsed-consent closes the ask debt — recorded, never silent.
      else if (event.kind === 'review-lapsed') this.awaiting_.delete(event.id);
      // (peer bindings replay from record.privateBindings below, not events)
      else if (event.kind === 'session-ended') this.awaiting_.clear();
      if (event.kind === 'message-sent') {
        const ref = record.deliveries.find((d) => d.deliveryId === `${event.id}:${event.to}`);
        if (ref) {
          this.open_.set(ref.deliveryId, { ...ref, message: event });
          this.transcript_.set(ref.deliveryId, { deliveryId: ref.deliveryId, message: event, state: 'open' });
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
    for (const [author, blob] of Object.entries(record.sealed ?? {})) {
      this.sealed_.set(author, blob);
      if (this.artifacts_.phase === 'none') this.artifacts_.phase = 'sealed';
    }
    for (const event of record.events) {
      if (event.kind === 'barrier-revealed') {
        for (const author of event.electorate) {
          const blob = this.sealed_.get(author);
          if (blob) this.artifacts_.proposals[author] = { contentHash: blob.contentHash, bytes: blob.bytes, at: event.at, body: blob.body };
        }
        this.sealed_.clear();
        this.artifacts_.phase = 'revealed';
        this.artifacts_.draft = { revision: 0, hash: EMPTY_DRAFT_HASH, author: null, at: event.at, body: '' };
        this.artifacts_.revisionLog = [{ revision: 0, hash: EMPTY_DRAFT_HASH, author: null, at: event.at }];
      } else if (event.kind === 'phase-transition' && this.artifacts_.phase === 'sealed') {
        // Force-phase from collecting discards unrevealed proposals; the
        // discriminant sticks forever (rev 4 #5).
        this.sealed_.clear();
        this.artifacts_.phase = 'discarded';
      } else if (event.kind === 'draft-amended') {
        // 1B-b: the durable content carrier — the journal's artifacts_
        // becomes the authoritative body home (verifyArtifactIntegrity
        // hash-checks it below, and cross-checks revisionLog vs state).
        this.artifacts_.draft = { revision: event.revision, hash: event.hash, author: event.author, at: event.at, body: event.content };
        this.artifacts_.revisionLog = [...this.artifacts_.revisionLog, { revision: event.revision, hash: event.hash, author: event.author, at: event.at }];
      } else if (event.kind === 'finding-filed' || event.kind === 'finding-responded' || event.kind === 'finding-confirmed' || event.kind === 'finding-amended') {
        // Ruling C: the artifacts store is the self-verifying home for finding
        // texts — each entry carries actor/at/kind/bytes/textHash + the body,
        // so it survives even after a later phase drops the SessionState
        // metadata. A no-text amend (bytes 0) records NO entry. Fields are
        // derived from the STATE finding (stable author/addressedTo) so the
        // cross-check pairs one-to-one with the state history by index.
        const bytes = event.kind === 'finding-amended' ? (event.bytes ?? 0) : event.bytes;
        const finding = this.findingFromState(event.id);
        if (bytes > 0 && finding) {
          const actor = event.kind === 'finding-responded' ? finding.addressedTo : finding.author;
          const kind = event.kind === 'finding-filed' ? 'filed' : event.kind === 'finding-responded' ? 'responded' : event.kind === 'finding-confirmed' ? 'confirmed' : 'amended';
          const disposition = event.kind === 'finding-responded' ? event.disposition : event.kind === 'finding-confirmed' ? event.verdict : event.kind === 'finding-amended' ? event.action : undefined;
          const textHash = event.kind === 'finding-amended' ? (event.textHash ?? '') : event.textHash;
          const text = event.kind === 'finding-amended' ? (event.text ?? '') : event.text;
          const entry = { actor, at: event.at, kind, ...(disposition !== undefined ? { disposition } : {}), bytes, textHash, text };
          (this.artifacts_.findingTexts[event.id] ??= []).push(entry);
        }
      }
    }
    for (const [agent, verifier] of Object.entries(record.privateBindings ?? {})) {
      if (verifier === null) {
        // Revocation DERIVES the denylist from the prior verifier — the
        // record stores null (no re-written hash material); replay and
        // snapshots reproduce it. Round 4 #1: the denylist ACCUMULATES
        // across every rotation — an offline v1 secret stays rejected
        // through v2, v3, ... forever.
        const prev = this.bindings_.get(agent);
        if (prev) {
          const revokedHashes = [...(prev.revokedHashes ?? []), ...(prev.hash !== undefined ? [prev.hash] : [])];
          this.bindings_.set(agent, { credentialVersion: prev.credentialVersion, ...(revokedHashes.length ? { revokedHashes } : {}) });
        }
      } else {
        // A fresh bind PRESERVES the accumulated denylist.
        const prev = this.bindings_.get(agent);
        this.bindings_.set(agent, { ...verifier, ...(prev?.revokedHashes?.length ? { revokedHashes: prev.revokedHashes } : {}) });
      }
    }
    this.lastSeq = record.seq;
    for (const d of record.deliveries) {
      if (d.deliverySeq > this.lastDeliverySeq) this.lastDeliverySeq = d.deliverySeq;
    }
    this.rememberOutcome(record.txn.clientId, record.txn.reqId, record.outcome);
    // After EVERY transition (insert, ack, void): entries closed by this
    // record are trimmable now — without this, 200+ open records that later
    // all close with no further send would exceed the cap forever (codex
    // review round 3).
    this.trimClosedHistory();
  }

  /** Cap evicts CLOSED history only — an open delivery is live mail the
   * watch must never undercount; the ring may exceed the cap while
   * everything in it is still open. */
  private trimClosedHistory(): void {
    if (this.transcript_.size <= TRANSCRIPT_RING_MAX) return;
    for (const [key, record] of this.transcript_) {
      if (this.transcript_.size <= TRANSCRIPT_RING_MAX) break;
      if (record.state !== 'open') this.transcript_.delete(key);
    }
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
    privateBindings?: Record<string, { hash: string; credentialVersion: number } | null>,
    sealed?: Record<string, { bytes: number; contentHash: string; body: string }>,
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
      ...(privateBindings === undefined ? {} : { privateBindings }),
      ...(sealed === undefined ? {} : { sealed }),
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
      transcript: this.transcript(),
      awaiting: this.awaiting(),
      bindings: Object.fromEntries(this.bindings_),
      sealedProposals: Object.fromEntries(this.sealed_),
      planningArtifacts: this.artifacts_,
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
