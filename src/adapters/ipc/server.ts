import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { encodeFrame, NdjsonDecoder } from './framing.ts';
import type { ClientFrame, ErrorFrame, FrameHandler, ServerConnection, ServerFrame } from './types.ts';

export type IpcServerOptions = { endpoint: string; token: string; epoch: number; handler: FrameHandler };

export class IpcServer {
  #server?: Server;
  #connections = new Set<Socket>();
  constructor(readonly options: IpcServerOptions) {}

  async listen(): Promise<void> {
    this.#server = createServer((socket) => this.#accept(socket));
    try { await listen(this.#server, this.options.endpoint); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || process.platform === 'win32') throw error;
      if (await endpointIsLive(this.options.endpoint)) throw new Error(`IPC endpoint already has a live server: ${this.options.endpoint}`);
      await rm(this.options.endpoint, { force: true });
      this.#server = createServer((socket) => this.#accept(socket));
      await listen(this.#server, this.options.endpoint);
    }
  }

  async close(): Promise<void> {
    for (const socket of this.#connections) socket.destroy();
    if (this.#server) await new Promise<void>((resolve, reject) => this.#server!.close((error) => error ? reject(error) : resolve()));
    if (process.platform !== 'win32') await rm(this.options.endpoint, { force: true });
  }

  #accept(socket: Socket) {
    this.#connections.add(socket); const decoder = new NdjsonDecoder();
    const connection: ServerConnection = { id: randomUUID(), send: (frame) => write(socket, frame) };
    socket.on('close', () => this.#connections.delete(socket));
    socket.on('data', (chunk) => {
      let frames: unknown[];
      try { frames = decoder.push(chunk); } catch (error) { void write(socket, wireError('bad-frame', String(error))); socket.destroy(); return; }
      for (const raw of frames) void this.#dispatch(raw, connection, socket);
    });
  }

  async #dispatch(raw: unknown, connection: ServerConnection, socket: Socket) {
    if (!raw || typeof raw !== 'object') return write(socket, wireError('bad-frame', 'Frame must be a JSON object'));
    const frame = raw as Partial<ClientFrame>;
    const reqId = 'reqId' in frame && typeof frame.reqId === 'string' ? frame.reqId : undefined;
    if (frame.token !== this.options.token) return write(socket, wireError('unauthorized', 'Invalid broker token', reqId));
    if (frame.epoch !== this.options.epoch) return write(socket, wireError('stale-epoch', `Expected broker epoch ${this.options.epoch}`, reqId));
    try { const response = await this.options.handler(frame as ClientFrame, connection); if (response) await write(socket, response); }
    catch (error) { await write(socket, wireError('handler-error', error instanceof Error ? error.message : String(error), reqId)); }
  }
}

const wireError = (code: string, message: string, reqId?: string): ErrorFrame => ({ ...(reqId ? { reqId } : {}), ok: false, error: { code, message } });
const write = (socket: Socket, frame: ServerFrame) => new Promise<void>((resolve, reject) => socket.write(encodeFrame(frame), (error) => error ? reject(error) : resolve()));
const listen = (server: Server, endpoint: string) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.off('error', reject); resolve(); }); });
const endpointIsLive = (endpoint: string) => new Promise<boolean>((resolve) => {
  const socket = createConnection(endpoint); const done = (live: boolean) => { socket.destroy(); resolve(live); };
  socket.once('connect', () => done(true)); socket.once('error', () => done(false)); setTimeout(() => done(false), 250).unref();
});
