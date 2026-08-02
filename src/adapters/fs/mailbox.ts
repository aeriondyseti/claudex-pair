import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PairMessage } from './types.ts';

export function messageFilename(message: PairMessage): string {
  return `${message.id}-${message.from}-${message.type}.md`;
}

export function serializeMessage(m: PairMessage): string {
  return ['---', `id: ${m.id}`, `from: ${m.from}`, `to: ${m.to}`, `type: ${m.type}`, `turn: ${m.turn}`, `sent: ${m.sent}`, ...(m.replyTo === undefined ? [] : [`reply_to: ${m.replyTo}`]), ...(m.sessionId === undefined ? [] : [`session_id: ${m.sessionId}`]), ...(m.reviewScope === undefined ? [] : [`review_scope: ${m.reviewScope}`]), ...(m.reviewAsync === undefined ? [] : ['review: async']), ...(m.lapseAt === undefined ? [] : [`lapse_at: ${m.lapseAt}`]), ...(m.severity === undefined ? [] : [`severity: ${m.severity}`]), '---', '', m.body, ''].join('\n');
}

export function parseMessage(raw: string): PairMessage {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error('Malformed pair message: missing header');
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(\w+):\s*(.*)$/.exec(line);
    if (field) meta[field[1]!] = field[2]!;
  }
  for (const key of ['id', 'from', 'to', 'type', 'turn', 'sent']) if (!meta[key]) throw new Error(`Malformed pair message: missing ${key}`);
  const body = match[2]!.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  return { id: meta.id!, from: meta.from!, to: meta.to!, type: meta.type! as PairMessage['type'], turn: meta.turn! as PairMessage['turn'], sent: meta.sent!, ...(meta.reply_to === undefined ? {} : { replyTo: meta.reply_to }), ...(meta.session_id === undefined ? {} : { sessionId: meta.session_id }), ...(meta.review_scope === undefined ? {} : { reviewScope: meta.review_scope }), ...(meta.review === 'async' ? { reviewAsync: true as const } : {}), ...(meta.lapse_at === undefined ? {} : { lapseAt: meta.lapse_at }), ...(meta.severity === undefined ? {} : { severity: meta.severity as NonNullable<PairMessage['severity']> }), body };
}

export class FsMailbox {
  readonly pairDir: string;
  constructor(readonly root: string) { this.pairDir = join(root, '.pair'); }

  async publish(message: PairMessage): Promise<string> {
    const name = messageFilename(message);
    const inbox = join(this.pairDir, 'inbox', message.to);
    await mkdir(inbox, { recursive: true });
    const temp = join(this.pairDir, `${name}.tmp`);
    await writeFile(temp, serializeMessage(message), 'utf8');
    await rename(temp, join(inbox, name));
    return name;
  }

  async pending(agent: string): Promise<Array<{ name: string; message: PairMessage }>> {
    const inbox = join(this.pairDir, 'inbox', agent);
    let names: string[];
    try { names = (await readdir(inbox)).filter((n) => n.endsWith('.md')).sort(); }
    catch { return []; }
    const out = [];
    for (const name of names) out.push({ name, message: parseMessage(await readFile(join(inbox, name), 'utf8')) });
    return out;
  }

  async archived(last?: number): Promise<Array<{ name: string; message: PairMessage }>> {
    const archive = join(this.pairDir, 'archive');
    let names: string[];
    try { names = (await readdir(archive)).filter((n) => n.endsWith('.md')).sort(); }
    catch { return []; }
    if (last !== undefined) names = names.slice(-last);
    const out = [];
    for (const name of names) out.push({ name, message: parseMessage(await readFile(join(archive, name), 'utf8')) });
    return out;
  }

  async claimAll(agent: string): Promise<Array<{ name: string; message: PairMessage }>> {
    const inbox = join(this.pairDir, 'inbox', agent);
    const archive = join(this.pairDir, 'archive');
    await mkdir(archive, { recursive: true });
    const names = (await readdir(inbox)).filter((name) => name.endsWith('.md')).sort();
    const claimed = [];
    for (const name of names) {
      const source = join(inbox, name);
      const raw = await readFile(source, 'utf8');
      await rename(source, join(archive, name));
      claimed.push({ name, message: parseMessage(raw) });
    }
    return claimed;
  }
}
