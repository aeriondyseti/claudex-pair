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

const ENTER_ALT = '\x1b[?1049h\x1b[?25l'; // alt buffer + hide cursor
const LEAVE_ALT = '\x1b[?25h\x1b[?1049l'; // restore cursor + main buffer

export function frameWidth(): number {
  return Math.max(60, (process.stdout.columns ?? 100) - 1);
}

export function openTerminal(handlers: TerminalHandlers, options: { altScreen?: boolean } = {}): TerminalSession {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const interactive = stdin.isTTY === true && stdout.isTTY === true;
  const altScreen = (options.altScreen ?? true) && interactive;

  const onData = (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    for (const byte of bytes) {
      // q / Q / Ctrl+C — raw mode swallows SIGINT, so 0x03 must quit here.
      if (byte === 0x71 || byte === 0x51 || byte === 0x03) handlers.onQuit();
    }
  };
  const onResize = () => handlers.onResize(frameWidth());
  const onSignal = () => handlers.onQuit();

  if (altScreen) stdout.write(ENTER_ALT);
  if (interactive) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  } else {
    // Piped stdin cannot deliver keys; signals are the only quit path.
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }
  stdout.on('resize', onResize);

  let closed = false;
  return {
    interactive,
    width: frameWidth,
    close: () => {
      if (closed) return;
      closed = true;
      stdout.off('resize', onResize);
      if (interactive) {
        stdin.off('data', onData);
        try {
          stdin.setRawMode(false);
        } catch {
          /* stdin already detached */
        }
        stdin.pause();
      } else {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
      if (altScreen) stdout.write(LEAVE_ALT);
    },
  };
}
