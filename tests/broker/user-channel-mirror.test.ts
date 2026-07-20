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
  status: 'active', started: 's', grants: {},
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

  test('an external edit at manifest parity is reported as tamper', async () => {
    const dir = await root();
    const mirrors = new FsMirrors(dir);
    await mirrors.applyInit(base);
    await mirrors.applyEvents(registered, [{ kind: 'user-channel-registered', tokenHash: registered.userChannelTokenHash!, at: 'now' }], 2);

    await writeFile(join(dir, '.pair', 'user-channel.json'), '{"registered":false,"forged":true}\n', 'utf8');
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
