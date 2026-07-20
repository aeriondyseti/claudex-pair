/**
 * Terminal host adapter for the watch event loop (slice-2 host lane).
 * Owns raw-mode key decoding, resize events, and alternate-screen entry
 * with guaranteed restore — the reducer never touches the terminal, and
 * no exit path may leave the user's shell in raw mode or the alt buffer
 * (TUI-UPGRADE-NOTES slice 2: "Ctrl+C cleanup without leaving cursor/ANSI
 * state corrupted").
 */

export type TerminalHandlers = {
  /** Ctrl+C/Ctrl+Q in raw mode; SIGINT/SIGTERM otherwise. */
  onQuit: () => void;
  /** Fired with the new usable frame width. */
  onResize: (width: number) => void;
  /** U1 composer input (raw mode only): printable text, UTF-8 aggregated. */
  onText?: (text: string) => void;
  /** U1 command chords (raw mode only). */
  onKey?: (key: 'submit' | 'escape' | 'backspace' | 'tab' | 'page-up' | 'page-down' | 'end' | 'filter') => void;
};

/**
 * Frozen v1 decoder (U1-SLICE3-DESIGN.md): printable input is ALWAYS text
 * (input line always focused — `q` types `q`); commands are non-printable
 * chords only. Unknown ANSI escape sequences are consumed and ignored.
 * UTF-8 is aggregated across chunk boundaries via a streaming decoder.
 */
export class InputDecoder {
  #utf8 = new TextDecoder('utf-8');
  /** ESC/CSI state survives chunk boundaries (codex slice review #5): a
   * chunk ending in ESC or ESC-[ must not emit escape/text prematurely. */
  #escape: Buffer = Buffer.alloc(0);
  #lastWasCR = false;

