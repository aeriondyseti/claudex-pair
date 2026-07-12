import type { CommandEnvelope } from '@core/commands.ts';
import type { Event } from '@core/events.ts';
import type { Grant, SessionState } from '@core/types.ts';
import { navigators } from '@core/queries.ts';
import type { CommitReceipt, Deps, Mailbox, ProtocolStore, StoredMessage } from '@app/ports/index.ts';
import { FsGrantStore, FsMailbox, FsSessionStore, fromDiskGrant, serializeMessage, toDiskGrant, type DiskSession, type PairMessage } from '@adapters/fs/index.ts';
import { systemClock, systemIds } from '@adapters/clock/index.ts';

/**
 * Composition root: binds the fs adapter to the app ports. Event application
 * order preserves legacy pair.ps1 semantics — mailbox writes first, session
 * state saved last (the P0 broker replaces this whole file, not the core).
 */

export function bindFsDeps(root: string): Deps {
  const sessions = new FsSessionStore(root);
  const mailboxFs = new FsMailbox(root);
  const grants = new FsGrantStore(root);

  const load = async (): Promise<SessionState | undefined> => {
    let disk: DiskSession;
    try {
      disk = await sessions.load();
    } catch {
      return undefined;
    }
    const grantList = await grants.list();
    const grantMap: Record<string, Grant> = {};
    for (const g of grantList) grantMap[g.id] = fromDiskGrant(g);
    return {
      task: disk.task,
      agents: disk.agents,
      driver: disk.driver,
      turn: disk.turn,
      status: disk.status,
      started: disk.started,
      grants: grantMap,
    };
  };

  const applyEvents = async (
    envelope: CommandEnvelope,
    events: readonly Event[],
    session: DiskSession,
  ): Promise<CommitReceipt> => {
    const messageFiles: string[] = [];
    let sessionDirty = false;
    for (const event of events) {
      switch (event.kind) {
        case 'message-sent': {
          const name = await mailboxFs.publish({
            id: event.id, from: event.from, to: event.to,
            type: event.type, turn: event.turn, sent: event.at, body: event.body,
          });
          messageFiles.push(name);
          break;
        }
        case 'turn-passed':
          session.turn = event.to;
          sessionDirty = true;
          break;
        case 'driver-changed':
          session.driver = event.driver;
          session.navigators = session.agents.filter((a) => a !== event.driver);
          sessionDirty = true;
          break;
        case 'session-ended':
          session.status = 'completed';
          sessionDirty = true;
          break;
        case 'grant-issued':
          await grants.create(toDiskGrant({
            id: event.grantId, issuer: event.issuer, assignee: event.assignee,
            task: event.task, scope: event.scope, state: 'offered',
            agreedIn: event.agreedIn, result: '', revision: 0,
            created: event.at, updated: event.at,
          }));
          break;
        case 'grant-accepted':
          await grants.transition(event.grantId, ['offered'], (g) => ({ ...g, state: 'active' }), event.at);
          break;
        case 'grant-completed':
          await grants.transition(event.grantId, ['active'], (g) => ({ ...g, state: 'done', result: event.result }), event.at);
          break;
        case 'grant-cancelled':
          await grants.transition(event.grantId, ['offered', 'active'], (g) => ({ ...g, state: 'cancelled', result: event.reason || g.result }), event.at);
          break;
        case 'session-initialized':
          break; // handled by initialize()
      }
    }
    if (sessionDirty) await sessions.save(session);
    return { messageFiles };
  };

  const store: ProtocolStore = {
    load,
    async initialize(_envelope, events) {
      const init = events.find((e) => e.kind === 'session-initialized');
      if (!init || init.kind !== 'session-initialized') throw new Error('initialize called without session-initialized event');
      const disk: DiskSession = {
        task: init.task,
        agents: [...init.agents],
        driver: init.driver,
        navigators: init.agents.filter((a) => a !== init.driver),
        turn: init.driver,
        status: 'active',
        started: init.at,
      };
      await sessions.initialize(disk);
    },
    async commit(envelope, events) {
      const disk = await sessions.load();
      return applyEvents(envelope, events, disk);
    },
  };

  const toStored = (entry: { name: string; message: PairMessage }): StoredMessage => ({
    name: entry.name,
    header: {
      id: entry.message.id, from: entry.message.from, to: entry.message.to,
      type: entry.message.type, turn: entry.message.turn, sent: entry.message.sent,
    },
    body: entry.message.body,
    raw: serializeMessage(entry.message),
  });

  const mailbox: Mailbox = {
    pending: async (agent) => (await mailboxFs.pending(agent)).map(toStored),
    claim: async (agent) => (await mailboxFs.claimAll(agent)).map(toStored),
    archived: async (last) => (await mailboxFs.archived(last)).map(toStored),
  };

  return { store, mailbox, clock: systemClock, ids: systemIds };
}

export { navigators };
