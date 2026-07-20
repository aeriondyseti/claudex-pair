import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandEnvelope } from '../../src/core/commands.ts';
import { decide } from '../../src/core/decide.ts';
import { bindFsDeps } from '../../src/apps/cli/bind.ts';

/** M1 finding 4 (codex): explicit FS mode must PERSIST the registry — a
 * reload may never re-synthesize v0 over real membership history. */

const AT = '2026-07-20 14:00:00';
const env = (command: unknown, principal: string, id: string): CommandEnvelope =>
  ({ command, meta: { id, at: AT, principal } }) as CommandEnvelope;

function decided(state: Parameters<typeof decide>[0], command: unknown, principal: string, id: string) {
  const e = env(command, principal, id);
  const d = decide(state, e);
  if (!d.ok) throw d.error;
  return { envelope: e, events: d.value };
}

describe('fs binding: registry persistence + header projection', () => {
  test('init -> join -> leave -> reload keeps version/history; message headers carry reply_to/session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-fsreg-'));
    const deps = bindFsDeps(root);

    const init = decided(undefined, { kind: 'init-session', task: 't', agents: ['claude', 'codex'], driver: 'claude', sessionId: 'session-fs-1' }, 'claude', 'i1');
    await deps.store.initialize(init.envelope, init.events);

    let state = (await deps.store.load())!;
    expect(state.sessionId).toBe('session-fs-1');
    expect(state.registry.version).toBe(1);

    const admit = decided(state, { kind: 'join-session', agent: 'agy', meta: { display: 'Antigravity' } }, 'claude', 'j1');
    await deps.store.commit(admit.envelope, admit.events);
    state = (await deps.store.load())!;
    expect(state.registry.version).toBe(2);
    expect(state.registry.agents['agy']).toMatchObject({ display: 'Antigravity', status: 'active' });

    const leave = decided(state, { kind: 'leave-session' }, 'agy', 'l1');
    await deps.store.commit(leave.envelope, leave.events);

    // Reload through a FRESH binding: history must survive, not re-synthesize.
    const state2 = (await bindFsDeps(root).store.load())!;
    expect(state2.registry.version).toBe(3);
    expect(state2.registry.agents['agy']).toMatchObject({ status: 'left', leftAt: AT });

    // Header projection: an ask/answer pair with replyTo + sessionId.
    const ask = decided(state2, { kind: 'send-message', to: 'codex', type: 'ask', turn: 'keep', body: 'q' }, 'claude', 'a1');
    await deps.store.commit(ask.envelope, ask.events);
    const pending = await deps.mailbox.pending('codex');
    const stored = pending.find((m) => m.header.id === 'a1')!;
    expect(stored.header.sessionId).toBe('session-fs-1');
    expect(stored.raw).toContain('session_id: session-fs-1');
  });
});
