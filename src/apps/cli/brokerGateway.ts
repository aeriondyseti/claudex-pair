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

type Connector = { readonly clientId: string; connect(spawnIfAbsent?: boolean): Promise<IpcClient>; rediscover(): Promise<IpcClient> };

export class BrokerGateway implements ProtocolGateway, BrokerControl {
  private client: IpcClient | undefined;
  readonly clientId: string;
  constructor(private readonly connector: Connector) { this.clientId = connector.clientId; }

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

  async subscribe(as: AgentId, afterDeliverySeq: number): Promise<DeliverySubscription> {
    const queue = new AsyncQueue<Delivery>();
    let client = await this.getClient(true);
    let cursor = afterDeliverySeq;
    let active = true;
    let reconnecting: Promise<void> | undefined;
    const sequences = new Map<string, number>();
    let offDelivery = () => {};
    let offClose = () => {};
    const attach = async (next: IpcClient) => {
      client = next;
      this.client = next;
      offDelivery = client.onDelivery((frame) => { sequences.set(frame.deliveryId, frame.deliverySeq); queue.push(toDelivery(frame)); });
      offClose = client.onClose(() => {
        if (!active || reconnecting) return;
        reconnecting = this.connector.rediscover().then(attach).catch((error) => queue.fail(error)).finally(() => { reconnecting = undefined; });
      });
      expectOk(await client.subscribe(as, cursor));
    };
    try { await attach(client); }
    catch (error) { offDelivery(); offClose(); queue.fail(error); throw error; }
    return {
      deliveries: queue,
      ack: async (id) => { expectOk(await client.ack(id)); cursor = Math.max(cursor, sequences.get(id) ?? cursor); },
      extend: async (id) => { expectOk(await client.extend(id)); },
      close: async () => { active = false; offDelivery(); offClose(); queue.close(); await reconnecting?.catch(() => {}); },
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
  push(value: T) { const waiter = this.waiters.shift(); if (waiter) waiter.resolve({ done: false, value }); else this.values.push(value); }
  fail(error: unknown) { for (const waiter of this.waiters.splice(0)) waiter.reject(error); this.ended = true; }
  close() { this.ended = true; for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined }); }
  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  [Symbol.asyncIterator]() { return this; }
}
