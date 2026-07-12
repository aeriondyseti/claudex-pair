import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

type Effect = {
  path: string; absent?: boolean; glob_count?: number; json?: unknown;
  text?: string[]; unchanged?: string[]; find?: Record<string, unknown>;
  json_array_length?: number; json_pointer?: string;
};
type Step = {
  step: string; argv: string[]; exit: number; output?: string[];
  stdout?: string[]; stderr?: string[]; capture?: Record<string, string>; effects?: Effect[];
};

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const repo = join(here, '..', '..');
const cli = join(repo, 'src', 'apps', 'cli', 'main.ts');
const scenariosDir = join(here, 'scenarios');

const scenarioFiles = [...new Bun.Glob('*.jsonl').scanSync({ cwd: scenariosDir, absolute: true })].sort();

describe('golden CLI scenarios', () => {
  for (const file of scenarioFiles) {
    const records = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const metadata = records.shift()!;
    test(String(metadata.scenario), async () => {
      const root = await mkdtemp(join(tmpdir(), 'claudex-e2e-'));
      try { await runScenario(root, records as unknown as Step[]); }
      finally { await rm(root, { recursive: true, force: true }); }
    }, 30_000);
  }
});

async function runScenario(root: string, rawSteps: Step[]) {
  const vars: Record<string, string> = {};
  for (const raw of rawSteps) {
    const step = interpolate(raw, vars);
    const before = await snapshotUnchanged(root, step.effects ?? []);
    const proc = Bun.spawn(['bun', 'run', cli, ...step.argv], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: process.env });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const output = stdout + stderr;
    expect(code, `${step.step}: exit\n${output}`).toBe(step.exit);
    for (const s of step.output ?? []) expect(output, `${step.step}: combined output`).toContain(s);
    for (const s of step.stdout ?? []) expect(stdout, `${step.step}: stdout`).toContain(s);
    for (const s of step.stderr ?? []) expect(stderr, `${step.step}: stderr`).toContain(s);
    for (const [name, pattern] of Object.entries(step.capture ?? {})) {
      const match = new RegExp(pattern).exec(output);
      expect(match, `${step.step}: capture ${name}`).not.toBeNull();
      vars[name] = match![1]!;
    }
    await assertEffects(root, step.step, step.effects ?? [], before);
  }
}

function interpolate<T>(value: T, vars: Record<string, string>): T {
  const text = JSON.stringify(value).replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`Unknown capture variable: ${name}`);
    return vars[name]!.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  });
  return JSON.parse(text) as T;
}

async function matching(root: string, pattern: string): Promise<string[]> {
  if (!/[?*\[]/.test(pattern)) {
    const path = isAbsolute(pattern) ? pattern : join(root, pattern);
    try { await stat(path); return [path]; } catch { return []; }
  }
  return [...new Bun.Glob(pattern.replaceAll('\\', '/')).scanSync({ cwd: root, absolute: true, dot: true })].sort();
}

async function snapshotUnchanged(root: string, effects: Effect[]) {
  const snapshots = new Map<string, Map<string, unknown>>();
  for (const effect of effects.filter((e) => e.unchanged)) {
    const paths = await matching(root, effect.path);
    if (paths.length !== 1) continue;
    const json = JSON.parse(await readFile(paths[0]!, 'utf8'));
    snapshots.set(effect.path, new Map(effect.unchanged!.map((pointer) => [pointer, atPointer(json, pointer)])));
  }
  return snapshots;
}

async function assertEffects(root: string, step: string, effects: Effect[], before: Map<string, Map<string, unknown>>) {
  for (const effect of effects) {
    let paths = await matching(root, effect.path);
    if (effect.absent) { expect(paths, `${step}: ${effect.path} absent`).toHaveLength(0); continue; }
    if (effect.glob_count !== undefined) { expect(paths, `${step}: ${effect.path} count`).toHaveLength(effect.glob_count); continue; }
    expect(paths.length, `${step}: ${effect.path} exists`).toBeGreaterThan(0);
    if (effect.find) paths = await selectByMetadata(paths, effect.find);
    expect(paths.length, `${step}: ${effect.path} find`).toBeGreaterThan(0);
    const path = paths[0]!;
    if (effect.text) {
      const text = await readFile(path, 'utf8');
      for (const value of effect.text) expect(text, `${step}: ${effect.path} text`).toContain(value);
    }
    if (effect.json !== undefined || effect.unchanged || effect.json_array_length !== undefined) {
      const json = JSON.parse(await readFile(path, 'utf8'));
      if (effect.json !== undefined) expectSubset(json, effect.json, `${step}: ${effect.path}`);
      for (const pointer of effect.unchanged ?? []) expect(atPointer(json, pointer)).toEqual(before.get(effect.path)?.get(pointer));
      if (effect.json_array_length !== undefined) expect(atPointer(json, effect.json_pointer ?? '')).toHaveLength(effect.json_array_length);
    }
  }
}

async function selectByMetadata(paths: string[], wanted: Record<string, unknown>) {
  const selected: string[] = [];
  for (const path of paths) {
    const raw = await readFile(path, 'utf8');
    let metadata: unknown;
    if (path.endsWith('.json')) metadata = JSON.parse(raw);
    else {
      metadata = {};
      const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? '';
      for (const line of header.split(/\r?\n/)) {
        const match = /^(\w+):\s*(.*)$/.exec(line);
        if (match) (metadata as Record<string, string>)[match[1]!] = match[2]!;
      }
    }
    try { expectSubset(metadata, wanted, path); selected.push(path); } catch { /* not this record */ }
  }
  return selected;
}

function expectSubset(actual: unknown, wanted: unknown, label: string): void {
  if (Array.isArray(wanted)) {
    expect(Array.isArray(actual), label).toBeTrue();
    expect((actual as unknown[]).length, label).toBe(wanted.length);
    wanted.forEach((value, index) => expectSubset((actual as unknown[])[index], value, `${label}/${index}`));
  } else if (wanted !== null && typeof wanted === 'object') {
    expect(actual !== null && typeof actual === 'object', label).toBeTrue();
    for (const [key, value] of Object.entries(wanted)) expectSubset((actual as Record<string, unknown>)[key], value, `${label}/${key}`);
  } else expect(actual, label).toEqual(wanted);
}

function atPointer(value: unknown, pointer: string): unknown {
  if (!pointer) return value;
  return pointer.split('/').slice(1).reduce<unknown>((current, token) =>
    (current as Record<string, unknown>)[token.replaceAll('~1', '/').replaceAll('~0', '~')], value);
}
