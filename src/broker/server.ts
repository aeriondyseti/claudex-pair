import type { Command, CommandEnvelope } from '@core/commands.ts';
import { decide } from '@core/decide.ts';
import { ProtocolError } from '@core/errors.ts';
import type { Event } from '@core/events.ts';
import { evolve } from '@core/evolve.ts';
import { navigators, openGrants } from '@core/queries.ts';
import type { AgentId, SessionState } from '@core/types.ts';
import type { Clock, Ids, StoredMessage } from '@app/ports/index.ts';
import type { BrokerStatusDto, StatusDto } from '@app/ports/gateway.ts';
import { Journal, type OpenDelivery } from './journal.ts';
import { MirrorConflictError, type DeliverySink, type MessageCodec, type MirrorStore } from './ports.ts';

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

const COMMAND_KINDS = new Set([
  'init-session', 'send-message', 'end-session',
  'issue-grant', 'accept-grant', 'complete-grant', 'cancel-grant',
]);

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
  #subscriptions = new Map<string, Subscription>(); // sink id → sub
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
      const idle = this.#connections.size === 0 && this.#inFlight === 0 && this.#journal.openDeliveries().length === 0;
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
    this.#subscriptions.delete(id);
    // Leases held by the vanished connection expire naturally (F4); the
    // expiry sweep redelivers to the next live subscriber.
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
    const command = commandFrom(payload);
    if (!command) return err(reqId, 'bad-command', 'execute payload must be {command: {kind: <known-kind>, ...}}');
    const envelope: CommandEnvelope = {
      command,
      meta: { id: this.#ids.messageId(), at: this.#clock.now(), principal: as },
    };
    const state = this.#journal.sessionState;
    const decided = decide(state, envelope);
    if (!decided.ok) {
      // Rejections are not journaled (pure decide; retries re-evaluate).
      const code = decided.error instanceof ProtocolError ? decided.error.code : 'rejected';
      return err(reqId, code, decided.error.message);
    }
    const events = decided.value;
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
    const record = await this.#journal.commit(envelope, events, response, { clientId, reqId });
    const post = this.#journal.sessionState!;
    (response as { data: { session: unknown } }).data.session = post;
    const open = this.#journal.openDeliveries();
    const fresh = record.deliveries.flatMap((d) => {
      const match = open.find((o) => o.deliveryId === d.deliveryId);
      return match ? [match] : [];
    });
    // Ack the requester first (the return), then mirrors + delivery push.
    void this.#afterCommit(post, record.events, record.seq, fresh);
    return response;
  }

  async #afterCommit(state: SessionState, events: readonly Event[], seq: number, deliveries: OpenDelivery[]): Promise<void> {
    try {
      await this.#mirrors.applyEvents(state, events, seq);
    } catch {
      /* mirror lag is recoverable by rebuild on next recovery */
    }
    for (const delivery of deliveries) this.#push(delivery);
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
      // Open/unacked beats cursor (frozen rule): every open delivery for
      // this agent is offered regardless of the presented cursor; the
      // ledger holds no closed history to replay, so the cursor's job ends
      // here by construction.
      for (const delivery of this.#journal.openDeliveriesFor(as)) this.#push(delivery);
      return { reqId, ok: true };
    });
  }

  ack(reqId: string, deliveryId: string, clientId: string): Promise<BrokerResponse> {
    this.#lastBusyAt = Date.now();
    return this.#chain(async () => {
      const open = this.#journal.openDeliveries().find((d) => d.deliveryId === deliveryId);
      if (!open) return { reqId, ok: true }; // idempotent (F5/F11)
      await this.#journal.ackDelivery(deliveryId, clientId, this.#clock.now());
      this.#leases.delete(deliveryId);
      try {
        await this.#mirrors.applyAck(open, this.#journal.headSeq);
      } catch {
        /* mirror lag recoverable */
      }
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
    const agents: Record<string, { connectedSince?: string; lastActivity?: string }> = {};
    for (const sub of this.#subscriptions.values()) {
      agents[sub.as] = { connectedSince: sub.connectedSince, lastActivity: sub.lastActivity };
    }
    return {
      session: state,
      navigators: navigators(state),
      openGrants: openGrants(state),
      pending,
      recent: await this.#mirrors.archived(3),
      liveness: {
        broker: { pid: this.#host.pid, epoch: this.#host.epoch, heartbeatAt: this.#host.heartbeatAt() },
        agents,
      },
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

const err = (reqId: string, code: string, message: string): BrokerResponse => ({ ...(reqId ? { reqId } : {}), ok: false, error: { code, message } });
