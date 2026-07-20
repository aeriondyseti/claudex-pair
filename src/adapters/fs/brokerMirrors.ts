import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Event } from '@core/events.ts';
import type { SessionState } from '@core/types.ts';
import type { StoredMessage } from '@app/ports/index.ts';
import { MirrorConflictError, type MirrorStore, type OpenDelivery } from '@broker/ports.ts';
import { FsGrantStore } from './grantStore.ts';
import { FsMailbox, serializeMessage, messageFilename } from './mailbox.ts';
import { FsSessionStore } from './sessionStore.ts';
import { toDiskGrant } from './types.ts';
import type { DiskSession, PairMessage } from './types.ts';

/**
 * Fs implementation of the broker's MirrorStore port: legacy `.pair/` files
 * as views of the journal, updated AFTER ack (BROKER-SPEC "Storage"). A
 * journaled delivery-ack is what moves a message from inbox/ to archive/.
 *
 * mirror-manifest.json: {mirroredSeq, files: {relpath: sha256}}. Recovery
 * rule (ordered): mirroredSeq < journal head → UNCONDITIONAL rebuild (a
 * crashed broker's partial mirror update is lag, never tamper — hashes not
 * consulted); divergence is only judged AT parity → MirrorConflictError.
 *
 * W2 scope note: hashes cover session.json + inbox/** + grants/**. archive/
 * is an append-only sink — post-compaction the journal no longer carries
 * every historical message body, so the archive is not rebuildable and is
 * excluded from tamper detection.
 */

type Manifest = { mirroredSeq: number; files: Record<string, string> };

export class FsMirrors implements MirrorStore {
  readonly pairDir: string;
  #sessions: FsSessionStore;
  #mailbox: FsMailbox;
  #grants: FsGrantStore;

  constructor(readonly root: string) {
    this.pairDir = join(root, '.pair');
    this.#sessions = new FsSessionStore(root);
    this.#mailbox = new FsMailbox(root);
    this.#grants = new FsGrantStore(root);
  }

  get manifestPath(): string {
    return join(this.pairDir, 'journal', 'mirror-manifest.json');
  }

  async readManifest(): Promise<Manifest | undefined> {
    try {
      return JSON.parse(await readFile(this.manifestPath, 'utf8')) as Manifest;
    } catch {
      return undefined;
    }
  }

  /** Init mirror, written inline pre-ack so gitignoreUpdated is truthful. */
  async applyInit(state: SessionState): Promise<{ gitignoreUpdated: boolean }> {
    return this.#sessions.initialize(toDiskSession(state));
  }

