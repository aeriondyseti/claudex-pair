import { createHash, timingSafeEqual } from 'node:crypto';
import type { Command, CommandEnvelope } from '@core/commands.ts';
import { decide } from '@core/decide.ts';
import { ProtocolError } from '@core/errors.ts';
import type { Event } from '@core/events.ts';
import { evolve } from '@core/evolve.ts';
import { navigators, openGrants } from '@core/queries.ts';
import { AGENT_CREDENTIAL_PATTERN, USER_IDENTITY, type AgentId, type SessionState } from '@core/types.ts';
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
  /** Connections tagged by a successful user-attach (connection-bound
   * auth, U1): only these may user-send; the tag dies with the socket. */
  #userConnections = new Set<string>();
  /** Peer 1A: connection tags from agent-attach — the ONLY source of the
   * peer principal. Multiple live tags per agent are legal (command lane +
   * blocked wait + keepalive). */
  #agentConnections = new Map<string, { agent: string; credentialVersion: number }>();
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
    this.#userConnections.delete(id);
    this.#agentConnections.delete(id);
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

  execute(reqId: string, clientId: string, as: string, payload: unknown, connectionId?: string): Promise<BrokerResponse> {
    this.#lastBusyAt = Date.now();
    return this.#chain(() => this.#execute(reqId, clientId, as, payload, connectionId));
  }

  async #execute(reqId: string, clientId: string, as: string, payload: unknown, connectionId?: string): Promise<BrokerResponse> {
    if (this.#stopping) return err(reqId, 'broker-stopping', 'Broker is draining; retry to respawn.');
    if (this.#conflict) return err(reqId, 'mirror-conflict', this.#conflict.message);
    const state = this.#journal.sessionState;
    // Peer 1A: AUTH BEFORE DEDUP (codex rev 4). The principal derives from
    // the connection tag, never from frame `as`/clientId; the replay
    // namespace derives from session identity + agent + credential version,
    // so a forged `as` can never touch (or replay) recorded outcomes.
    let dedupKey = clientId;
    if (state?.topology === 'peer') {
      const tag = connectionId === undefined ? undefined : this.#agentConnections.get(connectionId);
      if (!tag) return err(reqId, 'agent-not-attached', 'Peer sessions require agent-attach on this connection before any command.');
      if (tag.agent !== as) return err(reqId, 'identity-mismatch', `This connection is attached as '${tag.agent}', not '${as}'.`);
      const binding = this.#journal.binding(as);
      if (!binding || binding.hash === undefined || binding.credentialVersion !== tag.credentialVersion) {
        return err(reqId, 'credential-revoked', `The credential behind this attach was revoked — re-attach with the current credential.`);
      }
      dedupKey = `${state.sessionId ?? 'legacy'}:${as}:${tag.credentialVersion}`;
    }
    const recorded = this.#journal.recordedOutcome(dedupKey, reqId);
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
    // Peer 1A bootstrap: peer init carries the INITIATOR credential at the
    // transport edge (payload, never envelope/journal) and performs an
    // implicit attach — binding + tag in the same txn as the init.
    let initBind: { agent: string; credentialVersion: number; extraEvents: Event[]; privateBindings: Record<string, { hash: string; credentialVersion: number }> } | undefined;
    if (command.kind === 'init-session' && command.topology === 'peer') {
      const credential = (payload as { credential?: unknown }).credential;
      if (typeof credential !== 'string' || !AGENT_CREDENTIAL_PATTERN.test(credential)) {
        return err(reqId, 'invalid-credential', 'Peer init requires the initiator credential (64 lowercase hex chars) at the transport edge.');
      }
      if (connectionId === undefined || !this.#connections.has(connectionId)) {
        return err(reqId, 'connection-closed', 'Peer init must arrive on a live connection — the initiator is tagged on it.');
      }
      const at = envelope.meta.at;
      const bindingId = this.#ids.messageId();
      initBind = {
        agent: command.driver,
        credentialVersion: 1,
        // Post-init registry version is 1 (init v0 + registry-updated v1);
        // the bound transition is v2.
        extraEvents: [
          { kind: 'registry-updated', version: 2, change: 'bound', agent: command.driver, binding: { bindingId, credentialVersion: 1, boundAt: at }, at },
          { kind: 'attention-raised', id: `tofu-${bindingId}`, category: 'tofu-bind', detail: `${command.driver} bound credential v1 (TOFU) — confirm this attach is yours.`, at },
        ],
        privateBindings: { [command.driver]: { hash: sha256Hex(credential), credentialVersion: 1 } },
      };
    }
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
    const result = await this.#commitEnvelope(reqId, dedupKey, envelope, state, initBind === undefined ? undefined : { extraEvents: initBind.extraEvents, privateBindings: initBind.privateBindings });
    if (result.ok && initBind && connectionId !== undefined && this.#connections.has(connectionId)) {
      // Publication guard: the binding stands even if the socket died; a
      // dead connection is never tagged.
      this.#agentConnections.set(connectionId, { agent: initBind.agent, credentialVersion: initBind.credentialVersion });
    }
    return result;
  }

  /**
   * Peer 1A: connection-bound agent identity (codex rev 4). The credential
   * is agent-generated; the broker stores ONLY a private sha256 verifier
   * (journal privateBindings — CRC-covered, never projected). First bind is
   * loud TOFU (durable attention item + admission when expected); reconnect
   * proves the same secret constant-time. Multiple live tags per agent are
   * legal; a dead connection is never tagged (publication guard).
   */
  agentAttach(reqId: string, connectionId: string, clientId: string, agent: string, credential: string): Promise<BrokerResponse> {
    this.#lastBusyAt = Date.now();
    return this.#chain(async () => {
      if (this.#stopping) return err(reqId, 'broker-stopping', 'Broker is draining; retry to respawn.');
      if (this.#conflict) return err(reqId, 'mirror-conflict', this.#conflict.message);
      const state = this.#journal.sessionState;
      if (!state) return err(reqId, 'session-not-active', 'No session in journal.');
      if (state.topology !== 'peer') return err(reqId, 'not-peer-topology', 'agent-attach is peer-topology machinery; pair sessions identify by frame.');
      if (!AGENT_CREDENTIAL_PATTERN.test(credential)) {
        return err(reqId, 'invalid-credential', 'Agent credential must be 64 lowercase hex characters (32 bytes).');
      }
      // Round 2 #3: DURABLE authorization decides attachability in every
      // substate — an abstained invitee or post-barrier user admit attaches
      // as an observer; only current-barrier expected members can complete
      // the admitting set.
      const authorizedDurable = state.agents.includes(agent) || state.authorized.includes(agent);
      if (!authorizedDurable) {
        return err(reqId, 'admission-not-authorized', `'${agent}' is not authorized for this session — admission is by user action or the plan's policy, never self-declared.`);
      }
      const inCurrentBarrier = state.planning?.substate === 'admitting' && state.planning.authorizedExpected.includes(agent);
      const existing = this.#journal.binding(agent);
      if (existing?.hash !== undefined) {
        // Reconnect: prove the SAME secret (constant-time).
        if (!constantTimeEqualHex(sha256Hex(credential), existing.hash)) {
          return err(reqId, 'agent-auth-failed', 'Credential rejected.');
        }
        // Round 2 #6: a bound NON-member (returning leaver, late observer)
        // is re-admitted by its reconnect — a real membership txn.
        if (!state.agents.includes(agent)) {
          const at = this.#clock.now();
          const events: Event[] = [
            { kind: 'registry-updated', version: state.registry.version + 1, change: 'joined', agent, at },
            { kind: 'agent-admitted', agent, at },
          ];
          if (inCurrentBarrier) {
            const admittedAfter = [...(state.planning?.substate === 'admitting' ? state.planning.admitted : []), agent];
            const expected = state.planning?.substate === 'admitting' ? state.planning.authorizedExpected : [];
            if (expected.every((a) => admittedAfter.includes(a))) {
              events.push({ kind: 'admission-completed', at });
              events.push({ kind: 'barrier-opened', members: admittedAfter, registryVersion: state.registry.version + 1, at });
            }
          }
          const envelope: CommandEnvelope = {
            command: { kind: 'bind-agent', agent, readmit: true } as unknown as CommandEnvelope['command'],
            meta: { id: this.#ids.messageId(), at, principal: agent },
          };
          const committed = await this.#commitDecided(reqId, clientId, envelope, state, events);
          if (!committed.ok) return committed;
          if (!this.#connections.has(connectionId)) return err(reqId, 'connection-closed', 'Connection closed during agent-attach; the re-admission is committed — re-attach.');
          this.#agentConnections.set(connectionId, { agent, credentialVersion: existing.credentialVersion });
          return { ...committed, data: { agent, credentialVersion: existing.credentialVersion, admitted: true } };
        }
        if (!this.#connections.has(connectionId)) return err(reqId, 'connection-closed', 'Connection closed during agent-attach; re-attach.');
        this.#agentConnections.set(connectionId, { agent, credentialVersion: existing.credentialVersion });
        return { reqId, ok: true, data: { agent, credentialVersion: existing.credentialVersion, admitted: true } };
      }
      // TOFU: no dedup shortcut (mirrors user-attach — an unrelated recorded
      // outcome must never stand in for a bind); a retry lands in the
      // reconnect branch above and re-proves its own credential.
      if (this.#journal.recordedOutcome(clientId, reqId) !== undefined) {
        return err(reqId, 'agent-auth-failed', 'reqId already used by another request — retry agent-attach with a fresh reqId.');
      }
      const at = this.#clock.now();
      const bindingId = this.#ids.messageId();
      const credentialVersion = (existing?.credentialVersion ?? 0) + 1;
      const events: Event[] = [];
      let version = state.registry.version;
      const willAdmit = !state.agents.includes(agent);
      if (willAdmit) {
        // Admission IS the membership change — fresh joinedAt at admission
        // time (authorization was never a registry record; round 2 #2).
        events.push({ kind: 'registry-updated', version: ++version, change: 'joined', agent, at });
      }
      events.push({ kind: 'registry-updated', version: ++version, change: 'bound', agent, binding: { bindingId, credentialVersion, boundAt: at }, at });
      if (willAdmit) {
        events.push({ kind: 'agent-admitted', agent, at });
        if (inCurrentBarrier) {
          const admittedAfter = [...(state.planning?.substate === 'admitting' ? state.planning.admitted : []), agent];
          const expected = state.planning?.substate === 'admitting' ? state.planning.authorizedExpected : [];
          // The LAST expected admission atomically opens the barrier with
          // the durable frozen-electorate fact (round 2 #4).
          if (expected.every((a) => admittedAfter.includes(a))) {
            events.push({ kind: 'admission-completed', at });
            events.push({ kind: 'barrier-opened', members: admittedAfter, registryVersion: version, at });
          }
        }
      }
      events.push({ kind: 'attention-raised', id: `tofu-${bindingId}`, category: 'tofu-bind', detail: `${agent} bound credential v${credentialVersion} (TOFU) — confirm this attach is yours.`, at });
      const envelope: CommandEnvelope = {
        // Broker-authored pseudo-command: not in COMMAND_KINDS (the wire
        // cannot forge it) and carries NO secret material.
        command: { kind: 'bind-agent', agent, bindingId, credentialVersion } as unknown as CommandEnvelope['command'],
        meta: { id: this.#ids.messageId(), at, principal: agent },
      };
      const committed = await this.#commitDecided(reqId, clientId, envelope, state, events, { privateBindings: { [agent]: { hash: sha256Hex(credential), credentialVersion } } });
      if (!committed.ok) return committed;
      // Publication guard: binding + admission are durably committed; a
      // dead connection is simply not tagged (reconnect proves the secret).
      if (!this.#connections.has(connectionId)) return err(reqId, 'connection-closed', 'Connection closed during agent-attach; the binding is committed — re-attach.');
      this.#agentConnections.set(connectionId, { agent, credentialVersion });
      // The committed txn's events ride the response (the atomic
      // admission/barrier facts are the caller's receipt).
      return { ...committed, data: { agent, credentialVersion, admitted: true } };
    });
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
      // Publication guard (codex re-read, 20260720-110117-282): the socket
      // may have closed while this request sat behind the commit chain — a
      // dead sink registered here would WIN delivery selection repeatedly.
      if (!this.#connections.has(sink.id)) return err(reqId, 'connection-closed', 'Connection closed before the subscription registered.');
      // Peer 1A: mailbox ownership — you subscribe only as the agent this
      // connection is attached as.
      const subState = this.#journal.sessionState;
      if (subState?.topology === 'peer') {
        const tag = this.#agentConnections.get(sink.id);
        // Untagged is REPAIRABLE (the gateway auto-attaches and retries);
        // a tag for a different agent is terminal.
        if (!tag) return err(reqId, 'agent-not-attached', `subscribe as '${as}' requires an agent-attach on this connection.`);
        if (tag.agent !== as) return err(reqId, 'identity-mismatch', `This connection is attached as '${tag.agent}', not '${as}'.`);
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
      // Publication guard (codex re-read): never tag a connection that
      // closed while this request waited on the chain.
      if (!this.#connections.has(sink.id)) return err(reqId, 'connection-closed', 'Connection closed before the observer registered.');
      // Registration and every activity notify both run inside the commit
      // chain, so an observer registered at head N receives exactly the
      // txns with seq > N — no stale push for commits its snapshot already
      // contains, no gap, by construction.
      this.#observers.set(sink.id, sink);
      const snapshot: ObserverSnapshotDto = {
        seq: this.#journal.headSeq,
        session: state,
        transcript: this.#observerTranscript(),
        awaiting: this.#journal.awaiting(),
        liveness: this.#liveness(),
        broker: { pid: this.#host.pid, epoch: this.#host.epoch, endpoint: this.#host.endpoint, heartbeatAt: this.#host.heartbeatAt() },
      };
      return { reqId, ok: true, data: snapshot };
    });
  }

  ack(reqId: string, deliveryId: string, clientId: string, connectionId?: string): Promise<BrokerResponse> {
    this.#lastBusyAt = Date.now();
    return this.#chain(async () => {
      const open = this.#journal.openDeliveries().find((d) => d.deliveryId === deliveryId);
      if (!open) return { reqId, ok: true }; // idempotent (F5/F11)
      // Peer 1A: only the RECIPIENT consumes its mail (tag-derived).
      const ackState = this.#journal.sessionState;
      if (ackState?.topology === 'peer') {
        const tag = connectionId === undefined ? undefined : this.#agentConnections.get(connectionId);
        if (!tag) return err(reqId, 'agent-not-attached', `ack of ${deliveryId} requires an agent-attach on this connection.`);
        if (tag.agent !== open.message.to) return err(reqId, 'identity-mismatch', `ack of ${deliveryId} requires the recipient tag ('${open.message.to}').`);
      }
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
        awaiting: this.#journal.awaiting(),
      });
      return { reqId, ok: true };
    });
  }

  extend(reqId: string, deliveryId: string, connectionId?: string): BrokerResponse {
    // Peer 1A: lease extension is recipient-owned like ack.
    const extState = this.#journal.sessionState;
    if (extState?.topology === 'peer') {
      const open = this.#journal.openDeliveries().find((d) => d.deliveryId === deliveryId);
      const tag = connectionId === undefined ? undefined : this.#agentConnections.get(connectionId);
      if (open && !tag) return err(reqId, 'agent-not-attached', `extend of ${deliveryId} requires an agent-attach on this connection.`);
      if (open && tag && tag.agent !== open.message.to) return err(reqId, 'identity-mismatch', `extend of ${deliveryId} requires the recipient tag.`);
    }
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

  /**
   * U1 user-channel attach: validate (or TOFU-register) the token ONCE,
   * tag the connection, then behave exactly as observe — non-consuming,
   * never idle-pinning. Registration is a normal committed txn (loud
   * notices ride the delivery ledger); its dedup key is this request's
   * (clientId, reqId), so an attach retry never re-registers.
   */
  userAttach(reqId: string, sink: ObserverSink, clientId: string, userToken: string): Promise<BrokerResponse> {
    return this.#chain(async () => {
      if (this.#stopping) return err(reqId, 'broker-stopping', 'Broker is draining; retry to respawn.');
      if (this.#conflict) return err(reqId, 'mirror-conflict', this.#conflict.message);
      const state = this.#journal.sessionState;
      if (!state) return err(reqId, 'session-not-active', 'No session in journal.');
      // Wire validation: the token encoding is FROZEN as 64 lowercase hex
      // chars (32 bytes). An empty or malformed token must never reach
      // sha256 — hashing garbage would mint a real binding.
      if (!USER_TOKEN_PATTERN.test(userToken)) {
        return err(reqId, 'user-auth-failed', 'User-channel token must be 64 hex characters (32 bytes).');
      }
      const hash = sha256Hex(userToken);
      if (state.userChannelTokenHash) {
        if (!constantTimeEqualHex(hash, state.userChannelTokenHash)) {
          return err(reqId, 'user-auth-failed', 'User-channel token rejected.');
        }
      } else {
        // NO dedup shortcut here (codex review: an unrelated recorded
        // outcome under this identity must never stand in for registration
        // proof — that would tag the socket without knowing any token). An
        // honest attach retry lands in the binding-exists branch above and
        // re-authenticates with its own token; a reqId collision fails
        // loudly instead of silently skipping.
        if (this.#journal.recordedOutcome(clientId, reqId) !== undefined) {
          return err(reqId, 'user-auth-failed', 'reqId already used by another request — retry user-attach with a fresh reqId.');
        }
        const envelope: CommandEnvelope = {
          command: { kind: 'register-user-channel', tokenHash: hash },
          meta: { id: this.#ids.messageId(), at: this.#clock.now(), principal: USER_IDENTITY },
        };
        const committed = await this.#commitUserEnvelope(reqId, clientId, envelope);
        if (!committed.ok) return committed;
      }
      // Publication guard (codex re-read): the socket may have died during
      // the registration commit above. The TOFU registration stays durably
      // committed — that is correct — but a dead connection must never be
      // tagged as an authenticated observer (stale auth forever).
      if (!this.#connections.has(sink.id)) return err(reqId, 'connection-closed', 'Connection closed during user-attach; the registration (if any) is committed — reattach.');
      this.#observers.set(sink.id, sink);
      this.#userConnections.add(sink.id);
      const snapshot: ObserverSnapshotDto = {
        seq: this.#journal.headSeq,
        session: this.#journal.sessionState!,
        transcript: this.#observerTranscript(),
        awaiting: this.#journal.awaiting(),
        liveness: this.#liveness(),
        broker: { pid: this.#host.pid, epoch: this.#host.epoch, endpoint: this.#host.endpoint, heartbeatAt: this.#host.heartbeatAt() },
        userChannel: { registered: true, authenticated: true },
      };
      return { reqId, ok: true, data: snapshot };
    });
  }

  /**
   * U1 advisory send. Connection-bound auth (no token on this frame);
   * dedup by (clientId, reqId) happens BEFORE any allocation; groupId is
   * the reqId (frozen contract) and per-recipient ids are deterministic
   * `${reqId}-${agent}` — retry-stable even beyond the dedup window.
   */
  userSend(reqId: string, clientId: string, connectionId: string, to: string, body: string): Promise<BrokerResponse> {
    this.#lastBusyAt = Date.now();
    return this.#chain(async () => {
      if (this.#stopping) return err(reqId, 'broker-stopping', 'Broker is draining; retry to respawn.');
      if (this.#conflict) return err(reqId, 'mirror-conflict', this.#conflict.message);
      if (!this.#userConnections.has(connectionId)) {
        return err(reqId, 'user-channel-required', 'user-send requires an authenticated user-attach on this connection.');
      }
      const state = this.#journal.sessionState;
      if (!state) return err(reqId, 'session-not-active', 'No session in journal.');
      if (!state.userChannelTokenHash) return err(reqId, 'user-channel-unregistered', 'No user channel is registered for this session.');
      // Runtime shape validation — JSON frames are not made safe by types.
      if (typeof to !== 'string' || to.length === 0 || typeof body !== 'string' || body.length === 0) {
        return err(reqId, 'invalid-recipient', 'user-send requires string to and non-empty string body.');
      }
      const recorded = this.#journal.recordedOutcome(clientId, reqId);
      if (recorded !== undefined) return recorded as BrokerResponse; // replay BEFORE allocation
      // Fresh allocation AFTER dedup (frozen contract). Collision-proof by
      // construction: ids embed the NEXT journal seq (single-writer, so it
      // is unique per committed txn even within one millisecond) plus the
      // recipient index — and nothing user-controlled (reqId never reaches
      // a filename).
      const base = this.#ids.messageId();
      const seq = this.#journal.headSeq + 1;
      const recipients = (to === '*' ? state.agents : [to]).map((agent, i) => ({ to: agent, messageId: `${base}-s${seq}-r${i}` }));
      const envelope: CommandEnvelope = {
        command: { kind: 'user-message', groupId: reqId, recipients, body },
        meta: { id: base, at: this.#clock.now(), principal: USER_IDENTITY },
      };
      return this.#commitUserEnvelope(reqId, clientId, envelope);
    });
  }

  /**
   * U1 slice 4: privileged user actions (design REV 6). ORDERING IS
   * NORMATIVE (tail C): (a) authenticate the LIVE connection first — a
   * dedup result is never returned to an unauthenticated caller; (b) dedup
   * by (clientId, reqId); (c) state/effect checks in decide. Dedup before
   * state means a COMMITTED end whose response was lost replays success on
   * retry even though the session is now completed. The handler allocates
   * groupId (=== reqId) and the collision-proof noticeIdBase; decide
   * computes per-verb recipients (protocol lives in the core).
   */
  userAction(reqId: string, clientId: string, connectionId: string, action: unknown): Promise<BrokerResponse> {
    this.#lastBusyAt = Date.now();
    return this.#chain(async () => {
      if (this.#stopping) return err(reqId, 'broker-stopping', 'Broker is draining; retry to respawn.');
      if (this.#conflict) return err(reqId, 'mirror-conflict', this.#conflict.message);
      if (!this.#userConnections.has(connectionId)) {
        return err(reqId, 'user-channel-required', 'user-action requires an authenticated user-attach on this connection.');
      }
      const recorded = this.#journal.recordedOutcome(clientId, reqId);
      if (recorded !== undefined) return recorded as BrokerResponse; // replay BEFORE state checks (tail C)
      // Runtime shape validation — JSON frames are not made safe by types.
      const verb = action && typeof action === 'object' ? (action as { verb?: unknown }).verb : undefined;
      const fields = (action ?? {}) as { summary?: unknown; grantId?: unknown; agent?: unknown; reason?: unknown };
      const str = (v: unknown): string => (typeof v === 'string' ? v : '');
      const base = this.#ids.messageId();
      const shared = { groupId: reqId, noticeIdBase: `${base}-s${this.#journal.headSeq + 1}` };
      let command: Command;
      if (verb === 'end') {
        command = { kind: 'user-end-session', summary: str(fields.summary), ...shared };
      } else if (verb === 'cancel-grant') {
        if (!str(fields.grantId)) return err(reqId, 'bad-command', 'user action cancel-grant requires a grantId.');
        command = { kind: 'user-cancel-grant', grantId: str(fields.grantId), reason: str(fields.reason), ...shared };
      } else if (verb === 'kick') {
        if (!str(fields.agent)) return err(reqId, 'bad-command', 'user action kick requires an agent.');
        command = { kind: 'user-kick-agent', agent: str(fields.agent), reason: str(fields.reason), ...shared };
      } else if (verb === 'pause') {
        command = { kind: 'user-pause-session', reason: str(fields.reason), ...shared };
      } else if (verb === 'resume') {
        command = { kind: 'user-resume-session', ...shared };
      } else if (verb === 'admit') {
        if (!str(fields.agent)) return err(reqId, 'bad-command', 'user action admit requires an agent.');
        command = { kind: 'user-admit-agent', agent: str(fields.agent), ...shared };
      } else if (verb === 'rebind') {
        if (!str(fields.agent)) return err(reqId, 'bad-command', 'user action rebind requires an agent.');
        command = { kind: 'user-rebind-agent', agent: str(fields.agent), ...shared };
      } else if (verb === 'rule-absentee') {
        const ruling = str((fields as { ruling?: unknown }).ruling);
        if (!str(fields.agent) || (ruling !== 'abstain' && ruling !== 'wait')) return err(reqId, 'bad-command', 'user action rule-absentee requires an agent and ruling abstain|wait.');
        const newDeadlineAt = str((fields as { newDeadlineAt?: unknown }).newDeadlineAt);
        command = { kind: 'user-rule-absentee', agent: str(fields.agent), ruling, ...(newDeadlineAt ? { newDeadlineAt } : {}), ...shared };
      } else if (verb === 'clear-attention') {
        if (!str((fields as { id?: unknown }).id)) return err(reqId, 'bad-command', 'user action clear-attention requires an id.');
        command = { kind: 'user-clear-attention', id: str((fields as { id?: unknown }).id), ...shared };
      } else if (verb === 'force-phase') {
        const to = str((fields as { to?: unknown }).to);
        if (to !== 'planning' && to !== 'provisioning' && to !== 'implementation') return err(reqId, 'bad-command', 'user action force-phase requires to: planning|provisioning|implementation.');
        command = { kind: 'user-force-phase', to, reason: str(fields.reason), ...shared };
      } else {
        return err(reqId, 'bad-command', `Unknown user action verb '${String(verb)}' (verbs: end, cancel-grant, kick, pause, resume, admit, rebind, rule-absentee, force-phase).`);
      }
      const envelope: CommandEnvelope = { command, meta: { id: base, at: this.#clock.now(), principal: USER_IDENTITY } };
      // Peer 1A: a rebind commit clears the PRIVATE verifier in the same
      // txn (pending-new-binding — the version survives; the next attach
      // TOFUs at version+1) and revokes + wakes every old-version tag.
      const rebindAgent = command.kind === 'user-rebind-agent' ? command.agent : undefined;
      const result = await this.#commitUserEnvelope(reqId, clientId, envelope, rebindAgent === undefined ? undefined : { privateBindings: { [rebindAgent]: null } });
      if (result.ok && rebindAgent !== undefined) {
        for (const [connId, tag] of [...this.#agentConnections]) {
          if (tag.agent !== rebindAgent) continue;
          this.#agentConnections.delete(connId);
          const sub = this.#subscriptions.get(connId);
          if (sub) {
            void sub.sink.sendError('credential-revoked', 'Your credential was rebound by the user — generate a new one and re-attach.').catch(() => undefined);
            this.#subscriptions.delete(connId);
          }
        }
        this.#notifyPresence();
      }
      return result;
    });
  }

  /** User-channel envelopes commit through the SAME roster-aware primitive
   * as agent execute (slice-4 design REV 6, tail B) — a user kick voids the
   * kicked agent's mail exactly like a driver kick. Already inside #chain. */
  async #commitUserEnvelope(reqId: string, clientId: string, envelope: CommandEnvelope, opts?: { privateBindings?: Record<string, { hash: string; credentialVersion: number } | null> }): Promise<BrokerResponse> {
    return this.#commitEnvelope(reqId, clientId, envelope, this.#journal.sessionState, opts);
  }

  /**
   * ONE shared roster-aware commit primitive (slice-4 design REV 6, tail B):
   * decide -> removed-agent capture -> optional init mirror -> journal
   * commit with removedAgents -> mirror void moves -> observer fan-out with
   * voidedDeliveryIds -> kicked-subscription terminal wake. Copied-partial
   * commit logic is retired; callers handle stopping/conflict/dedup/auth
   * and any path-specific pre-checks (revoke liveness) BEFORE this.
   */
  async #commitEnvelope(reqId: string, clientId: string, envelope: CommandEnvelope, state: SessionState | undefined, opts?: { extraEvents?: Event[]; privateBindings?: Record<string, { hash: string; credentialVersion: number } | null> }): Promise<BrokerResponse> {
    const decided = decide(state, envelope);
    if (!decided.ok) {
      const code = decided.error instanceof ProtocolError ? decided.error.code : 'rejected';
      return err(reqId, code, decided.error.message);
    }
    return this.#commitDecided(reqId, clientId, envelope, state, [...decided.value, ...(opts?.extraEvents ?? [])], opts);
  }

  /** The post-decide half of the shared commit primitive — also the direct
   * entry for BROKER-AUTHORED events (peer agent-attach binds, which carry
   * private verifiers that must never transit decide/commands). */
  async #commitDecided(reqId: string, clientId: string, envelope: CommandEnvelope, state: SessionState | undefined, events: readonly Event[], opts?: { privateBindings?: Record<string, { hash: string; credentialVersion: number } | null> }): Promise<BrokerResponse> {
    // F18/F21: roster removals void the agent's undelivered mail in the same
    // txn — capture the open set now (pre-commit) for the mirror moves.
    const removedAgents = events.flatMap((e) => (e.kind === 'agent-left' || e.kind === 'agent-kicked' ? [e.agent] : []));
    const voidedPreexisting = removedAgents.length
      ? this.#journal.openDeliveries().filter((d) => removedAgents.includes(d.message.to))
      : [];
    let gitignoreUpdated: boolean | undefined;
    if (envelope.command.kind === 'init-session') {
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
    // Post-state computed purely BEFORE commit — the journaled outcome must
    // be complete; post-commit mutation of an already-serialized response
    // made restart replays structurally incomplete (codex handler review).
    const post = events.reduce<SessionState | undefined>((s, e) => evolve(s, e), state)!;
    const command = envelope.command as { groupId?: string };
    const response: BrokerResponse = {
      reqId,
      ok: true,
      seq: this.#journal.headSeq + 1,
      events: [...events],
      data: {
        session: post,
        receipt,
        ...(gitignoreUpdated === undefined ? {} : { gitignoreUpdated }),
        ...(command.groupId === undefined ? {} : { groupId: command.groupId }),
      },
    };
    const record = await this.#journal.commit(envelope, events, response, { clientId, reqId }, removedAgents, opts?.privateBindings);
    const open = this.#journal.openDeliveries();
    const fresh = record.deliveries.flatMap((d) => {
      // Voided-in-same-txn deliveries are already closed — never pushed.
      const match = open.find((o) => o.deliveryId === d.deliveryId);
      return match ? [match] : [];
    });
    // Voided notices enqueued by THIS txn still need their mirror moved
    // inbox -> archive (they were never open post-commit).
    const voidedNew = removedAgents.length
      ? record.events.flatMap((e) =>
          e.kind === 'message-sent' && removedAgents.includes(e.to)
            ? [{ deliveryId: `${e.id}:${e.to}`, deliverySeq: 0, message: e }]
            : [],
        )
      : [];
    const voided = [...voidedPreexisting, ...voidedNew];
    this.#mirrorSerial = this.#mirrorSerial.then(() => this.#afterCommit(post, record.events, record.seq, fresh, voided));
    this.#notifyObservers({
      kind: 'activity',
      seq: record.seq,
      at: record.at,
      principal: record.principal,
      events: record.events,
      session: post,
      ackedDeliveryIds: [],
      voidedDeliveryIds: voided.map((d) => d.deliveryId),
      awaiting: this.#journal.awaiting(),
    });
    // Slice-4 kicked-wait wake (design 4b, KICK-ONLY): a removed agent with
    // a live subscription gets a typed terminal control, then deregisters —
    // an infinite wait must never be stranded. sendError failures are moot
    // (the socket is already gone).
    for (const agent of removedAgents) {
      for (const [id, sub] of [...this.#subscriptions]) {
        if (sub.as === agent) {
          void sub.sink.sendError('removed-from-session', 'You were removed from the session. Stop all work; do not re-arm this wait.').catch(() => undefined);
          this.#subscriptions.delete(id);
        }
      }
    }
    return response;
  }

  #observerTranscript(): { message: StoredMessage; pending: boolean; voided?: boolean }[] {
    return this.#journal.transcript().map((t) => ({
      message: this.#toStored({ deliveryId: t.deliveryId, deliverySeq: 0, message: t.message }),
      pending: t.state === 'open',
      ...(t.state === 'voided' ? { voided: true } : {}),
    }));
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
      awaiting: this.#journal.awaiting(),
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
    const pair = { id: m.id, from: m.from, to: m.to, type: m.type, turn: m.turn, sent: m.at, body: m.body, ...(m.replyTo === undefined ? {} : { replyTo: m.replyTo }), ...(m.sessionId === undefined ? {} : { sessionId: m.sessionId }) };
    return {
      name: this.#codec.filename(pair),
      header: {
        id: m.id, from: m.from, to: m.to, type: m.type, turn: m.turn, sent: m.at,
        // U1 composer reconciliation reads these from the header.
        ...(m.groupId === undefined ? {} : { groupId: m.groupId }),
        ...(m.provenance === undefined ? {} : { provenance: m.provenance }),
        ...(m.actionKind === undefined ? {} : { actionKind: m.actionKind }),
        ...(m.replyTo === undefined ? {} : { replyTo: m.replyTo }),
        ...(m.sessionId === undefined ? {} : { sessionId: m.sessionId }),
      },
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
  if (typeof kind !== 'string') return undefined;
  // Fail closed by NAMESPACE (slice-4 design REV 6, tail C): every reserved
  // user-* kind — including ones that do not exist yet — plus the explicit
  // slice-3 kinds. Never a hand-maintained enum a future verb can escape.
  if (kind.startsWith('user-') || USER_CHANNEL_KINDS.has(kind)) return kind;
  return undefined;
}

const err = (reqId: string, code: string, message: string): BrokerResponse => ({ ...(reqId ? { reqId } : {}), ok: false, error: { code, message } });

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Frozen wire encoding for the user-channel token: 32 bytes as lowercase hex. */
const USER_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Constant-time hex-hash comparison — never a string equality on secrets. */
function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
