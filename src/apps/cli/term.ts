/**
 * Terminal host adapter for the watch event loop (slice-2 host lane).
 * Owns raw-mode key decoding, resize events, and alternate-screen entry
 * with guaranteed restore — the reducer never touches the terminal, and
 * no exit path may leave the user's shell in raw mode or the alt buffer
 * (TUI-UPGRADE-NOTES slice 2: "Ctrl+C cleanup without leaving cursor/ANSI
 * state corrupted").
 */

export type TerminalHandlers = {
  /** 'q'/'Q'/Ctrl+C in raw mode; SIGINT/SIGTERM otherwise. */
  onQuit: () => void;
  /** Fired with the new usable frame width. */
  onResize: (width: number) => void;
};

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
 * eligibility. */
export class Screen {
  #last = '';
  draw(frame: string): void {
    if (frame === this.#last) return;
    process.stdout.write(`\x1b[2J\x1b[H${frame}`);
    this.#last = frame;
  }
}

export function openTerminal(handlers: TerminalHandlers, options: { altScreen?: boolean; io?: TermIo } = {}): TerminalSession {
  const stdin: TermIn = options.io?.stdin ?? process.stdin;
  const stdout: TermOut = options.io?.stdout ?? process.stdout;
  const interactive = stdin.isTTY === true && stdout.isTTY === true;
  const altScreen = (options.altScreen ?? true) && interactive;
  const width = () => Math.max(60, (stdout.columns ?? 100) - 1);

  const onData = (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    for (const byte of bytes) {
      // q / Q / Ctrl+C — raw mode swallows SIGINT, so 0x03 must quit here.
      if (byte === 0x71 || byte === 0x51 || byte === 0x03) handlers.onQuit();
    }
  };
  const onResize = () => handlers.onResize(width());
  const onSignal = () => handlers.onQuit();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
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
