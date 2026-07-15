import type { Command, CommandEnvelope } from '@core/commands.ts';
import { decide } from '@core/decide.ts';
import { ProtocolError } from '@core/errors.ts';
import type { Event } from '@core/events.ts';
import { evolve } from '@core/evolve.ts';
import { navigators, openGrants } from '@core/queries.ts';
import type { AgentId, SessionState } from '@core/types.ts';
import type { Clock, Ids, StoredMessage } from '@app/ports/index.ts';
import type { BrokerStatusDto, StatusDto } from '@app/ports/gateway.ts';
import type { LivenessDto, ObserverSnapshotDto } from '@app/ports/gateway.ts';
import { Journal, type OpenDelivery } from './journal.ts';
import { MirrorConflictError, type DeliverySink, type MessageCodec, type MirrorStore, type ObserverPushWire, type ObserverSink } from './ports.ts';

/**
 * Broker commit loop (BROKER-SPEC "Commit path"): receive → authenticate
 * (transport) → dedup → decide → append+fsync → evolve → ack requester →
 * mirrors → push deliveries. Single writer: every mutation runs through one
 * promise chain, so concurrent connections serialize here, not in the fs.
 *
 * Transport-free by design (depcruise broker-no-apps-no-adapters): the
 * composition root adapts wire frames to these methods and wraps
 * connections as DeliverySinks. Wire mapping for execute responses:
 * {reqId, ok, seq, events, data} where `data` carries the remaining
 * ExecuteOutcome fields {session, receipt, gitignoreUpdated?}. Queries
 * return their DTO in `data`.
 */

export type BrokerConfig = {
  idleGraceMs: number;
  heartbeatMs: number;
  deliveryLeaseMs: number;
};

export const DEFAULT_CONFIG: BrokerConfig = { idleGraceMs: 60_000, heartbeatMs: 10_000, deliveryLeaseMs: 90_000 };

/** PUBLIC command kinds — what the generic execute path accepts. The U1
 * user-channel kinds are deliberately absent: they exist only in their
 * internal shape, constructed by the authenticated user-connection handler
 * (transport gate, U1-SLICE3-DESIGN.md). */
const COMMAND_KINDS = new Set([
  'init-session', 'send-message', 'end-session',
  'issue-grant', 'accept-grant', 'complete-grant', 'cancel-grant',
  'revoke-turn', 'leave-session', 'join-session', 'kick-agent',
]);

/** Rejected on the generic path with a SPECIFIC error, even when forged. */
const USER_CHANNEL_KINDS = new Set(['user-message', 'register-user-channel']);

export type BrokerResponse =
  | { reqId: string; ok: true; seq?: number; events?: readonly Event[]; data?: unknown }
  | { reqId?: string; ok: false; error: { code: string; message: string } };

type Subscription = {
  sink: DeliverySink;
  as: AgentId;
  connectedSince: string;
  lastActivity: string;
};

type Lease = { deliveryId: string; holder: string; expiresAt: number };

export type BrokerHost = {
  /** Called after a drain completes (broker-stop or idle exit). */
  onStopped: (reason: 'stop-requested' | 'idle') => void;
  pid: number;
  epoch: number;
  endpoint: string;
  heartbeatAt: () => string;
};

export class BrokerCore {
  #journal: Journal;
  #mirrors: MirrorStore;
  #codec: MessageCodec;
  #clock: Clock;
  #ids: Ids;
  #config: BrokerConfig;
  #host: BrokerHost;

