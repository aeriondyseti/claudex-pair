export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export function encodeFrame(value: unknown): string { return `${JSON.stringify(value)}\n`; }

export class NdjsonDecoder {
  #buffer = '';
  push(chunk: Uint8Array | string): unknown[] {
    this.#buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk, { stream: true });
    if (Buffer.byteLength(this.#buffer) > MAX_FRAME_BYTES) throw new Error('IPC frame exceeds 4 MiB');
    const frames: unknown[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) frames.push(JSON.parse(line));
    }
    return frames;
  }
}
