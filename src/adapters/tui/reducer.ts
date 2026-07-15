import type { LivenessDto, ObserverSnapshotDto } from '@app/ports/gateway.ts';
import { navigators, openGrants } from '@core/queries.ts';
import type { SessionState } from '@core/types.ts';
import type { WatchActivity, WatchEvent, WatchStep, WatchTuiState } from './events.ts';
import type { AgentPresence, TranscriptEntry, WatchViewModel } from './viewmodel.ts';

const LOST_NOTICE = 'broker connection lost — reattaching…';
const REATTACH_NOTICE = 'broker unreachable — waiting for it to return (agents respawn it on their next command)';
const GAP_NOTICE = 'observer stream gap — reattaching for a fresh snapshot…';

export function reduceWatch(state: WatchTuiState, event: WatchEvent): WatchStep {
  switch (event.kind) {
    case 'attach':
      return attach(state, event.snapshot, event.endpoint, event.now);
    case 'replace-model': {
      const next: WatchTuiState = {
        ...state,
        model: event.model,
        now: event.model.now,
        connection: 'connected',
        headSeq: event.model.source.kind === 'broker' ? event.model.source.headSeq : 0,
        entries: new Map(),
        liveness: undefined,
      };
      return step(next, event.model.session.status === 'active' ? ['render'] : ['render', 'exit']);
    }
    case 'activity':
      return activity(state, event.activity);
    case 'presence':
      return presence(state, event.liveness);
    case 'resize': {
      if (event.width === state.width) return step(state);
      const next = { ...state, width: event.width };
      return step(next, state.model ? ['render'] : []);
    }
    case 'tick': {
      if (event.now === state.now) return step(state);
      const model = state.model ? { ...state.model, now: event.now } : undefined;
      const next = { ...state, now: event.now, model };
      return step(next, model && hasDynamicAges(model) ? ['render'] : []);
    }
    case 'connection':
      return connection(state, event.state);
    case 'key':
      return step(state, ['exit']);
  }
}

function attach(state: WatchTuiState, snapshot: ObserverSnapshotDto, endpoint: string, now: string): WatchStep {
  const entries = new Map<string, TranscriptEntry>();
  for (const entry of snapshot.transcript) entries.set(deliveryId(entry), entry);
  const model = brokerModel({
    snapshot,
    endpoint,
    now,
    entries,
    liveness: snapshot.liveness,
    connected: true,
    notices: [],
  });
  const next: WatchTuiState = {
    ...state,
    model,
    now,
    connection: 'connected',
    headSeq: snapshot.seq,
    entries,
    liveness: snapshot.liveness,
  };
  return step(next, snapshot.session.status === 'active' ? ['render'] : ['render', 'exit']);
}

function activity(state: WatchTuiState, value: WatchActivity): WatchStep {
  if (!isBroker(state)) return step(state, ['reattach']);
  if (value.seq <= state.headSeq) return step(state);
  if (value.seq > state.headSeq + 1) {
    const model = disconnectedModel(state.model, GAP_NOTICE);
    return step({ ...state, model, connection: 'reattaching' }, ['render', 'reattach']);
  }

  const entries = new Map(state.entries);
  for (const entry of value.entries) entries.set(entry.deliveryId, { message: entry.message, pending: true });
  for (const id of value.ackedDeliveryIds) {
    const entry = entries.get(id);
    if (entry) entries.set(id, { ...entry, pending: false });
  }
  for (const id of value.voidedDeliveryIds) {
    const entry = entries.get(id);
    if (entry) entries.set(id, { ...entry, pending: false, voided: true });
  }
  const model = rebuildBrokerModel(state.model, value.session, value.seq, entries, state.liveness, state.now);
  const next = { ...state, model, headSeq: value.seq, entries };
  return step(next, value.session.status === 'active' ? ['render'] : ['render', 'exit']);
}

function presence(state: WatchTuiState, liveness: LivenessDto): WatchStep {
  if (!isBroker(state)) return step(state);
  const source = state.model.source;
  const model: WatchViewModel = {
    ...state.model,
    source: {
      ...source,
      ...(liveness.broker?.heartbeatAt === undefined ? {} : { heartbeatAt: liveness.broker.heartbeatAt }),
    },
    presence: presenceFrom(state.model.session, liveness, [...state.entries.values()]),
  };
  return step({ ...state, model, liveness }, ['render']);
}

