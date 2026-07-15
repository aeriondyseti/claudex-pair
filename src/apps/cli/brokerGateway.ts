import { randomUUID } from 'node:crypto';
import type { AgentId, Grant } from '@core/types.ts';
import type {
  BrokerControl, BrokerStatusDto, Delivery, DeliverySubscription, ExecuteOutcome,
  ExecuteRequest, ObserverPush, ObserverSession, ObserverSnapshotDto, ProtocolGateway, StatusDto,
} from '@app/ports/gateway.ts';
import type { StoredMessage } from '@app/ports/index.ts';
import { IpcClient } from '@adapters/ipc/client.ts';
import type { DeliveryFrame, ResponseFrame } from '@adapters/ipc/types.ts';
import { BrokerDiscovery } from './brokerDiscovery.ts';

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
  constructor(private readonly connector: Connector, private readonly reconnectPolicy: ReconnectPolicy = DEFAULT_RECONNECT) {
    this.clientId = connector.clientId;
  }

  static forRoot(root: string): BrokerGateway { return new BrokerGateway(new BrokerDiscovery({ root })); }
  static forClient(client: IpcClient): BrokerGateway {
    return new BrokerGateway({ clientId: client.clientId, connect: async () => client, rediscover: async () => client });
  }

  async execute(request: ExecuteRequest): Promise<ExecuteOutcome> {
    const response = await this.response((client) => client.execute(request.as, { command: request.command }, request.identity.reqId), true);
    const data = response.data as Omit<ExecuteOutcome, 'seq' | 'events'>;
    return { ...data, ...(response.seq === undefined ? {} : { seq: response.seq }), events: (response.events ?? []) as ExecuteOutcome['events'] };
  }
  async status(): Promise<StatusDto> { return this.query<StatusDto>('status'); }
  async log(tail = 10): Promise<readonly StoredMessage[]> { return this.query<readonly StoredMessage[]>('log', { tail }); }
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
    const offClose = client.onClose((error) => queue.fail(error));
    let response: ResponseFrame;
    try { response = await client.observe(); }
    catch (error) { offPush(); offClose(); queue.close(); throw error; }
    if (!response.ok) { offPush(); offClose(); queue.close(); throw new BrokerWireError(response.error.code, response.error.message); }
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
  async subscribe(as: AgentId, afterDeliverySeq: number): Promise<DeliverySubscription> {
    const queue = new AsyncQueue<Delivery>();
    let client = await this.getClient(true);
    let cursor = afterDeliverySeq;
    let active = true;
    let reconnecting: Promise<void> | undefined;
    const sequences = new Map<string, number>();
    let offDelivery = () => {};
    let offClose = () => {};
    let cancelBackoff: (() => void) | undefined;

    const scheduleReconnect = () => {
      if (!active || reconnecting) return;
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
      try { expectOk(await next.subscribe(as, cursor)); }
      catch (error) { offD(); next.close(); throw error; }
      if (!active) { offD(); next.close(); return; } // cancelled mid-handshake
      offDelivery = offD;
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
          if (attempt >= this.reconnectPolicy.maxAttempts) { queue.fail(error); return; }
          await backoffSleep(delay);
          delay = Math.min(delay * 2, this.reconnectPolicy.maxDelayMs);
        }
      }
    };

    try { await attach(client); }
    catch (error) { queue.fail(error); throw error; }
    return {
      deliveries: queue,
      ack: async (id) => { expectOk(await client.ack(id)); cursor = Math.max(cursor, sequences.get(id) ?? cursor); },
      extend: async (id) => { expectOk(await client.extend(id)); },
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
