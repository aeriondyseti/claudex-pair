import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiskGrant } from './types.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FsGrantStore {
  readonly grantsDir: string;
  constructor(readonly root: string) { this.grantsDir = join(root, '.pair', 'grants'); }
  path(id: string): string { return join(this.grantsDir, `${id}.json`); }

  async create(grant: DiskGrant): Promise<void> {
    await mkdir(this.grantsDir, { recursive: true });
    const handle = await open(this.path(grant.id), 'wx');
    try { await handle.writeFile(JSON.stringify(orderedGrant(grant), null, 2), 'utf8'); } finally { await handle.close(); }
  }

  async read(id: string): Promise<DiskGrant> {
    return JSON.parse(await readFile(this.path(id), 'utf8')) as DiskGrant;
  }

  async transition(id: string, expected: readonly DiskGrant['state'][], update: (grant: DiskGrant) => DiskGrant, now: string): Promise<DiskGrant> {
    const path = this.path(id); const lockPath = `${path}.lock`;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 40 && !lock; attempt++) {
      try { lock = await open(lockPath, 'wx'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await delay(250);
      }
    }
    if (!lock) throw new Error(`Could not lock grant '${id}' after 10s; if no other transition is running, delete ${lockPath}`);
    try {
      const current = await this.read(id);
      if (!expected.includes(current.state)) throw new Error(`Grant '${id}' is '${current.state}' (expected: ${expected.join('|')}) — stale transition rejected`);
      const next = { ...update(current), revision: current.revision + 1, updated: now };
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
      await rename(temp, path);
      return next;
    } finally { await lock.close(); await rm(lockPath, { force: true }); }
  }
}

function orderedGrant(grant: DiskGrant): DiskGrant {
  return {
    id: grant.id, issuer: grant.issuer, assignee: grant.assignee, task: grant.task,
    scope: grant.scope, state: grant.state, agreed_in: grant.agreed_in,
    result: grant.result, revision: grant.revision, created: grant.created, updated: grant.updated,
  };
}
