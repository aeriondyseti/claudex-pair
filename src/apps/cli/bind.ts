import type { CommandEnvelope } from '@core/commands.ts';
import type { Event } from '@core/events.ts';
import type { Grant, Registry, SessionState } from '@core/types.ts';
import { applyRegistryUpdate, replay } from '@core/evolve.ts';
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
    if (disk.topology === 'peer') throw new Error('Peer sessions require the broker (agent-attach identity); the fs path cannot host one.');
    return {
      topology: 'pair',
      task: disk.task,
      agents: disk.agents,
      // Legacy pair session.json always carries these.
      driver: disk.driver!,
      turn: disk.turn!,
      status: disk.status,
      started: disk.started,
      grants: grantMap,
      ...(disk.sessionId === undefined ? {} : { sessionId: disk.sessionId }),
      // M1 legacy tolerance: fs sessions without a registry synthesize v0.
      registry: disk.registry ?? synthesizeRegistry(disk),
    };
  };

  // Grants-lite invariant: re-verify the session is still active while
  // holding the per-grant lock (an end can commit in between).
  const activeGuard = async (): Promise<void> => {
    const s = await sessions.load();
    if (s.status !== 'active') {
      throw new Error(`Session status is '${s.status}' — grant operations require an active session.`);
    }
  };

  const applyEvents = async (
    envelope: CommandEnvelope,
    events: readonly Event[],
    session: DiskSession,
  ): Promise<CommitReceipt> => {
    const messageFiles: string[] = [];
    const removed = new Set<string>();
    let sessionDirty = false;
    for (const event of events) {
      switch (event.kind) {
        case 'message-sent': {
          const name = await mailboxFs.publish({
            id: event.id, from: event.from, to: event.to,
            type: event.type, turn: event.turn, sent: event.at, body: event.body,
            ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
            ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
          });
          messageFiles.push(name);
          // Removed agents have no live inbox. Keep their notice durable in
          // the archive, but never let it become stale mail after a rejoin.
          if (removed.has(event.to)) await mailboxFs.claimAll(event.to);
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
        case 'turn-revoked':
          break; // provenance only; paired turn-passed mutates the session
        case 'agent-left':
        case 'agent-kicked':
          session.agents = session.agents.filter((a) => a !== event.agent);
          session.navigators = (session.navigators ?? []).filter((a) => a !== event.agent);
          removed.add(event.agent);
          await mailboxFs.claimAll(event.agent);
          sessionDirty = true;
          break;
        case 'agent-joined':
          session.agents = [...session.agents, event.agent];
          session.navigators = session.agents.filter((a) => a !== session.driver);
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
          await grants.transition(event.grantId, ['offered'], (g) => ({ ...g, state: 'active' }), event.at, activeGuard);
          break;
        case 'grant-completed':
          await grants.transition(event.grantId, ['active'], (g) => ({ ...g, state: 'done', result: event.result }), event.at, activeGuard);
          break;
        case 'grant-cancelled':
          await grants.transition(event.grantId, ['offered', 'active'], (g) => ({ ...g, state: 'cancelled', result: event.reason || g.result }), event.at, activeGuard);
          break;
        case 'registry-updated':
          // M1: fs mode persists the canonical transition — without this,
          // explicit-fs sessions lose version/history on every reload.
          session.registry = applyRegistryUpdate(session.registry ?? synthesizeRegistry(session), event);
          sessionDirty = true;
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
      // Replay the full init event list so the registry (v0 declaration +
      // the canonical registry-updated transition) and sessionId land in
      // the mirror exactly as the core computed them.
      const initState = replay([...events]);
      const disk: DiskSession = {
        task: init.task,
        agents: [...init.agents],
        driver: init.driver,
        navigators: init.agents.filter((a) => a !== init.driver),
        turn: init.driver,
        status: 'active',
        started: init.at,
        ...(initState?.sessionId === undefined ? {} : { sessionId: initState.sessionId }),
        ...(initState?.registry === undefined ? {} : { registry: initState.registry }),
      };
      return sessions.initialize(disk);
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
      ...(entry.message.replyTo === undefined ? {} : { replyTo: entry.message.replyTo }),
      ...(entry.message.sessionId === undefined ? {} : { sessionId: entry.message.sessionId }),
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


/** M1 legacy tolerance: v0 registry from the live roster. */
function synthesizeRegistry(disk: { agents: readonly string[]; started: string }): Registry {
  return {
    version: 0,
    agents: Object.fromEntries(disk.agents.map((a) => [a, { id: a, display: a, status: 'active' as const, joinedAt: disk.started }])),
  };
}

export { navigators };
