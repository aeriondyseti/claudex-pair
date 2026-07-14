import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Legacy-session guard: an ACTIVE pre-broker session (fs `.pair/`, no
 * journal dir) must keep running through the fs path even though broker is
 * the default — an empty journal would report it session-not-active and
 * strand the participants mid-session. Assertions: fs-correct output AND no
 * daemon artifacts (broker.lease/token) appear.
 */

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const cli = join(here, '..', '..', 'src', 'apps', 'cli', 'main.ts');

async function legacyRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'claudex-legacy-'));
  const pair = join(root, '.pair');
  await mkdir(join(pair, 'inbox', 'claude'), { recursive: true });
  await mkdir(join(pair, 'inbox', 'codex'), { recursive: true });
  await mkdir(join(pair, 'archive'), { recursive: true });
  await writeFile(
    join(pair, 'session.json'),
    JSON.stringify({
      task: 'legacy task', agents: ['claude', 'codex'], driver: 'claude',
      navigators: ['codex'], turn: 'claude', status: 'active', started: '2026-07-14 12:00:00',
    }, null, 2),
    'utf8',
  );
  await writeFile(join(pair, 'memory.md'), '# Pair session memory\n', 'utf8');
  return root;
}

async function runCli(root: string, argv: string[]): Promise<{ code: number; output: string }> {
  // Deliberately NO CLAUDEX_PROTOCOL_MODE: the guard itself must divert.
  const env = { ...process.env };
  delete env['CLAUDEX_PROTOCOL_MODE'];
  const proc = Bun.spawn(['bun', 'run', cli, ...argv], { cwd: root, stdout: 'pipe', stderr: 'pipe', env });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: stdout + stderr };
}

describe('legacy fs-session guard', () => {
  test('active legacy session routes to fs: status works, send commits, no daemon is spawned', async () => {
    const root = await legacyRepo();
    try {
      const status = await runCli(root, ['status']);
      expect(status.code).toBe(0);
      expect(status.output).toContain('legacy task');
      expect(status.output).toContain('Turn: claude');

      const send = await runCli(root, ['send', '-From', 'claude', '-To', 'codex', '-Type', 'ask', '-Message', 'legacy send', '-NoWait']);
      expect(send.code).toBe(0);
      expect(send.output).toContain('Sent ask -> codex');

      // The guard's whole point: no broker artifacts for a legacy session.
      expect(existsSync(join(root, '.pair', 'broker.lease'))).toBeFalse();
      expect(existsSync(join(root, '.pair', 'broker.token'))).toBeFalse();
      expect(existsSync(join(root, '.pair', 'journal'))).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('completed legacy session does NOT divert: broker path may own the next init', async () => {
    const root = await legacyRepo();
    try {
      const pair = join(root, '.pair');
      const session = JSON.parse(await Bun.file(join(pair, 'session.json')).text());
      session.status = 'completed';
      await writeFile(join(pair, 'session.json'), JSON.stringify(session, null, 2), 'utf8');

      // status on a completed legacy session goes to the broker path; a
      // fresh daemon with an empty journal answers session-not-active. That
      // is CORRECT post-guard behavior (the old session is over; broker owns
      // what comes next) — accept either that error or an fs fallback, but
      // never a silent success claiming the stale session is live.
      const env: Record<string, string | undefined> = { ...process.env, CLAUDEX_BROKER_IDLE_GRACE_MS: '1000' };
      delete env['CLAUDEX_PROTOCOL_MODE'];
      const proc = Bun.spawn(['bun', 'run', cli, 'status'], { cwd: root, stdout: 'pipe', stderr: 'pipe', env });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const output = stdout + stderr;
      expect(code === 0 ? output.includes('completed') : /session|broker/i.test(output)).toBeTrue();

      // Clean up any daemon the broker path spawned (fast idle grace).
      const stop = Bun.spawn(['bun', 'run', cli, 'broker', 'stop', '-Root', root], { cwd: root, stdout: 'pipe', stderr: 'pipe', env });
      await stop.exited;
      await Bun.sleep(500);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