function connection(state: WatchTuiState, connectionState: 'lost' | 'reattaching'): WatchStep {
  if (!isBroker(state)) return step(state);
  const notice = connectionState === 'lost' ? LOST_NOTICE : REATTACH_NOTICE;
  const model = disconnectedModel(state.model, notice);
  const next = { ...state, model, connection: connectionState };
  const effects = connectionState === 'lost' ? (['render', 'reattach'] as const) : (['render'] as const);
  return step(next, effects);
}

function brokerModel(input: {
  snapshot: ObserverSnapshotDto;
  endpoint: string;
  now: string;
  entries: ReadonlyMap<string, TranscriptEntry>;
  liveness: LivenessDto;
  connected: boolean;
  notices: readonly string[];
}): WatchViewModel {
  const { snapshot } = input;
  const transcript = [...input.entries.values()];
  return {
    source: {
      kind: 'broker',
      pid: snapshot.broker.pid,
      epoch: snapshot.broker.epoch,
      endpoint: input.endpoint,
      headSeq: snapshot.seq,
      heartbeatAt: snapshot.broker.heartbeatAt,
      connected: input.connected,
    },
    session: snapshot.session,
    navigators: navigators(snapshot.session),
    openGrants: openGrants(snapshot.session),
    transcript,
    presence: presenceFrom(snapshot.session, input.liveness, transcript),
    now: input.now,
    notices: input.notices,
  };
}

function rebuildBrokerModel(
  previous: WatchViewModel,
  session: SessionState,
  headSeq: number,
  entries: ReadonlyMap<string, TranscriptEntry>,
  liveness: LivenessDto | undefined,
  now: string,
): WatchViewModel {
  const transcript = [...entries.values()];
  const source = previous.source;
  if (source.kind !== 'broker') return previous;
  return {
    ...previous,
    source: { ...source, headSeq, connected: true },
    session,
    navigators: navigators(session),
    openGrants: openGrants(session),
    transcript,
    presence: presenceFrom(session, liveness, transcript),
    now,
    notices: [],
  };
}

function presenceFrom(
  session: SessionState,
  liveness: LivenessDto | undefined,
  transcript: readonly TranscriptEntry[],
): AgentPresence[] {
  return session.agents.map((agent) => {
    const pending = transcript.filter((entry) => entry.pending && !entry.voided && entry.message.header.to === agent);
    const live = liveness?.agents[agent];
    const listener: AgentPresence['listener'] = liveness === undefined
      ? { state: 'unknown' }
      : live?.connectedSince
        ? { state: 'live', connectedSince: live.connectedSince, lastActivity: live.lastActivity ?? live.connectedSince }
        : { state: 'none' };
    return {
      agent,
      listener,
      pendingCount: pending.length,
      ...(pending.length ? { oldestPendingSent: oldestSent(pending) } : {}),
    };
  });
}

function oldestSent(entries: readonly TranscriptEntry[]): string {
  return entries.reduce(
    (oldest, entry) => entry.message.header.sent < oldest ? entry.message.header.sent : oldest,
    entries[0]!.message.header.sent,
  );
}

function disconnectedModel(model: WatchViewModel, notice: string): WatchViewModel {
  if (model.source.kind !== 'broker') return model;
  return { ...model, source: { ...model.source, connected: false }, notices: [notice] };
}

function hasDynamicAges(model: WatchViewModel): boolean {
  return model.presence.some((presence) =>
    presence.listener.state === 'live' || presence.oldestPendingSent !== undefined,
  );
}

function isBroker(state: WatchTuiState): state is WatchTuiState & { model: WatchViewModel & { source: { kind: 'broker' } } } {
  return state.model?.source.kind === 'broker';
}

function deliveryId(entry: TranscriptEntry): string {
  return `${entry.message.header.id}:${entry.message.header.to}`;
}

function step(state: WatchTuiState, effects: WatchStep['effects'] = []): WatchStep {
  return { state, effects };
}
