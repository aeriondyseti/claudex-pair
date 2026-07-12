import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsGrantStore, FsMailbox, FsSessionStore, MEMORY_TEMPLATE, parseMessage, type DiskGrant, type DiskSession } from './index.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'claudex-fs-')); roots.push(value); return value; }

const session: DiskSession = { task: 'test task', agents: ['claude', 'codex', 'agy'], driver: 'claude', navigators: ['codex', 'agy'], turn: 'claude', status: 'active', started: '2026-07-12 12:00:00' };

describe('FsSessionStore', () => {
  test('writes exact session shape, inboxes, archive, and memory template', async () => {
    const dir = await root(); const store = new FsSessionStore(dir); await store.initialize(session);
    expect(await store.load()).toEqual(session);
    expect(Object.keys(JSON.parse(await readFile(join(dir, '.pair', 'session.json'), 'utf8')))).toEqual(['task', 'agents', 'driver', 'navigators', 'turn', 'status', 'started']);
    expect(await readdir(join(dir, '.pair', 'inbox'))).toEqual(['agy', 'claude', 'codex']);
    expect(await readFile(join(dir, '.pair', 'memory.md'), 'utf8')).toBe(MEMORY_TEMPLATE('test task'));
  });
});

describe('FsMailbox', () => {
  test('atomically publishes legacy markdown and archives claims', async () => {
    const dir = await root(); await new FsSessionStore(dir).initialize(session); const mailbox = new FsMailbox(dir);
    const message = { id: '20260712-120000-123', from: 'claude', to: 'codex', type: 'ask', turn: 'pass', sent: '2026-07-12 12:00:00', body: 'review this' } as const;
    const name = await mailbox.publish(message);
    expect(await readdir(join(dir, '.pair'))).not.toContain(`${name}.tmp`);
    expect(parseMessage(await readFile(join(dir, '.pair', 'inbox', 'codex', name), 'utf8'))).toEqual(message);
    expect(await mailbox.claimAll('codex')).toEqual([{ name, message }]);
    expect(await readdir(join(dir, '.pair', 'inbox', 'codex'))).toEqual([]);
    expect(await readdir(join(dir, '.pair', 'archive'))).toEqual([name]);
  });
});

describe('FsGrantStore', () => {
  const grant: DiskGrant = { id: 'g1-codex', issuer: 'claude', assignee: 'codex', task: 'work', scope: { mode: 'files', files: ['a.ts'] }, state: 'offered', agreed_in: '', result: '', revision: 0, created: '2026-07-12 12:00:00', updated: '2026-07-12 12:00:00' };
  test('uses CreateNew and locked stale-checked transitions', async () => {
    const dir = await root(); const store = new FsGrantStore(dir); await store.create(grant);
    await expect(store.create(grant)).rejects.toMatchObject({ code: 'EEXIST' });
    const active = await store.transition(grant.id, ['offered'], (g) => ({ ...g, state: 'active' }), '2026-07-12 12:01:00');
    expect(active).toMatchObject({ state: 'active', revision: 1, updated: '2026-07-12 12:01:00' });
    await expect(store.transition(grant.id, ['offered'], (g) => g, 'later')).rejects.toThrow("is 'active' (expected: offered)");
    expect(await readdir(store.grantsDir)).toEqual(['g1-codex.json']);
  });
});