  #serial: Promise<unknown> = Promise.resolve();
  /** Mirror writes apply strictly in commit order — post-ack, but never
   * interleaved: a later txn's void must not run before an earlier txn's
   * inbox write (found live: kick-void racing the kicked mail's write). */
  #mirrorSerial: Promise<unknown> = Promise.resolve();
  #subscriptions = new Map<string, Subscription>(); // sink id → sub
  /** Watch observers — never in #subscriptions, so they can never hold a
   * lease, receive an agent delivery, or block revoke-turn (partner-active
   * scans #subscriptions only). Agreed design ruling (claude proposal,
   * codex review 2026-07-14): observers do NOT count toward idle-exit
   * busyness — a forgotten watch pane must not pin the daemon. Watch
   * reattaches without spawning; agents respawn the broker on demand. */
  #observers = new Map<string, ObserverSink>(); // sink id → observer
  #leases = new Map<string, Lease>(); // deliveryId → lease
  #connections = new Set<string>();
  #stopping = false;
  #conflict: MirrorConflictError | undefined;
  #lastBusyAt: number;
  #inFlight = 0;
  #idleTimer: ReturnType<typeof setInterval> | undefined;
  #sweepTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(pairDir: string, deps: { clock: Clock; ids: Ids; mirrors: MirrorStore; codec: MessageCodec }, config: BrokerConfig, host: BrokerHost) {
    this.#journal = new Journal(pairDir);
    this.#mirrors = deps.mirrors;
    this.#codec = deps.codec;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#config = config;
    this.#host = host;
    this.#lastBusyAt = Date.now();
  }

  get journal(): Journal {
    return this.#journal;
  }

  get stopping(): boolean {
    return this.#stopping;
  }

  /** Recovery: journal replay, then mirror reconcile (F8). Conflict → read-only. */
  async recover(): Promise<'clean' | 'rebuilt' | 'conflict'> {
    await this.#journal.recover();
    try {
      return await this.#mirrors.reconcile(this.#journal.sessionState, this.#journal.openDeliveries(), this.#journal.headSeq);
    } catch (error) {
      if (error instanceof MirrorConflictError) {
        this.#conflict = error;
        return 'conflict';
      }
      throw error;
    }
  }

  startIdleMonitor(): void {
    this.#idleTimer = setInterval(() => {
      // Observer connections are excluded: watching is not work (F9's "no
      // connections" reads "no participant connections" by design ruling).
      const participants = [...this.#connections].filter((id) => !this.#observers.has(id)).length;
      const idle = participants === 0 && this.#inFlight === 0 && this.#journal.openDeliveries().length === 0;
      if (!idle) {
        this.#lastBusyAt = Date.now();
        return;
      }
      if (Date.now() - this.#lastBusyAt >= this.#config.idleGraceMs) {
        this.#stopping = true; // F9: refuse new work BEFORE the host tears down
        this.#host.onStopped('idle');
      }
    }, Math.min(this.#config.idleGraceMs / 4, 5_000));
    this.#idleTimer.unref();
  }

  stopIdleMonitor(): void {
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    if (this.#sweepTimer) clearTimeout(this.#sweepTimer);
  }

  onConnection(id: string, event: 'open' | 'close'): void {
    if (event === 'open') {
      if (!this.#stopping) this.#connections.add(id);
      this.#lastBusyAt = Date.now();
      return;
    }
    this.#connections.delete(id);
    const wasListener = this.#subscriptions.delete(id);
    this.#observers.delete(id);
    // Leases held by the vanished connection expire naturally (F4); the
    // expiry sweep redelivers to the next live subscriber.
    if (wasListener) this.#notifyPresence(); // item 8: listener set changed
  }

  /** Single-writer serialization for every mutating path. */
  #chain<T>(work: () => Promise<T>): Promise<T> {
    this.#inFlight += 1;
    const next = this.#serial.then(work);
    this.#serial = next.catch(() => undefined).finally(() => {
      this.#inFlight -= 1;
    });
    return next;
  }

  execute(reqId: string, clientId: string, as: string, payload: unknown): Promise<BrokerResponse> {
    this.#lastBusyAt = Date.now();
    return this.#chain(() => this.#execute(reqId, clientId, as, payload));
  }

  async #execute(reqId: string, clientId: string, as: string, payload: unknown): Promise<BrokerResponse> {
    if (this.#stopping) return err(reqId, 'broker-stopping', 'Broker is draining; retry to respawn.');
    if (this.#conflict) return err(reqId, 'mirror-conflict', this.#conflict.message);
    const recorded = this.#journal.recordedOutcome(clientId, reqId);
    if (recorded !== undefined) return recorded as BrokerResponse; // F2: replay, never re-execute
    const forged = userChannelKindFrom(payload);
    if (forged) {
      // Transport gate (U1): even a forged as:'user' envelope on the
      // generic path never reaches decide.
      return err(reqId, 'user-channel-required', `'${forged}' may only originate from the authenticated user channel (user-attach connection).`);
    }
    const command = commandFrom(payload);
    if (!command) return err(reqId, 'bad-command', 'execute payload must be {command: {kind: <known-kind>, ...}}');
    const envelope: CommandEnvelope = {
      command,
      meta: { id: this.#ids.messageId(), at: this.#clock.now(), principal: as },
    };
    const state = this.#journal.sessionState;
    // 8a liveness pre-check — the fact pure decide cannot know: an active
    // delivery lease means the turn holder is mid-work; reject rather than
    // rob them. A missing listener or expired lease admits the revocation.
    if (command.kind === 'revoke-turn' && state && state.turn !== as) {
      const holder = state.turn;
      const now = Date.now();
      const live = [...this.#leases.values()].some((lease) => {
        if (lease.expiresAt <= now) return false;
        const sub = this.#subscriptions.get(lease.holder);
        return sub?.as === holder;
      });
      if (live) {
        return err(reqId, 'partner-active', `${holder} holds a live delivery lease (still working) — revocation rejected. Retry after the lease expires or the reply lands.`);
      }
    }
    const decided = decide(state, envelope);
    if (!decided.ok) {
      // Rejections are not journaled (pure decide; retries re-evaluate).
      const code = decided.error instanceof ProtocolError ? decided.error.code : 'rejected';
      return err(reqId, code, decided.error.message);
    }
    const events = decided.value;
    // F18/F21: roster removals void the agent's undelivered mail in the same
    // txn — capture the open set now (pre-commit) for the mirror moves.
    const removedAgents = events.flatMap((e) => (e.kind === 'agent-left' || e.kind === 'agent-kicked' ? [e.agent] : []));
    const voidedPreexisting = removedAgents.length
      ? this.#journal.openDeliveries().filter((d) => removedAgents.includes(d.message.to))
      : [];
    let gitignoreUpdated: boolean | undefined;
    if (command.kind === 'init-session') {
      // Init writes its mirror inline so gitignoreUpdated is truthful in the
      // outcome (rare path; documented deviation from post-ack mirroring).
      const postInit = events.reduce<SessionState | undefined>((s, e) => evolve(s, e), state);
      gitignoreUpdated = postInit ? (await this.#mirrors.applyInit(postInit)).gitignoreUpdated : undefined;
    }
    const receipt = {
      messageFiles: events.flatMap((e) =>
        e.kind === 'message-sent' ? [this.#codec.filename({ id: e.id, from: e.from, to: e.to, type: e.type, turn: e.turn, sent: e.at, body: e.body })] : [],
      ),
    };
    const response: BrokerResponse = {
      reqId,
      ok: true,
      seq: this.#journal.headSeq + 1,
      events: [...events],
      data: { session: undefined as unknown, receipt, ...(gitignoreUpdated === undefined ? {} : { gitignoreUpdated }) },
    };
    const record = await this.#journal.commit(envelope, events, response, { clientId, reqId }, removedAgents);
    const post = this.#journal.sessionState!;
    (response as { data: { session: unknown } }).data.session = post;
    const open = this.#journal.openDeliveries();
    const fresh = record.deliveries.flatMap((d) => {
      // Voided-in-same-txn deliveries are already closed — never pushed.
      const match = open.find((o) => o.deliveryId === d.deliveryId);
      return match ? [match] : [];
    });
    // Voided notices enqueued by THIS txn still need their mirror moved
    // inbox → archive (they were never open post-commit).
    const voidedNew = removedAgents.length
      ? record.events.flatMap((e) =>
          e.kind === 'message-sent' && removedAgents.includes(e.to)
            ? [{ deliveryId: `${e.id}:${e.to}`, deliverySeq: 0, message: e }]
            : [],
        )
      : [];
    // Ack the requester first (the return), then mirrors + delivery push,
    // with mirror application serialized in commit order.
    const voided = [...voidedPreexisting, ...voidedNew];
    this.#mirrorSerial = this.#mirrorSerial.then(() => this.#afterCommit(post, record.events, record.seq, fresh, voided));
    // Observer fan-out happens HERE, synchronously at commit inside the
    // single-writer chain — never on the mirror chain. Commit order = call
    // order = per-socket write order, so an ack activity (also emitted
    // in-chain) can never overtake the send activity it acknowledges
    // (codex live review 2026-07-14).
    this.#notifyObservers({
      kind: 'activity',
      seq: record.seq,
      at: record.at,
      principal: record.principal,
      events: record.events,
      session: post,
      ackedDeliveryIds: [],
      voidedDeliveryIds: voided.map((d) => d.deliveryId),
    });
    return response;
  }

  async #afterCommit(state: SessionState, events: readonly Event[], seq: number, deliveries: OpenDelivery[], voided: OpenDelivery[] = []): Promise<void> {
    try {
      await this.#mirrors.applyEvents(state, events, seq);
      // Voided mail lands in the archive, never a removed agent's inbox (F18).
      for (const delivery of voided) await this.#mirrors.applyAck(delivery, seq);
    } catch {
      /* mirror lag is recoverable by rebuild on next recovery */
    }
    for (const delivery of deliveries) this.#push(delivery);
  }

  /** Best-effort observer fan-out: a dead observer is dropped, never retried
   * (it owns nothing — reattach serves a fresh snapshot). */
  #notifyObservers(push: ObserverPushWire): void {
    for (const [id, observer] of this.#observers) {
      void observer.sendObserver(push).catch(() => this.#observers.delete(id));
    }
  }

  #notifyPresence(): void {
    if (this.#observers.size) this.#notifyObservers({ kind: 'presence', liveness: this.#liveness() });
  }

  #liveness(): LivenessDto {
    const agents: Record<string, { connectedSince?: string; lastActivity?: string }> = {};
    for (const sub of this.#subscriptions.values()) {
      agents[sub.as] = { connectedSince: sub.connectedSince, lastActivity: sub.lastActivity };
    }
    return {
      broker: { pid: this.#host.pid, epoch: this.#host.epoch, heartbeatAt: this.#host.heartbeatAt() },
      agents,
    };
  }

  /** Push one open delivery to a live subscriber (single lease holder, F5). */
  #push(delivery: OpenDelivery): void {
    const existing = this.#leases.get(delivery.deliveryId);
    if (existing && existing.expiresAt > Date.now() && this.#subscriptions.has(existing.holder)) return;
    const sub = [...this.#subscriptions.values()].find((s) => s.as === delivery.message.to);
    if (!sub) return; // stays open; next subscribe picks it up
    this.#leases.set(delivery.deliveryId, {
      deliveryId: delivery.deliveryId,
      holder: sub.sink.id,
      expiresAt: Date.now() + this.#config.deliveryLeaseMs,
    });
    sub.lastActivity = this.#clock.now();
    void sub.sink
      .sendDelivery({ kind: 'delivery', deliverySeq: delivery.deliverySeq, deliveryId: delivery.deliveryId, message: this.#toStored(delivery) })
      .catch(() => this.#leases.delete(delivery.deliveryId));
    this.#notifyPresence(); // lastActivity moved (item 8 progress signal)
    this.#scheduleLeaseSweep();
  }

  #scheduleLeaseSweep(): void {
    if (this.#sweepTimer) return;
    this.#sweepTimer = setTimeout(() => {
      this.#sweepTimer = undefined;
      const now = Date.now();
      for (const [id, lease] of [...this.#leases]) {
        if (lease.expiresAt <= now || !this.#subscriptions.has(lease.holder)) {
          this.#leases.delete(id);
          const open = this.#journal.openDeliveries().find((d) => d.deliveryId === id);
          if (open) this.#push(open); // F4 redelivery
        }
      }
      if (this.#leases.size) this.#scheduleLeaseSweep();
    }, 1_000);
    this.#sweepTimer.unref();
  }

  subscribe(reqId: string, sink: DeliverySink, as: string, afterDeliverySeq: number): Promise<BrokerResponse> {
    // The cursor exists for closed-history suppression; the ledger holds no
    // closed history to replay, so open/unacked-beats-cursor consumes it
    // entirely (frozen contract) — accepted for wire compatibility.
    void afterDeliverySeq;
    this.#lastBusyAt = Date.now();
    return this.#chain(async () => {
      if (this.#stopping) {
        return err(reqId, 'broker-stopping', 'Broker is draining; retry to respawn.');
      }
      this.#subscriptions.set(sink.id, { sink, as, connectedSince: this.#clock.now(), lastActivity: this.#clock.now() });
      this.#notifyPresence(); // item 8: listener appeared
      // Open/unacked beats cursor (frozen rule): every open delivery for
      // this agent is offered regardless of the presented cursor; the
      // ledger holds no closed history to replay, so the cursor's job ends
      // here by construction.
      for (const delivery of this.#journal.openDeliveriesFor(as)) this.#push(delivery);
      return { reqId, ok: true };
    });
  }

  /**
   * Attach a read-only observer (watch). Non-consuming by contract: the
   * sink is registered OUTSIDE #subscriptions, so it can never receive an
   * agent delivery, hold a lease, or count as partner-active. The snapshot
   * is 100% journal-derived (session state + transcript ring) — the broker
   * never trusts its own mirrors for a view it labels authoritative (codex
   * review ruling: mirrors would need parity/tamper validation here).
   * No history replay: reattach = fresh snapshot. Deliberately does NOT
   * touch #lastBusyAt — watching is not work; see #observers on idle.
   */
  observe(reqId: string, sink: ObserverSink): Promise<BrokerResponse> {
    return this.#chain(async () => {
      if (this.#stopping) return err(reqId, 'broker-stopping', 'Broker is draining; retry to respawn.');
      const state = this.#journal.sessionState;
      if (!state) return err(reqId, 'session-not-active', 'No session in journal.');
      // Registration and every activity notify both run inside the commit
      // chain, so an observer registered at head N receives exactly the
      // txns with seq > N — no stale push for commits its snapshot already
      // contains, no gap, by construction.
      this.#observers.set(sink.id, sink);
      const transcript = this.#journal.transcript().map((t) => ({
        message: this.#toStored({ deliveryId: t.deliveryId, deliverySeq: 0, message: t.message }),
        pending: t.state === 'open',
        ...(t.state === 'voided' ? { voided: true } : {}),
      }));
      const snapshot: ObserverSnapshotDto = {
        seq: this.#journal.headSeq,
        session: state,
        transcript,
        liveness: this.#liveness(),
        broker: { pid: this.#host.pid, epoch: this.#host.epoch, endpoint: this.#host.endpoint, heartbeatAt: this.#host.heartbeatAt() },
      };
      return { reqId, ok: true, data: snapshot };
    });
  }

  ack(reqId: string, deliveryId: string, clientId: string): Promise<BrokerResponse> {
    this.#lastBusyAt = Date.now();
    return this.#chain(async () => {
      const open = this.#journal.openDeliveries().find((d) => d.deliveryId === deliveryId);
      if (!open) return { reqId, ok: true }; // idempotent (F5/F11)
      const at = this.#clock.now();
      await this.#journal.ackDelivery(deliveryId, clientId, at);
      this.#leases.delete(deliveryId);
      const seq = this.#journal.headSeq;
      this.#mirrorSerial = this.#mirrorSerial.then(() =>
        this.#mirrors.applyAck(open, seq).catch(() => undefined /* mirror lag recoverable */),
      );
      // Ack txns flip a transcript entry pending → delivered in the watch.
      this.#notifyObservers({
        kind: 'activity',
        seq,
        at,
        principal: clientId,
        events: [],
        session: this.#journal.sessionState!,
        ackedDeliveryIds: [deliveryId],
        voidedDeliveryIds: [],
      });
      return { reqId, ok: true };
    });
  }

  extend(reqId: string, deliveryId: string): BrokerResponse {
    const lease = this.#leases.get(deliveryId);
    if (lease) lease.expiresAt = Date.now() + this.#config.deliveryLeaseMs;
    return { reqId, ok: true };
  }

  async query(reqId: string, what: string, args?: unknown): Promise<BrokerResponse> {
    this.#lastBusyAt = Date.now();
    if (what === 'broker-status') return { reqId, ok: true, data: this.#brokerStatus() };
    if (what === 'broker-stop') {
      this.#stopping = true;
      await this.#serial; // finish in-flight txn (drain)
      // The composition root schedules the actual teardown AFTER this
      // response has been written — respond-then-close is the drain order.
      return { reqId, ok: true, data: { stopping: true } };
    }
    if (this.#conflict && what !== 'status') return err(reqId, 'mirror-conflict', this.#conflict.message);
    if (what === 'status') {
      const state = this.#journal.sessionState;
      if (!state) return err(reqId, 'session-not-active', 'No session in journal.');
      return { reqId, ok: true, data: await this.#status(state) };
    }
    if (what === 'grants') {
      const state = this.#journal.sessionState;
      return { reqId, ok: true, data: state ? Object.values(state.grants) : [] };
    }
    if (what === 'log' || what.startsWith('log:')) {
      const requested = args && typeof args === 'object' ? Number((args as { tail?: unknown }).tail) : NaN;
      const tail = what.startsWith('log:') ? Number(what.slice(4)) || 10 : Number.isFinite(requested) ? requested : 10;
      return { reqId, ok: true, data: await this.#mirrors.archived(tail) };
    }
    return err(reqId, 'unknown-query', `Unknown query: ${what}`);
  }

  async #status(state: SessionState): Promise<StatusDto> {
    const pending: Record<string, StoredMessage[]> = {};
    for (const agent of state.agents) pending[agent] = this.#journal.openDeliveriesFor(agent).map((d) => this.#toStored(d));
    return {
      session: state,
      navigators: navigators(state),
      openGrants: openGrants(state),
      pending,
      recent: await this.#mirrors.archived(3),
      liveness: this.#liveness(),
    };
  }

  #brokerStatus(): BrokerStatusDto {
    return {
      running: true,
      pid: this.#host.pid,
      epoch: this.#host.epoch,
      endpoint: this.#host.endpoint,
      heartbeatAt: this.#host.heartbeatAt(),
      connections: this.#connections.size,
      journalHeadSeq: this.#journal.headSeq,
      openDeliveries: this.#journal.openDeliveries().length,
    };
  }

  #toStored(delivery: OpenDelivery): StoredMessage {
    const m = delivery.message;
    const pair = { id: m.id, from: m.from, to: m.to, type: m.type, turn: m.turn, sent: m.at, body: m.body };
    return {
      name: this.#codec.filename(pair),
      header: { id: m.id, from: m.from, to: m.to, type: m.type, turn: m.turn, sent: m.at },
      body: m.body,
      raw: this.#codec.raw(pair),
    };
  }
}

function commandFrom(payload: unknown): Command | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const command = (payload as { command?: unknown }).command;
  if (!command || typeof command !== 'object') return undefined;
  const kind = (command as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !COMMAND_KINDS.has(kind)) return undefined;
  return command as Command;
}

function userChannelKindFrom(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const command = (payload as { command?: unknown }).command;
  if (!command || typeof command !== 'object') return undefined;
  const kind = (command as { kind?: unknown }).kind;
  return typeof kind === 'string' && USER_CHANNEL_KINDS.has(kind) ? kind : undefined;
}

const err = (reqId: string, code: string, message: string): BrokerResponse => ({ ...(reqId ? { reqId } : {}), ok: false, error: { code, message } });
