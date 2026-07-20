import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionState } from '@core/types.ts';
import { FsMirrors } from '@adapters/fs/brokerMirrors.ts';
import { MirrorConflictError } from '@broker/ports.ts';

/**
 * Close-out #7: the informational .pair/user-channel.json mirror. Broker-
 * written on the registration event, covered by the mirror manifest (an
 * external edit at parity is TAMPER, never silently accepted), recreated or
 * removed by rebuild per recovered state, and never containing the token or
 * its hash.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const base: SessionState = {
  task: 't', agents: ['claude', 'codex'], driver: 'claude', turn: 'claude',
  status: 'active', started: 's', grants: {}, registry: { version: 1, agents: {} },
};
const registered: SessionState = { ...base, userChannelTokenHash: 'a'.repeat(64) };

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claudex-ucmirror-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('user-channel informational mirror', () => {
  test('registration event writes the mirror, manifest covers it, reconcile is clean, and no secret material leaks', async () => {
    const dir = await root();
    const mirrors = new FsMirrors(dir);
    await mirrors.applyInit(base);
    await mirrors.applyEvents(registered, [{ kind: 'user-channel-registered', tokenHash: registered.userChannelTokenHash!, at: 'now' }], 2);

    const path = join(dir, '.pair', 'user-channel.json');
    const content = await readFile(path, 'utf8');
    expect(JSON.parse(content)).toMatchObject({ registered: true });
    expect(content).not.toContain(registered.userChannelTokenHash!); // never the hash
    const manifest = await mirrors.readManifest();
    expect(manifest?.files['user-channel.json']).toBeDefined(); // covered = tamper-detectable
    expect(await mirrors.reconcile(registered, [], 2)).toBe('clean');
  });

  test('tamper or deletion at parity SELF-HEALS from journal state — never a global conflict (design §2/§7)', async () => {
    const dir = await root();
    const mirrors = new FsMirrors(dir);
    await mirrors.applyInit(base);
    await mirrors.applyEvents(registered, [{ kind: 'user-channel-registered', tokenHash: registered.userChannelTokenHash!, at: 'now' }], 2);
    const path = join(dir, '.pair', 'user-channel.json');

    // Tamper → repaired/normalized, not MirrorConflictError.
    await writeFile(path, '{"registered":false,"forged":true}\n', 'utf8');
    expect(await mirrors.reconcile(registered, [], 2)).toBe('rebuilt');
    const repaired = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(repaired['registered']).toBeTrue();
    expect(repaired['forged']).toBeUndefined();
    expect(await mirrors.reconcile(registered, [], 2)).toBe('clean'); // repair converges

    // Deletion → recreated.
    await rm(path, { force: true });
    expect(await mirrors.reconcile(registered, [], 2)).toBe('rebuilt');
    expect(existsSync(path)).toBeTrue();

    // Spurious file on an UNREGISTERED session → removed.
    const dir2 = await root();
    const mirrors2 = new FsMirrors(dir2);
    await mirrors2.applyInit(base);
    await mirrors2.applyEvents(base, [{ kind: 'turn-passed', to: 'codex' }], 2);
    await writeFile(join(dir2, '.pair', 'user-channel.json'), '{"registered":true}\n', 'utf8');
    expect(await mirrors2.reconcile(base, [], 2)).toBe('rebuilt');
    expect(existsSync(join(dir2, '.pair', 'user-channel.json'))).toBeFalse();
  });

  test('a new session init and rebuild(undefined) both clear a stale mirror — registered:true never leaks into an unbound session (codex round 1)', async () => {
    const dir = await root();
    const mirrors = new FsMirrors(dir);
    const path = join(dir, '.pair', 'user-channel.json');

    // Session 1 registers; its mirror exists.
    await mirrors.applyInit(base);
    await mirrors.applyEvents(registered, [{ kind: 'user-channel-registered', tokenHash: registered.userChannelTokenHash!, at: 'now' }], 2);
    expect(existsSync(path)).toBeTrue();

    // A NEW session initializes over it: the stale binding claim is gone.
    await mirrors.applyInit(base);
    expect(existsSync(path)).toBeFalse();

    // Recreate, then rebuild with NO recovered state: also gone.
    await mirrors.applyEvents(registered, [{ kind: 'user-channel-registered', tokenHash: registered.userChannelTokenHash!, at: 'now' }], 3);
    expect(existsSync(path)).toBeTrue();
    await mirrors.rebuild(undefined, [], 4);
    expect(existsSync(path)).toBeFalse();
  });

  test('pre-feature upgrade: registered state, file absent from BOTH disk and old manifest — reconcile CREATES it (state-driven, not drift-driven)', async () => {
    const dir = await root();
    const mirrors = new FsMirrors(dir);
    await mirrors.applyInit(base);
    // Simulate a pre-feature session: registered in the journal, but the
    // mirror writes never happened (turn-passed keeps the manifest current
    // WITHOUT a user-channel entry — undefined===undefined drift).
    await mirrors.applyEvents(registered, [{ kind: 'turn-passed', to: 'codex' }], 2);
    const path = join(dir, '.pair', 'user-channel.json');
    expect(existsSync(path)).toBeFalse();

    expect(await mirrors.reconcile(registered, [], 2)).toBe('rebuilt');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ registered: true });
    expect(await mirrors.reconcile(registered, [], 2)).toBe('clean');
  });

  test('session-initialized EVENT path normalizes: a new unbound session removes the prior canonical file even with a matching manifest', async () => {
    const dir = await root();
    const mirrors = new FsMirrors(dir);
    await mirrors.applyInit(base);
    await mirrors.applyEvents(registered, [{ kind: 'user-channel-registered', tokenHash: registered.userChannelTokenHash!, at: 'now' }], 2);
    const path = join(dir, '.pair', 'user-channel.json');
    expect(existsSync(path)).toBeTrue();
    // Replay-style init event (no applyInit): the file goes immediately.
    await mirrors.applyEvents(base, [{ kind: 'session-initialized', task: 't2', agents: ['claude', 'codex'], driver: 'claude', at: 'later' }], 3);
    expect(existsSync(path)).toBeFalse();
    expect(await mirrors.reconcile(base, [], 3)).toBe('clean');
  });

  test('authoritative-set tamper still conflicts — the exemption is exactly one informational file', async () => {
    const dir = await root();
    const mirrors = new FsMirrors(dir);
    await mirrors.applyInit(base);
    await mirrors.applyEvents(registered, [{ kind: 'user-channel-registered', tokenHash: registered.userChannelTokenHash!, at: 'now' }], 2);
    await writeFile(join(dir, '.pair', 'session.json'), '{"forged":true}\n', 'utf8');
    await expect(mirrors.reconcile(registered, [], 2)).rejects.toThrow(MirrorConflictError);
  });

  test('rebuild recreates the mirror for a registered session and removes it when the recovered state has no binding', async () => {
    const dir = await root();
    const mirrors = new FsMirrors(dir);
    await mirrors.applyInit(base);
    const path = join(dir, '.pair', 'user-channel.json');

    await mirrors.rebuild(registered, [], 3);
    expect(existsSync(path)).toBeTrue();
    expect(await mirrors.reconcile(registered, [], 3)).toBe('clean');

    // Stale file + recovered state WITHOUT a binding: rebuild removes it.
    await mirrors.rebuild(base, [], 4);
    expect(existsSync(path)).toBeFalse();
    expect(await mirrors.reconcile(base, [], 4)).toBe('clean');
  });
});
