import { randomUUID } from 'node:crypto';
import type { AgentId, Grant } from '@core/types.ts';
import type {
  BrokerControl, BrokerStatusDto, Delivery, DeliverySubscription, ExecuteOutcome,
  ExecuteRequest, ObserverPush, ObserverSession, ObserverSnapshotDto, ProtocolGateway, StatusDto, UserObserverSession,
} from '@app/ports/gateway.ts';
import type { StoredMessage } from '@app/ports/index.ts';
import { IpcClient } from '@adapters/ipc/client.ts';
import type { DeliveryFrame, ResponseFrame } from '@adapters/ipc/types.ts';
import { BrokerDiscovery } from './brokerDiscovery.ts';
import { loadOrCreateAgentCredential } from './credentialStore.ts';

export class BrokerWireError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BrokerWireError'; }
}

/** Subscription reconnect policy: ~250ms → 4s capped backoff, bounded so a
 * permanently-gone broker fails the stream instead of retrying forever
 * (and each rediscover may spawn — bounding prevents a spawn storm). */
export type ReconnectPolicy = { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
const DEFAULT_RECONNECT: ReconnectPolicy = { maxAttempts: 6, baseDelayMs: 250, maxDelayMs: 4_000 };

type Connector = { readonly clientId: string; connect(spawnIfAbsent?: boolean): Promise<IpcClient>; rediscover(): Promise<IpcClient> };

export class BrokerGateway implements ProtocolGateway, BrokerControl {
  private client: IpcClient | undefined;
  readonly clientId: string;
  constructor(
    private readonly connector: Connector,
    private readonly reconnectPolicy: ReconnectPolicy = DEFAULT_RECONNECT,
    /** Peer 1A blocker fix: the per-agent credential source. Every agent
     * operation auto-attaches on ITS live connection (reactive on
     * agent-not-attached, and on every reconnect via the shared attach
     * path) — a tag never outlives its socket, so the GATEWAY must carry
     * the proof, not a one-shot `pair attach` process. `rotate` mints an
     * agent-generated REPLACEMENT when the broker reports the old secret
     * revoked (round 3 #1). */
    private readonly credentials?: (agent: string, options?: { rotate?: boolean }) => Promise<string>,
  ) {
    this.clientId = connector.clientId;
  }

  static forRoot(root: string): BrokerGateway {
    return new BrokerGateway(new BrokerDiscovery({ root }), DEFAULT_RECONNECT, async (agent, options) => {
      const cred = await loadOrCreateAgentCredential(root, agent, { regenerate: options?.rotate === true });
      if (cred.kind === 'error') throw new BrokerWireError('credential-error', cred.detail);
      return cred.token;
    });
  }
  static forClient(client: IpcClient, credentials?: (agent: string, options?: { rotate?: boolean }) => Promise<string>): BrokerGateway {
    return new BrokerGateway({ clientId: client.clientId, connect: async () => client, rediscover: async () => client }, DEFAULT_RECONNECT, credentials);
  }

  /** Attach `agent` on this exact client (its OWN credential, transport
   * edge only). Throws typed errors; TOFU is idempotent by credential.
   * Round 4 #2 (codex-approved safe alternative): NO automatic rotation —
   * concurrent processes racing rm+create on the shared store could
   * strand a divergent token forever. A credential-revoked rejection
   * surfaces typed; the human (or the agent, deliberately) runs ONE
   * explicit `pair attach -Regenerate`, and every process converges on
   * the single stored replacement. */
  private async attachOn(client: IpcClient, agent: string): Promise<void> {
    if (!this.credentials) throw new BrokerWireError('agent-not-attached', 'This gateway has no agent-credential source for peer sessions.');
    const token = await this.credentials(agent);
    const res = await client.agentAttach(agent, token);
    if (!res.ok) throw new BrokerWireError(res.error.code, res.error.message);
  }

  async execute(request: ExecuteRequest): Promise<ExecuteOutcome> {
    const send = (client: IpcClient) => client.execute(request.as, { command: request.command, ...(request.credential === undefined ? {} : { credential: request.credential }) }, request.identity.reqId);
    let response: Extract<ResponseFrame, { ok: true }>;
    try { response = await this.response(send, true); }
    catch (error) {
      // Peer 1A: reactive auto-attach — the broker names the exact gap.
      if (!(error instanceof BrokerWireError) || error.code !== 'agent-not-attached') throw error;
      await this.attachOn(await this.getClient(true), request.as);
      response = await this.response(send, true);
    }
    const data = response.data as Omit<ExecuteOutcome, 'seq' | 'events'>;
    return { ...data, ...(response.seq === undefined ? {} : { seq: response.seq }), events: (response.events ?? []) as ExecuteOutcome['events'] };
  }
  async status(): Promise<StatusDto> { return this.query<StatusDto>('status'); }
  /** Peer 1A: attach THIS connection as the agent (no internal retry —
   * the caller re-attaches; TOFU is idempotent by credential). */
  async agentAttach(agent: string, credential: string): Promise<{ agent: string; credentialVersion: number; admitted: boolean }> {
    const client = await this.getClient(true);
    const response = await client.agentAttach(agent, credential);
    if (!response.ok) throw new BrokerWireError(response.error.code, response.error.message);
    return response.data as { agent: string; credentialVersion: number; admitted: boolean };
  }
  async log(tail = 10): Promise<readonly StoredMessage[]> { return this.query<readonly StoredMessage[]>('log', { tail }); }
  /** Peer 1B: authoritative planning artifacts (public read-only). */
  async planningArtifacts(): Promise<unknown> { return this.query<unknown>('planning-artifacts'); }
  async grants(): Promise<readonly Grant[]> { return this.query<readonly Grant[]>('grants'); }
  async brokerStatus(): Promise<BrokerStatusDto> {
    try { return await this.query<BrokerStatusDto>('broker-status', undefined, false); }
    catch { return { running: false }; }
  }
  async stop(): Promise<void> { await this.query<unknown>('broker-stop', undefined, false); }

  /**
   * Attach as a read-only observer (watch). NO reconnect logic here by
   * design: an observer has no cursor to resume — the caller reattaches
   * (fresh snapshot) when the pushes iterable fails. `spawn: false` keeps a
   * reconnect loop from resurrecting a deliberately stopped broker.
   */
  async observe(spawn = true): Promise<ObserverSession> {
    const client = await this.getClient(spawn);
    const queue = new AsyncQueue<ObserverPush>();
    const offPush = client.onObserverPush((frame) => queue.push(frame as ObserverPush));
    let response: ResponseFrame;
    try { response = await client.observe(); }
    catch (error) { offPush(); queue.close(); throw error; }
    if (!response.ok) { offPush(); queue.close(); throw new BrokerWireError(response.error.code, response.error.message); }
    // Same transactional shape as userAttach/subscribe: close semantics arm
    // only for the socket that completed the handshake.
    const offClose = client.onClose((error) => queue.fail(error));
    if (!client.connected) queue.fail(new Error('IPC connection closed'));
    return {
      snapshot: response.data as ObserverSnapshotDto,
      pushes: queue,
      close: async () => { offPush(); offClose(); queue.close(); },
    };
  }

  /**
   * Reconnect hardening (post-slice-2 micro-slice): a dropped subscription
   * connection retries with bounded exponential backoff instead of dying
   * after one attempt — broker churn (idle exit + respawn, restarts) must
   * not kill a fused wait. Identity and cursor are preserved across
   * reconnects: same clientId (connector-owned), afterDeliverySeq = last
   * ACKED cursor, so open/unacked-beats-cursor redelivers anything in
   * flight. close() cancels an in-progress reconnect; attempts exhausted
   * fails the delivery stream.
   */
  /** U1: authenticated user-channel attach — observe semantics plus send
   * on the SAME connection. Reattach (a fresh userAttach) is the host's
   * job, exactly like observe. Transactional like the subscription seam
   * (codex slice review #6): push listener installs before the handshake,
   * close semantics arm only on SUCCESS with a connected-race check —
   * IpcClient.userAttach never retries internally, so a mid-handshake drop
   * rejects here instead of returning a session with a poisoned queue. */
  async userAttach(userToken: string, spawn = true): Promise<UserObserverSession> {
    const client = await this.getClient(spawn);
    const queue = new AsyncQueue<ObserverPush>();
    const offPush = client.onObserverPush((frame) => queue.push(frame as ObserverPush));
    let response: ResponseFrame;
    try { response = await client.userAttach(userToken); }
    catch (error) { offPush(); queue.close(); throw error; }
    if (!response.ok) { offPush(); queue.close(); throw new BrokerWireError(response.error.code, response.error.message); }
    const offClose = client.onClose((error) => queue.fail(error));
    if (!client.connected) queue.fail(new Error('IPC connection closed')); // close raced the arming
    return {
      snapshot: response.data as ObserverSnapshotDto,
      pushes: queue,
      send: async (reqId, target, body) => { expectOk(await client.userSend(target, body, reqId)); },
      action: async (reqId, action) => { expectOk(await client.userAction(action, reqId)); },
      close: async () => { offPush(); offClose(); queue.close(); },
    };
  }

  async subscribe(as: AgentId, afterDeliverySeq: number): Promise<DeliverySubscription> {
    const queue = new AsyncQueue<Delivery>();
    let client = await this.getClient(true);
    let cursor = afterDeliverySeq;
    let active = true;
    let terminalError: Error | undefined; // set when reconnect attempts exhaust
    let reconnecting: Promise<void> | undefined;
    const sequences = new Map<string, number>();
    let offDelivery = () => {};
    let offClose = () => {};
    let cancelBackoff: (() => void) | undefined;

    let removed: BrokerWireError | undefined; // removed-from-session latch: terminal, never reconnected
    const scheduleReconnect = () => {
      if (!active || reconnecting || removed) return;
      offDelivery(); offClose();
      reconnecting = reconnect().finally(() => { reconnecting = undefined; });
    };
    /**
     * Transactional attach (codex live review, two rounds): the delivery
     * listener installs BEFORE the subscribe round-trip (an early push must
     * not be dropped), but onClose→reconnect arms ONLY after the handshake
     * succeeds — a drop during the INITIAL handshake must reject subscribe()
     * without launching orphan background retries. After the handshake,
     * `active` is re-checked (close() may have raced the round-trip: publish
     * nothing, close the replacement socket), and a close that raced the
     * onClose arming itself is caught by the connected guard.
     */
    const attach = async (next: IpcClient): Promise<void> => {
      const offD = next.onDelivery((frame) => { sequences.set(frame.deliveryId, frame.deliverySeq); queue.push(toDelivery(frame)); });
      // Slice-4 kicked-wait seam (design REV 6, round-2 D): an unsolicited
      // removed-from-session is a TYPED TERMINAL failure — latched before
      // any close callback can replace it, and reconnect is suppressed.
      const offErr = next.onServerError((e) => {
        if (e.code === 'credential-revoked') {
          // Round 4 #2: terminate the wait PROMPTLY and typed — the store
          // race makes auto-rotation unsafe; recovery is one explicit
          // `pair attach -Regenerate` (then re-arm), after which every
          // process converges on the single stored replacement.
          removed = new BrokerWireError(e.code, e.message);
          queue.preempt(removed);
          return;
        }
        if (e.code !== 'removed-from-session') return;
        removed = new BrokerWireError(e.code, e.message);
        // PREEMPTIVE: discard buffered deliveries — a removed agent must see
        // the terminal removal, never a normal message + re-arm guidance
        // (codex step-4 re-read; within approved immediate-stop semantics).
        queue.preempt(removed);
      });
      try { expectOk(await next.subscribe(as, cursor)); }
      catch (error) {
        // Peer 1A: this path serves the INITIAL subscribe AND every
        // reconnect — auto-attaching here means broker restarts re-prove
        // the credential before the cursor resumes.
        if (error instanceof BrokerWireError && error.code === 'agent-not-attached') {
          try { await this.attachOn(next, as); expectOk(await next.subscribe(as, cursor)); }
          catch (inner) { offD(); offErr(); next.close(); throw inner; }
        } else { offD(); offErr(); next.close(); throw error; }
      }
      if (!active) { offD(); offErr(); next.close(); return; } // cancelled mid-handshake
      offDelivery = () => { offD(); offErr(); };
      offClose = next.onClose(() => scheduleReconnect());
      client = next;
      this.client = next;
      if (!next.connected) scheduleReconnect(); // close raced the arming
    };
    /** Backoff sleep that close() can break immediately — cancellation never
     * waits out a 4s delay or spends one more rediscover. */
    const backoffSleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => { cancelBackoff = undefined; resolve(); }, ms);
        cancelBackoff = () => { clearTimeout(timer); cancelBackoff = undefined; resolve(); };
      });
    const reconnect = async (): Promise<void> => {
      let delay = this.reconnectPolicy.baseDelayMs;
      for (let attempt = 1; active; attempt++) {
        try {
          const next = await this.connector.rediscover();
          if (!active) { next.close(); return; }
          await attach(next);
          return;
        } catch (error) {
          if (!active) return;
          if (attempt >= this.reconnectPolicy.maxAttempts) {
            terminalError = error instanceof Error ? error : new Error(String(error));
            queue.fail(error);
            return;
          }
          await backoffSleep(delay);
          delay = Math.min(delay * 2, this.reconnectPolicy.maxDelayMs);
        }
      }
    };

    try { await attach(client); }
    catch (error) { queue.fail(error); throw error; }
    /**
     * D2 (2026-07-20): a transport failure mid-ack/extend must rediscover,
     * never redial — IpcClient's endpoint is fixed at construction, so its
     * implicit redial after a broker restart hits the DEAD epoch's pipe
     * (`connect ENOENT ...-eN`), crashing the CLI after the message already
     * printed and orphaning the delivery for redelivery. Recovery: run the
     * standard reconnect (bounded backoff, lease rediscovery), then retry
     * once on the swapped client. Broker-side ack is lease-agnostic and
     * idempotent (broker/server.ts ack), so a post-restart ack closes
     * cleanly. Protocol rejections (BrokerWireError) are never retried.
     */
    const withReconnectRetry = async (op: (c: IpcClient) => Promise<ResponseFrame>): Promise<void> => {
      if (removed) throw removed; // terminal: no wire call, no reconnect
      const attempted = client; // pin the generation this attempt ran against
      try { expectOk(await op(attempted)); return; }
      catch (error) {
        // Peer 1A: an untagged client (post-restart, post-rebind re-attach)
        // is repaired in place — every other protocol rejection is final.
        if (error instanceof BrokerWireError && error.code === 'agent-not-attached') {
          await this.attachOn(client, as);
          expectOk(await op(client));
          return;
        }
        if (error instanceof BrokerWireError) throw error;
        // A reconnect cycle already died — never start another (codex round 3).
        if (terminalError) throw terminalError;
        // Post-close there is nothing to reconnect to — surface the failure.
        if (!active) throw error;
        if (client === attempted) {
          // No replacement yet: join the in-flight reconnect or start exactly
          // one. The client check and scheduleReconnect are in the same
          // synchronous block, so a completing reconnect cannot interleave.
          scheduleReconnect();
          await reconnecting;
          // Exhausted reconnects resolve `reconnecting` after queue.fail — a
          // retry would redial the stale client (the exact D2 symptom).
          if (terminalError) throw terminalError;
          if (!active) throw error;
        }
        // Either the joined reconnect swapped the client, or a replacement had
        // already won before the stale op rejected — retry on the winner
        // without spending a second rediscovery.
        expectOk(await op(client));
      }
    };
    return {
      deliveries: queue,
      ack: async (id) => { await withReconnectRetry((c) => c.ack(id)); cursor = Math.max(cursor, sequences.get(id) ?? cursor); },
      extend: async (id) => { await withReconnectRetry((c) => c.extend(id)); },
      close: async () => { active = false; cancelBackoff?.(); offDelivery(); offClose(); queue.close(); await reconnecting?.catch(() => {}); },
    };
  }

  async close(): Promise<void> { this.client?.close(); this.client = undefined; }

  private async query<T>(what: string, args?: unknown, spawn = true): Promise<T> {
    const reqId = randomUUID();
    return this.request((client) => client.query(what, reqId, args), reqId, spawn);
  }

  private async request<T>(send: (client: IpcClient) => Promise<ResponseFrame>, _reqId: string, spawn = true): Promise<T> {
    return (await this.response(send, spawn)).data as T;
  }

  private async response(send: (client: IpcClient) => Promise<ResponseFrame>, spawn: boolean): Promise<Extract<ResponseFrame, { ok: true }>> {
    let response: ResponseFrame;
    try { response = await send(await this.getClient(spawn)); }
    catch {
      if (!spawn) throw new Error('Broker is not running.');
      this.client?.close();
      this.client = await this.connector.rediscover();
      response = await send(this.client);
    }
    if (!response.ok && response.error.code === 'stale-epoch') {
      if (!spawn) throw new BrokerWireError(response.error.code, response.error.message);
      this.client?.close();
      this.client = await this.connector.rediscover();
      response = await send(this.client);
    }
    if (!response.ok) throw new BrokerWireError(response.error.code, response.error.message);
    return response;
  }

  private async getClient(spawn: boolean): Promise<IpcClient> {
    return this.client ??= await this.connector.connect(spawn);
  }
}

function toDelivery(frame: DeliveryFrame): Delivery { return { deliverySeq: frame.deliverySeq, deliveryId: frame.deliveryId, message: frame.message as StoredMessage }; }
function expectOk(response: ResponseFrame): void { if (!response.ok) throw new BrokerWireError(response.error.code, response.error.message); }

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private values: T[] = [];
  private waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }> = [];
  private ended = false;
  private error: unknown;
  push(value: T) {
    if (this.ended) return; // late transport callback after fail/close
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }
  /** PREEMPTIVE terminal failure (slice 4, kicked-wait latch): buffered
   * values are DISCARDED — the consumer's very next call rejects with the
   * stored error. Only for immediate-stop semantics (removed-from-session),
   * where delivering queued mail to a removed agent would be a lie. */
  preempt(error: unknown) {
    this.values.length = 0;
    this.fail(error);
  }
  /** Terminal error is STORED: a failure with no waiter pending must still
   * reject the consumer's next call (after buffered values drain), never
   * silently end the stream (codex live review). */
  fail(error: unknown) {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  close() {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }
  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  [Symbol.asyncIterator]() { return this; }
}