  /** Apply one committed txn's events to the mirror files (post-ack). */
  async applyEvents(state: SessionState, events: readonly Event[], seq: number): Promise<void> {
    for (const event of events) {
      switch (event.kind) {
        case 'session-initialized':
          break; // applyInit handled this inline
        case 'message-sent':
          await this.#mailbox.publish({
            id: event.id, from: event.from, to: event.to,
            type: event.type, turn: event.turn, sent: event.at, body: event.body,
          });
          break;
        case 'grant-issued':
        case 'grant-accepted':
        case 'grant-completed':
        case 'grant-cancelled':
          await this.#writeGrantAbsolute(event.grantId, state);
          break;
        case 'user-channel-registered':
          await this.#writeUserChannel(state);
          break;
        case 'turn-passed':
        case 'driver-changed':
        case 'session-ended':
        case 'turn-revoked':
        case 'agent-left':
        case 'agent-joined':
        case 'agent-kicked':
          break; // session.json is saved once below from post-commit state
      }
    }
    if (events.some((e) => e.kind !== 'message-sent' && e.kind !== 'session-initialized')) {
      await this.#sessions.save(toDiskSession(state));
    }
    await this.writeManifest(seq);
  }

  /**
   * Close-out #7: informational user-channel mirror. Human-readable state of
   * the session's user-channel binding — REGISTRATION ONLY, never the token
   * or its hash. Broker-written like every mirror, covered by the manifest
   * (hashMirrorFiles) so an external edit is tamper, and removed on rebuild
   * when the recovered state carries no binding.
   */
  async #writeUserChannel(state: SessionState): Promise<void> {
    const path = join(this.pairDir, 'user-channel.json');
    if (!state.userChannelTokenHash) {
      await rm(path, { force: true });
      return;
    }
    const content = {
      registered: true,
      note: 'Informational mirror; the broker journal is authoritative. The user credential is never stored in .pair.',
    };
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  }

  /** Broker is the single writer: mirror grants reflect post-commit state verbatim. */
  async #writeGrantAbsolute(grantId: string, state: SessionState): Promise<void> {
    const grant = state.grants[grantId];
    if (!grant) return;
    const disk = toDiskGrant(grant);
    const path = this.#grants.path(grantId);
    const tmp = `${path}.${process.pid}.tmp`;
    await mkdir(join(this.pairDir, 'grants'), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(disk, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  }

  /** The journaled ack consumes the delivery: move inbox mirror → archive. */
  async applyAck(delivery: OpenDelivery, seq: number): Promise<void> {
    const inboxDir = join(this.pairDir, 'inbox', delivery.message.to);
    const archiveDir = join(this.pairDir, 'archive');
    await mkdir(archiveDir, { recursive: true });
    let names: string[] = [];
    try {
      names = await readdir(inboxDir);
    } catch {
      /* inbox dir may not exist on a rebuilt mirror */
    }
    const name = names.find((n) => n.startsWith(delivery.message.id));
    if (name) await rename(join(inboxDir, name), join(archiveDir, name));
    await this.writeManifest(seq);
  }

  /**
   * Recovery reconcile (F8): behind-head → unconditional rebuild; at parity,
   * hash mismatch → conflict.
   */
  async reconcile(state: SessionState | undefined, openDeliveries: readonly OpenDelivery[], headSeq: number): Promise<'clean' | 'rebuilt'> {
    const manifest = await this.readManifest();
    if (!manifest || manifest.mirroredSeq < headSeq) {
      await this.rebuild(state, openDeliveries, headSeq);
      return 'rebuilt';
    }
    if (manifest.mirroredSeq > headSeq) {
      // Manifest ahead of the journal can only mean journal loss/rollback.
      throw new MirrorConflictError(`manifest at seq ${manifest.mirroredSeq}, journal head ${headSeq}`);
    }
    const current = await this.hashMirrorFiles();
    const diverged = Object.entries(manifest.files)
      .filter(([path, hash]) => current[path] !== hash)
      .map(([path]) => path);
    const added = Object.keys(current).filter((p) => !(p in manifest.files));
    if (diverged.length || added.length) {
      throw new MirrorConflictError([...diverged.map((p) => `changed: ${p}`), ...added.map((p) => `added: ${p}`)].join(', '));
    }
    return 'clean';
  }

  /** Full rebuild from journal state: session.json, grants, inbox (open deliveries). */
  async rebuild(state: SessionState | undefined, openDeliveries: readonly OpenDelivery[], headSeq: number): Promise<void> {
    if (state) {
      await mkdir(this.pairDir, { recursive: true });
      try {
        await this.#sessions.save(toDiskSession(state));
      } catch {
        await this.#sessions.initialize(toDiskSession(state));
      }
      for (const grant of Object.values(state.grants)) {
        await this.#writeGrantAbsolute(grant.id, state);
      }
      await this.#writeUserChannel(state); // recreate or REMOVE per recovered state
    }
    for (const agent of state?.agents ?? []) {
      const dir = join(this.pairDir, 'inbox', agent);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
    }
    for (const d of openDeliveries) {
      await this.#mailbox.publish({
        id: d.message.id, from: d.message.from, to: d.message.to,
        type: d.message.type, turn: d.message.turn, sent: d.message.at, body: d.message.body,
      });
    }
    await this.writeManifest(headSeq);
  }

  async archived(last?: number): Promise<readonly StoredMessage[]> {
    return (await this.#mailbox.archived(last)).map((a) => ({
      name: a.name,
      header: { id: a.message.id, from: a.message.from, to: a.message.to, type: a.message.type, turn: a.message.turn, sent: a.message.sent },
      body: a.message.body,
      raw: serializeMessage(a.message),
    }));
  }

  async writeManifest(seq: number): Promise<void> {
    const manifest: Manifest = { mirroredSeq: seq, files: await this.hashMirrorFiles() };
    const tmp = `${this.manifestPath}.${process.pid}.tmp`;
    await mkdir(join(this.pairDir, 'journal'), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(tmp, this.manifestPath);
  }

  async hashMirrorFiles(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const prefix = join(this.pairDir).replaceAll('\\', '/');
    const addFile = async (rel: string) => {
      try {
        files[rel] = createHash('sha256').update(await readFile(join(this.pairDir, rel))).digest('hex');
      } catch {
        /* absent files simply aren't listed */
      }
    };
    await addFile('session.json');
    await addFile('user-channel.json'); // close-out #7: covered = tamper-detectable
    for (const sub of ['inbox', 'grants']) {
      let entries: import('node:fs').Dirent[] = [];
      try {
        entries = await readdir(join(this.pairDir, sub), { withFileTypes: true, recursive: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const parent = entry.parentPath.replaceAll('\\', '/');
        await addFile(`${parent.slice(prefix.length + 1)}/${entry.name}`);
      }
    }
    return files;
  }
}

/** The fs adapter's message codec, injected into the broker core. */
export const fsMessageCodec = {
  filename: (m: { id: string; from: string; to: string; type: string; turn: string; sent: string; body: string }) => messageFilename(m as PairMessage),
  raw: (m: { id: string; from: string; to: string; type: string; turn: string; sent: string; body: string }) => serializeMessage(m as PairMessage),
};

function toDiskSession(state: SessionState): DiskSession {
  return {
    task: state.task,
    agents: [...state.agents],
    driver: state.driver,
    navigators: state.agents.filter((a) => a !== state.driver),
    turn: state.turn,
    status: state.status,
    started: state.started,
  };
}
