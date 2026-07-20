import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiskSession } from './types.ts';

export const MEMORY_TEMPLATE = (task: string): string => `# Pair session memory

Shared long-lived context for this pairing session. Append-only while the
session runs; only the current turn-holder writes here. Never rewrite or
delete your partner's entries.

## Task

${task}

## Ground rules

- The driver edits code; navigators review and direct but do not edit files.
- Keep messages short and concrete; reference code as path:line.
- Record durable decisions under Decisions before passing the turn.

## Decisions

<!-- - [claude 14:03] chose X over Y because Z -->

## Open questions

## Handoff notes`;

export class FsSessionStore {
  readonly pairDir: string;
  constructor(readonly root: string) { this.pairDir = join(root, '.pair'); }

  async initialize(session: DiskSession): Promise<{ gitignoreUpdated: boolean }> {
    await mkdir(join(this.pairDir, 'archive'), { recursive: true });
    await Promise.all(session.agents.map((agent) => mkdir(join(this.pairDir, 'inbox', agent), { recursive: true })));
    await this.save(session);
    try { await readFile(join(this.pairDir, 'memory.md')); }
    catch { await writeFile(join(this.pairDir, 'memory.md'), MEMORY_TEMPLATE(session.task), 'utf8'); }
    // Legacy Cmd-Init parity: keep session state out of version control.
    const gitignore = join(this.root, '.gitignore');
    try {
      const current = await readFile(gitignore, 'utf8');
      if (!/^\.pair\//m.test(current)) {
        await writeFile(gitignore, `${current}\n.pair/\n`, 'utf8');
        return { gitignoreUpdated: true };
      }
    } catch {
      /* no .gitignore — same as pair.ps1, do not create one */
    }
    return { gitignoreUpdated: false };
  }

  async load(): Promise<DiskSession> {
    return JSON.parse(await readFile(join(this.pairDir, 'session.json'), 'utf8')) as DiskSession;
  }

  async save(session: DiskSession): Promise<void> {
    await mkdir(this.pairDir, { recursive: true });
    const target = join(this.pairDir, 'session.json');
    const temp = join(this.pairDir, 'session.json.tmp');
    const disk: DiskSession = {
      task: session.task, agents: [...session.agents],
      ...(session.driver === undefined ? {} : { driver: session.driver }),
      ...(session.navigators === undefined ? {} : { navigators: [...session.navigators] }),
      ...(session.turn === undefined ? {} : { turn: session.turn }),
      ...(session.topology === undefined ? {} : { topology: session.topology }),
      ...(session.initiator === undefined ? {} : { initiator: session.initiator }),
      ...(session.phase === undefined ? {} : { phase: session.phase }),
      status: session.status, started: session.started,
      ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
      ...(session.registry === undefined ? {} : { registry: session.registry }),
    };
    await writeFile(temp, JSON.stringify(disk, null, 2), 'utf8');
    await rename(temp, target);
  }
}
