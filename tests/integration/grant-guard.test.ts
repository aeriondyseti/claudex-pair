import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsGrantStore, FsSessionStore } from '../../src/adapters/fs/index.ts';

/**
 * Grants-lite invariant: the session-active recheck runs UNDER the per-grant
 * lock, so a session end that lands after the caller's precondition check but
 * before the lock cannot be followed by a grant mutation.
 */
describe('grant transition active-session guard', () => {
  test('transition is rejected when the session completed after the precondition check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claudex-guard-'));
    const sessions = new FsSessionStore(root);
    const grants = new FsGrantStore(root);
    await sessions.initialize({
      task: 't', agents: ['claude', 'codex'], driver: 'claude',
      navigators: ['codex'], turn: 'claude', status: 'active', started: 't0',
    });
    await grants.create({
      id: 'g1', issuer: 'claude', assignee: 'codex', task: 'w',
      scope: { mode: 'worktree', worktree: 'wt' }, state: 'offered',
      agreed_in: '', result: '', revision: 0, created: 't0', updated: 't0',
    });

    const guard = async () => {
      const s = await sessions.load();
      if (s.status !== 'active') throw new Error(`Session status is '${s.status}' — grant operations require an active session.`);
    };

    // Precondition (caller-side) passes while active…
    await guard();
    // …then the session ends before the transition acquires its lock.
    await sessions.save({
      task: 't', agents: ['claude', 'codex'], driver: 'claude',
      navigators: ['codex'], turn: 'claude', status: 'completed', started: 't0',
    });

    await expect(
      grants.transition('g1', ['offered'], (g) => ({ ...g, state: 'active' }), 't1', guard),
    ).rejects.toThrow(/grant operations require an active session/);

    // And the grant record is untouched.
    const g = await grants.read('g1');
    expect(g.state).toBe('offered');
    expect(g.revision).toBe(0);
  });
});
