import { describe, expect, test } from 'bun:test';
import { InputDecoder } from '../../src/apps/cli/term.ts';

/** Frozen v1 input contract (U1-SLICE3-DESIGN.md): printable is ALWAYS
 * text (q types q), commands are chords, ANSI state survives chunk
 * boundaries, CRLF submits once. Blocking tests per codex slice review. */

type Emitted = { kind: 'text'; text: string } | { kind: 'key'; key: string } | { kind: 'quit' };

function run(decoder: InputDecoder, ...chunks: (Buffer | string)[]): Emitted[] {
  const out: Emitted[] = [];
  for (const chunk of chunks) {
    decoder.decode(chunk, {
      onQuit: () => out.push({ kind: 'quit' }),
      onText: (text) => out.push({ kind: 'text', text }),
      onKey: (key) => out.push({ kind: 'key', key }),
    });
  }
  return out;
}

describe('InputDecoder (frozen v1 contract)', () => {
  test('printable is always text — q and f type, never command', () => {
    expect(run(new InputDecoder(), 'quiet fox')).toEqual([{ kind: 'text', text: 'quiet fox' }]);
  });

  test('chords decode: Ctrl+C/Ctrl+Q quit, Ctrl+F filter, Tab, Backspace, Enter', () => {
    expect(run(new InputDecoder(), Buffer.from([0x03]))).toEqual([{ kind: 'quit' }]);
    expect(run(new InputDecoder(), Buffer.from([0x11]))).toEqual([{ kind: 'quit' }]);
    expect(run(new InputDecoder(), Buffer.from([0x06, 0x09, 0x7f, 0x0d]))).toEqual([
      { kind: 'key', key: 'filter' }, { kind: 'key', key: 'tab' }, { kind: 'key', key: 'backspace' }, { kind: 'key', key: 'submit' },
    ]);
  });

  test('CRLF submits exactly once — split across chunks too', () => {
    expect(run(new InputDecoder(), Buffer.from('hi\r\n'))).toEqual([{ kind: 'text', text: 'hi' }, { kind: 'key', key: 'submit' }]);
    expect(run(new InputDecoder(), Buffer.from('hi\r'), Buffer.from('\n'))).toEqual([{ kind: 'text', text: 'hi' }, { kind: 'key', key: 'submit' }]);
    // Bare LF still submits (unix terminals).
    expect(run(new InputDecoder(), Buffer.from('\n'))).toEqual([{ kind: 'key', key: 'submit' }]);
  });

  test('CSI sequences decode whole and are stateful across chunk boundaries', () => {
    expect(run(new InputDecoder(), Buffer.from('\x1b[5~'))).toEqual([{ kind: 'key', key: 'page-up' }]);
    expect(run(new InputDecoder(), Buffer.from('\x1b[6~'))).toEqual([{ kind: 'key', key: 'page-down' }]);
    expect(run(new InputDecoder(), Buffer.from('\x1b[F'))).toEqual([{ kind: 'key', key: 'end' }]);
    // Split after ESC: continuation must NOT become composer text.
    expect(run(new InputDecoder(), Buffer.from('\x1b'), Buffer.from('[5~'))).toEqual([{ kind: 'key', key: 'page-up' }]);
    // Split after ESC-[: same.
    expect(run(new InputDecoder(), Buffer.from('\x1b['), Buffer.from('6~'))).toEqual([{ kind: 'key', key: 'page-down' }]);
    // Split mid-parameters.
    expect(run(new InputDecoder(), Buffer.from('\x1b[5'), Buffer.from('~x'))).toEqual([{ kind: 'key', key: 'page-up' }, { kind: 'text', text: 'x' }]);
  });

  test('lone ESC (not a sequence) is escape once the next chunk disambiguates', () => {
    expect(run(new InputDecoder(), Buffer.from([0x1b]), Buffer.from('a'))).toEqual([{ kind: 'key', key: 'escape' }, { kind: 'text', text: 'a' }]);
  });

  test('unknown CSI (arrows) consumed and ignored — never text', () => {
    expect(run(new InputDecoder(), Buffer.from('\x1b[Aabc'))).toEqual([{ kind: 'text', text: 'abc' }]);
  });

  test('UTF-8 multibyte survives chunk splits', () => {
    const bytes = Buffer.from('héllo — ok');
    const decoder = new InputDecoder();
    const out = run(decoder, bytes.subarray(0, 3), bytes.subarray(3));
    const text = out.filter((e): e is Extract<Emitted, { kind: 'text' }> => e.kind === 'text').map((e) => e.text).join('');
    expect(text).toBe('héllo — ok');
  });
});

describe('bounded lone-Esc disambiguation (close-out blocker, design §5)', () => {
  function collect() {
    const out: Emitted[] = [];
    const handlers = {
      onQuit: () => out.push({ kind: 'quit' as const }),
      onText: (text: string) => out.push({ kind: 'text' as const, text }),
      onKey: (key: string) => out.push({ kind: 'key' as const, key }),
    };
    return { out, handlers };
  }

  test('a standalone Esc keypress emits WITHOUT any second input: hold, then host flush resolves it', () => {
    const decoder = new InputDecoder();
    const { out, handlers } = collect();
    decoder.decode(Buffer.from([0x1b]), handlers); // real Esc key: its own chunk
    expect(out).toEqual([]); // held — could still be a CSI prefix
    expect(decoder.pendingEscape).toBeTrue(); // the host's timer-arming signal
    decoder.flushPending(handlers); // host timer fired, no continuation came
    expect(out).toEqual([{ kind: 'key', key: 'escape' }]);
    expect(decoder.pendingEscape).toBeFalse();
    decoder.flushPending(handlers); // idempotent — nothing held
    expect(out).toEqual([{ kind: 'key', key: 'escape' }]);
  });

  test('a split CSI stays intact: the continuation cancels ambiguity and no phantom escape is emitted', () => {
    const decoder = new InputDecoder();
    const { out, handlers } = collect();
    decoder.decode(Buffer.from([0x1b]), handlers); // chunk 1: ESC
    expect(decoder.pendingEscape).toBeTrue();
    decoder.decode(Buffer.from('[5~'), handlers); // chunk 2: continuation arrives in time
    expect(out).toEqual([{ kind: 'key', key: 'page-up' }]); // one key, no escape
    expect(decoder.pendingEscape).toBeFalse();
    decoder.flushPending(handlers); // a late/stale host timer must be harmless
    expect(out).toEqual([{ kind: 'key', key: 'page-up' }]);
  });

  test('a partial CSI that stalls to the flush deadline is dropped, never misread as Esc or text', () => {
    const decoder = new InputDecoder();
    const { out, handlers } = collect();
    decoder.decode(Buffer.from([0x1b, 0x5b, 0x35]), handlers); // ESC [ 5 — mid-sequence stall
    expect(decoder.pendingEscape).toBeTrue();
    decoder.flushPending(handlers);
    expect(out).toEqual([]); // garbage discarded — consumed-and-ignored
    expect(decoder.pendingEscape).toBeFalse();
    decoder.decode(Buffer.from('ok'), handlers); // stream continues cleanly
    expect(out).toEqual([{ kind: 'text', text: 'ok' }]);
  });
});
