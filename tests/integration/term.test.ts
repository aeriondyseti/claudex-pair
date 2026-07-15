import { describe, expect, test } from 'bun:test';
import { ENTER_ALT, LEAVE_ALT, openTerminal, type TermIn, type TermIo, type TermOut } from '../../src/apps/cli/term.ts';

/**
 * Terminal cleanup contract with injected fakes (codex close-out review:
 * a render smoke is not cleanup coverage) — alt enter/leave pairing, raw
 * mode true/false, idempotent close, and rollback on setup failure.
 */

function fakeIo(options: { rawThrows?: boolean } = {}) {
  const writes: string[] = [];
  const raw: boolean[] = [];
  const stdin: TermIn = {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      if (options.rawThrows && mode) throw new Error('setRawMode failed');
      raw.push(mode);
      return undefined;
    },
    resume: () => undefined,
    pause: () => undefined,
    on: () => undefined,
    off: () => undefined,
  };
  const stdout: TermOut = {
    isTTY: true,
    columns: 120,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    on: () => undefined,
    off: () => undefined,
  };
  const io: TermIo = { stdin, stdout };
  return { io, writes, raw };
}

describe('openTerminal cleanup', () => {
  test('alt screen enters on open and leaves exactly once on close; raw mode true then false; close is idempotent', () => {
    const { io, writes, raw } = fakeIo();
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    const session = openTerminal({ onQuit: () => undefined, onResize: () => undefined }, { io });
    expect(session.interactive).toBeTrue();
    expect(session.width()).toBe(119);
    expect(writes).toEqual([ENTER_ALT]);
    expect(raw).toEqual([true]);
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1); // signals installed even in raw mode

    session.close();
    session.close(); // idempotent
    expect(writes).toEqual([ENTER_ALT, LEAVE_ALT]);
    expect(raw).toEqual([true, false]);
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
  });

  test('setup failure rolls back: alt screen left, no dangling signal handlers, and the error propagates', () => {
    const { io, writes, raw } = fakeIo({ rawThrows: true });
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    expect(() => openTerminal({ onQuit: () => undefined, onResize: () => undefined }, { io })).toThrow('setRawMode failed');
    expect(writes).toEqual([ENTER_ALT, LEAVE_ALT]); // engaged, then rolled back
    expect(raw).toEqual([false]); // rollback actively restored cooked mode
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
  });

  test('non-TTY: no alt screen, no raw mode, quit via signals', () => {
    const { io, writes, raw } = fakeIo();
    io.stdin.isTTY = false;
    let quits = 0;
    const preListeners = process.listeners('SIGINT');
    const session = openTerminal({ onQuit: () => { quits += 1; }, onResize: () => undefined }, { io });
    expect(session.interactive).toBeFalse();
    expect(writes).toEqual([]);
    expect(raw).toEqual([]);
    // Invoke only OUR handler — emitting a real SIGINT event would also run
    // the test runner's listeners.
    const added = process.listeners('SIGINT').filter((l) => !preListeners.includes(l));
    expect(added.length).toBe(1);
    (added[0] as () => void)();
    expect(quits).toBe(1);
    session.close();
  });
});
