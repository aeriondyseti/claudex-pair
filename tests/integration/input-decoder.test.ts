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