  decode(chunk: Buffer | string, handlers: Pick<TerminalHandlers, 'onQuit' | 'onText' | 'onKey'>): void {
    let bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (this.#escape.length > 0) {
      bytes = Buffer.concat([this.#escape, bytes]);
      this.#escape = Buffer.alloc(0);
    }
    let text = '';
    const flush = () => {
      if (text.length > 0) handlers.onText?.(text);
      text = '';
    };
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;
      const wasCR = this.#lastWasCR;
      this.#lastWasCR = byte === 0x0d;
      if (byte === 0x03 || byte === 0x11) { flush(); handlers.onQuit(); continue; } // Ctrl+C / Ctrl+Q
      if (byte === 0x0d) { flush(); handlers.onKey?.('submit'); continue; }
      if (byte === 0x0a) { if (!wasCR) { flush(); handlers.onKey?.('submit'); } continue; } // CRLF = ONE submit
      if (byte === 0x7f || byte === 0x08) { flush(); handlers.onKey?.('backspace'); continue; }
      if (byte === 0x09) { flush(); handlers.onKey?.('tab'); continue; }
      if (byte === 0x06) { flush(); handlers.onKey?.('filter'); continue; } // Ctrl+F
      if (byte === 0x1b) {
        flush();
        if (i === bytes.length - 1) { this.#escape = Buffer.from([0x1b]); return; } // ESC at boundary: hold
        if (bytes[i + 1] === 0x5b) {
          // CSI: consume through the final byte (0x40-0x7e); if the chunk
          // ends mid-sequence, hold the prefix for the next decode call.
          let j = i + 2;
          while (j < bytes.length && (bytes[j]! < 0x40 || bytes[j]! > 0x7e)) j++;
          if (j >= bytes.length) { this.#escape = Buffer.from(bytes.subarray(i)); return; }
          const body = bytes.subarray(i + 2, j + 1).toString('latin1');
          if (body === '5~') handlers.onKey?.('page-up');
          else if (body === '6~') handlers.onKey?.('page-down');
          else if (body === 'F' || body === '4~') handlers.onKey?.('end');
          // other sequences (arrows etc.): consumed, ignored in v1
          i = j;
          continue;
        }
        handlers.onKey?.('escape');
        continue;
      }
      if (byte < 0x20) { flush(); continue; } // other control bytes: ignored
      // Printable: find the run end, stream-decode (multibyte-safe).
      let j = i;
      while (j < bytes.length && bytes[j]! >= 0x20 && bytes[j]! !== 0x7f) j++;
      text += this.#utf8.decode(bytes.subarray(i, j), { stream: true });
      i = j - 1;
    }
    flush();
  }

  /** True while a chunk-ending ESC/CSI prefix is held awaiting continuation. */
  get pendingEscape(): boolean {
    return this.#escape.length > 0;
  }

  /**
   * Bounded-ambiguity flush (design §5; codex close-out blocker): a real
   * standalone Esc keypress arrives as a chunk-ending lone ESC, which decode()
   * must hold (it could be a CSI prefix) — the HOST disambiguates by calling
   * this after a short timer that any continuation chunk cancels. A held lone
   * ESC is the Escape key; a held partial CSI that stalled long enough to hit
   * the timer is garbage and is dropped (consumed-and-ignored, exactly like
   * unknown complete sequences).
   */
  flushPending(handlers: Pick<TerminalHandlers, 'onQuit' | 'onText' | 'onKey'>): void {
    const held = this.#escape;
    this.#escape = Buffer.alloc(0);
    if (held.length === 1 && held[0] === 0x1b) handlers.onKey?.('escape');
  }
}

export type TerminalSession = {
  /** False when stdin is not a TTY (piped) — no raw mode, no key input. */
  readonly interactive: boolean;
  width(): number;
  /** Idempotent; safe from finally blocks and signal handlers alike. */
  close(): void;
};

/** Structural stream types so cleanup behavior is unit-testable with fakes
 * (codex close-out review: render-only smoke is not cleanup coverage). */
export type TermIn = {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): void;
  pause(): void;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
};
export type TermOut = {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): unknown;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
};
export type TermIo = { stdin: TermIn; stdout: TermOut };

export const ENTER_ALT = '\x1b[?1049h\x1b[?25l'; // alt buffer + hide cursor
export const LEAVE_ALT = '\x1b[?25h\x1b[?1049l'; // restore cursor + main buffer

export function frameWidth(): number {
  return Math.max(60, (process.stdout.columns ?? 100) - 1);
}

/** Clear-and-redraw with a frame-equality gate — the FINAL render coalescer
 * (seam amendment 4); the reducer's render effect is only semantic
 * eligibility. Writer injectable so tests keep their output clean. */
export class Screen {
  #last = '';
  readonly #write: (chunk: string) => void;
  constructor(write: (chunk: string) => void = (chunk) => void process.stdout.write(chunk)) {
    this.#write = write;
  }
  draw(frame: string): void {
    if (frame === this.#last) return;
    this.#write(`\x1b[2J\x1b[H${frame}`);
    this.#last = frame;
  }
}

export function openTerminal(handlers: TerminalHandlers, options: { altScreen?: boolean; io?: TermIo } = {}): TerminalSession {
  const stdin: TermIn = options.io?.stdin ?? process.stdin;
  const stdout: TermOut = options.io?.stdout ?? process.stdout;
  const interactive = stdin.isTTY === true && stdout.isTTY === true;
  const altScreen = (options.altScreen ?? true) && interactive;
  const width = () => Math.max(60, (stdout.columns ?? 100) - 1);

  // Raw mode swallows SIGINT — Ctrl+C is decoded as quit here. Plain `q`
  // is TEXT per the frozen v1 input model (chord-only quit).
  const decoder = new InputDecoder();
  // Lone-Esc disambiguation window: long enough for a split CSI's
  // continuation bytes to arrive (same wire, sub-millisecond), short enough
  // that a human Esc press feels immediate.
  const ESC_FLUSH_MS = 40;
  let escTimer: ReturnType<typeof setTimeout> | undefined;
  const onData = (chunk: Buffer | string) => {
    if (escTimer) { clearTimeout(escTimer); escTimer = undefined; } // continuation cancels
    decoder.decode(chunk, handlers);
    if (decoder.pendingEscape) {
      escTimer = setTimeout(() => { escTimer = undefined; decoder.flushPending(handlers); }, ESC_FLUSH_MS);
      escTimer.unref?.();
    }
  };
  const onResize = () => handlers.onResize(width());
  const onSignal = () => handlers.onQuit();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (escTimer) { clearTimeout(escTimer); escTimer = undefined; }
    stdout.off('resize', onResize);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (interactive) {
      stdin.off('data', onData);
      try {
        stdin.setRawMode?.(false);
      } catch {
        /* stdin already detached */
      }
      stdin.pause();
    }
    if (altScreen) stdout.write(LEAVE_ALT);
  };

  // Signal handlers are installed UNCONDITIONALLY: raw-mode 0x03 covers the
  // keyboard only — an external SIGTERM/SIGINT must still restore the
  // terminal (codex live review). Setup failure rolls back whatever was
  // already engaged before rethrowing.
  try {
    if (altScreen) stdout.write(ENTER_ALT);
    if (interactive) {
      stdin.setRawMode!(true);
      stdin.resume();
      stdin.on('data', onData);
    }
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    stdout.on('resize', onResize);
  } catch (error) {
    close();
    throw error;
  }

  return { interactive, width, close };
}
