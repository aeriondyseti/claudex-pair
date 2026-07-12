import { describe, expect, test } from 'bun:test';
import { decide, replay } from '../../src/core/index.ts';
import type { CommandEnvelope } from '../../src/core/commands.ts';

/**
 * Regression: end-session fan-out messages must carry DISTINCT ids — mailbox
 * file names derive from the id, and identically-named files for different
 * recipients overwrite each other in the shared archive. Found live when the
 * TS port's own session-end produced two '...-claude-done.md' twins.
 */
describe('end-session fan-out', () => {
  test('every done message has a unique id in an n-agent session', () => {
    const env = (command: unknown, principal: string): CommandEnvelope =>
      ({ command, meta: { id: 'm-end', at: 't', principal } }) as CommandEnvelope;
    const init = decide(undefined, env({ kind: 'init-session', task: 't', agents: ['claude', 'codex', 'agy'], driver: 'claude' }, 'claude'));
    if (!init.ok) throw new Error('init failed');
    const state = replay(init.value);
    const ended = decide(state, env({ kind: 'end-session', summary: 's' }, 'claude'));
    if (!ended.ok) throw new Error('end failed');
    const messages = ended.value.filter((e) => e.kind === 'message-sent');
    expect(messages.length).toBe(2);
    const ids = new Set(messages.map((m) => (m.kind === 'message-sent' ? m.id : '')));
    expect(ids.size).toBe(2);
  });
});
