import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { encodeFrame, NdjsonDecoder } from './framing.ts';
import type { AckFrame, ClientFrame, DeliveryFrame, ExecuteFrame, ExtendFrame, ObserveFrame, ObserverPushFrame, QueryFrame, ResponseFrame, ServerFrame, SubscribeFrame } from './types.ts';

export type IpcClientOptions = { endpoint: string; token: string; epoch: number; clientId?: string; retryCount?: number };

export class IpcClient {
  readonly clientId: string;
  #socket: Socket | undefined; #decoder = new NdjsonDecoder();
  #pending = new Map<string, { resolve: (frame: ResponseFrame) => void; reject: (error: Error) => void }>();
  #deliveries = new Set<(frame: DeliveryFrame) => void>();
  #observerPushes = new Set<(frame: ObserverPushFrame) => void>();
  #closes = new Set<(error: Error) => void>();
  constructor(readonly options: IpcClientOptions) { this.clientId = options.clientId ?? randomUUID(); }

  async connect(): Promise<void> {
    if (this.#socket && !this.#socket.destroyed) return;
    const socket = createConnection(this.options.endpoint);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    this.#socket = socket; this.#decoder = new NdjsonDecoder();
    socket.on('data', (chunk) => { for (const frame of this.#decoder.push(chunk) as ServerFrame[]) this.#receive(frame); });
    socket.on('close', () => { const error = new Error('IPC connection closed'); for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear(); for (const listener of this.#closes) listener(error); });
  }

  close() { this.#socket?.destroy(); this.#socket = undefined; }
  onDelivery(listener: (frame: DeliveryFrame) => void) { this.#deliveries.add(listener); return () => this.#deliveries.delete(listener); }
  onObserverPush(listener: (frame: ObserverPushFrame) => void) { this.#observerPushes.add(listener); return () => this.#observerPushes.delete(listener); }
  onClose(listener: (error: Error) => void) { this.#closes.add(listener); return () => this.#closes.delete(listener); }

  async execute(as: string, envelope: unknown, reqId: string = randomUUID()): Promise<ResponseFrame> {
    const frame: ExecuteFrame = { ...this.#base(), kind: 'execute', reqId, as, envelope };
    return this.#requestWithRetry(frame, this.options.retryCount ?? 1);
  }
  async query(what: string, reqId: string = randomUUID(), args?: unknown): Promise<ResponseFrame> {
    const frame: QueryFrame = { ...this.#base(), kind: 'query', reqId, what, ...(args === undefined ? {} : { args }) };
    return this.#requestWithRetry(frame, this.options.retryCount ?? 1);
  }
  async subscribe(as: string, afterDeliverySeq = 0, reqId = randomUUID()) { return this.#requestWithRetry({ ...this.#base(), kind: 'subscribe', reqId, as, afterDeliverySeq }, this.options.retryCount ?? 1); }
  async observe(reqId = randomUUID()) { return this.#requestWithRetry({ ...this.#base(), kind: 'observe', reqId }, this.options.retryCount ?? 1); }
  async ack(deliveryId: string, reqId = randomUUID()) { return this.#requestWithRetry({ ...this.#base(), kind: 'ack', reqId, deliveryId }, this.options.retryCount ?? 1); }
  async extend(deliveryId: string, reqId = randomUUID()) { return this.#requestWithRetry({ ...this.#base(), kind: 'extend', reqId, deliveryId }, this.options.retryCount ?? 1); }

  #base() { return { token: this.options.token, epoch: this.options.epoch, clientId: this.clientId }; }
  async #requestWithRetry(frame: ExecuteFrame | QueryFrame | SubscribeFrame | AckFrame | ExtendFrame | ObserveFrame, retries: number): Promise<ResponseFrame> {
    for (let attempt = 0;; attempt++) {
      try { await this.connect(); return await this.#request(frame); }
      catch (error) { this.close(); if (attempt >= retries) throw error; }
    }
  }
  async #request(frame: ExecuteFrame | QueryFrame | SubscribeFrame | AckFrame | ExtendFrame | ObserveFrame): Promise<ResponseFrame> {
    const response = new Promise<ResponseFrame>((resolve, reject) => this.#pending.set(frame.reqId, { resolve, reject }));
    try { await this.#send(frame); } catch (error) { this.#pending.delete(frame.reqId); throw error; }
    return response;
  }
  async #send(frame: ClientFrame) { await this.connect(); await new Promise<void>((resolve, reject) => this.#socket!.write(encodeFrame(frame), (error) => error ? reject(error) : resolve())); }
  #receive(frame: ServerFrame) {
    if ('kind' in frame && frame.kind === 'delivery') { for (const listener of this.#deliveries) listener(frame); return; }
    if ('kind' in frame && (frame.kind === 'activity' || frame.kind === 'presence')) { for (const listener of this.#observerPushes) listener(frame); return; }
    if ('reqId' in frame && frame.reqId) { const pending = this.#pending.get(frame.reqId); if (pending) { this.#pending.delete(frame.reqId); pending.resolve(frame); } }
  }
}
