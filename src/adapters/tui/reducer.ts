import type { LivenessDto, ObserverSnapshotDto } from '@app/ports/gateway.ts';
import { navigators, openGrants } from '@core/queries.ts';
import type { SessionState } from '@core/types.ts';
import type { ComposerState, UserActionDraft, WatchActivity, WatchEffect, WatchEvent, WatchStep, WatchTuiState } from './events.ts';
import { visibleTranscriptCount } from './watch.ts';
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
        // A filesystem projection is permanently read-only, regardless of
        // any composer state retained from a previous broker attachment.
        composer: event.model.source.kind === 'broker' ? state.composer : undefined,
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
      return key(state, event);
    case 'text':
      return text(state, event.text);
    case 'submit-result':
      return submitResult(state, event);
    case 'user-channel':
      return userChannel(state, event.state, event.detail);
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
    composer: normalizeComposer(state.composer, snapshot.session.agents, entries, state.tail),
  };
  const effects: readonly WatchEffect[] = snapshot.session.status === 'active' ? ['render'] : ['render', 'exit'];
  // Apply a deferred pre-attach user-channel event (close-out #2): the model
  // is broker-sourced now, so the stash gains composer authority here — and
  // only here. Attach's own effects win (render / render+exit ordering).
  if (state.pendingChannel) {
    const deferred = userChannel({ ...next, pendingChannel: undefined }, state.pendingChannel.channel, state.pendingChannel.detail);
    return step(deferred.state, effects);
  }
  return step(next, effects);
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
  const composer = activityComposer(state, entries, value.session.agents);
  const next = { ...state, model, headSeq: value.seq, entries, composer };
  return step(next, value.session.status === 'active' ? ['render'] : ['render', 'exit']);
}

function text(state: WatchTuiState, value: string): WatchStep {
  const composer = state.composer;
  if (composer?.channel !== 'registered' || value.length === 0) return step(state);
  // Editing clears the transient action hint; a frozen CONFIRM survives
  // typing (the immutable draft executes regardless of buffer edits —
  // freeze-then-mint, design REV 6) until Esc or the second Enter.
  const { actionHint: _hint, ...rest } = composer;
  return rendered(state, { ...rest, buffer: composer.buffer + value });
}

/** Slice 4: parse a leading-/ line into a frozen normalized action.
 * Returns undefined for advisory text (including the //-escape). */
function parseActionDraft(buffer: string): { draft?: UserActionDraft & { display: string }; hint?: string } {
  const line = buffer.trim();
  if (!line.startsWith('/') || line.startsWith('//')) return {};
  const [head = '', ...restParts] = line.slice(1).split(/\s+/);
  const rest = restParts.join(' ');
  const verb = head.toLowerCase();
  if (verb === 'end') return { draft: { verb: 'end', summary: rest, display: `/end ${rest || '(default summary)'}`.trim() } };
  if (verb === 'resume') return { draft: { verb: 'resume', display: '/resume' } };
  if (verb === 'pause') return { draft: { verb: 'pause', reason: rest, display: `/pause ${rest}`.trim() } };
  if (verb === 'cancel-grant') {
    const [grantId = '', ...reasonParts] = restParts;
    if (!grantId) return { hint: 'usage: /cancel-grant <grantId> [reason]' };
    return { draft: { verb: 'cancel-grant', grantId, reason: reasonParts.join(' '), display: `/cancel-grant ${grantId}` } };
  }
  if (verb === 'kick') {
    const [agent = '', ...reasonParts] = restParts;
    if (!agent) return { hint: 'usage: /kick <agent> [reason]' };
    return { draft: { verb: 'kick', agent, reason: reasonParts.join(' '), display: `/kick ${agent}` } };
  }
  return { hint: `unknown action '/${verb}' — actions: /end /cancel-grant /kick /pause /resume; send a literal /${verb} with //${verb}` };
}

function key(state: WatchTuiState, event: Extract<WatchEvent, { kind: 'key' }>): WatchStep {
  if (event.key === 'quit') return step(state, ['exit']);
  const composer = state.composer;
  if (!composer) return step(state);

  if (event.key === 'filter') {
    return rendered(state, { ...composer, filter: nextFilter(composer.filter), scrollOffset: 0 });
  }
  if (event.key === 'page-up') {
    const maximum = maxScrollOffset(state, composer.filter);
    const scrollOffset = Math.min(maximum, composer.scrollOffset + Math.max(1, state.tail));
    return scrollOffset === composer.scrollOffset ? step(state) : rendered(state, { ...composer, scrollOffset });
  }
  if (event.key === 'page-down') {
    const scrollOffset = Math.max(0, composer.scrollOffset - Math.max(1, state.tail));
    return scrollOffset === composer.scrollOffset ? step(state) : rendered(state, { ...composer, scrollOffset });
  }
  if (event.key === 'end') {
    return composer.scrollOffset === 0 ? step(state) : rendered(state, { ...composer, scrollOffset: 0 });
  }
  if (event.key === 'escape') {
    // Slice 4: Esc on a frozen CONFIRM aborts back to the editable draft
    // (buffer preserved); with a failed action it also discards the pending.
    if (composer.confirming && composer.pending?.state !== 'sending') {
      const { confirming: _c, ...rest } = composer.pending?.state === 'error' ? clearPending(composer) : composer;
      return rendered(state, rest);
    }
    if (!composer.buffer && composer.pending?.state !== 'error' && !composer.actionHint) return step(state);
    const cleared = composer.pending?.state === 'error' ? clearPending(composer) : composer;
    const { actionHint: _h, ...rest } = cleared;
    return rendered(state, { ...rest, buffer: '' });
  }
  if (composer.channel !== 'registered') return step(state);
  if (event.key === 'backspace') {
    const characters = [...composer.buffer];
    if (!characters.length) return step(state);
    return rendered(state, { ...composer, buffer: characters.slice(0, -1).join('') });
  }
  if (event.key === 'tab') {
    return rendered(state, { ...composer, target: nextTarget(composer.target, state.model?.session.agents ?? []) });
  }
  if (event.key === 'submit') return submit(state, composer, event.reqId);
  return step(state);
}

function submit(state: WatchTuiState, composer: ComposerState, candidateReqId: string): WatchStep {
  if (composer.pending?.state === 'sending') return step(state);
  if (composer.pending?.state === 'error') {
    // The host allocates a candidate for every Enter, but a visible retry
    // MUST retain the immutable identity and payload of the failed attempt.
    const pending = sendingPending(composer.pending);
    if (pending.action) {
      // A failed ACTION retry re-emits the action effect with the SAME reqId.
      const frozen = state.composer?.confirming;
      if (!frozen) return step(state); // aborted meanwhile — nothing to retry
      const { display: _d, ...draft } = frozen;
      return step({ ...state, composer: { ...composer, pending } }, ['render', { kind: 'action', reqId: pending.reqId, action: draft as UserActionDraft, display: frozen.display }]);
    }
    return withSubmitEffect(state, { ...composer, pending }, pending);
  }
  // Slice 4 freeze-then-mint: SECOND Enter on a frozen CONFIRM executes —
  // reqId minted NOW (this event's candidate), reused verbatim on retries.
  if (composer.confirming) {
    const frozen = composer.confirming;
    const { display: _display, ...draft } = frozen;
    const pending = { reqId: candidateReqId, target: '*' as const, body: frozen.display, state: 'sending' as const, action: true as const };
    return step(
      { ...state, composer: { ...composer, pending } },
      ['render', { kind: 'action', reqId: candidateReqId, action: draft as UserActionDraft, display: frozen.display }],
    );
  }
  if (!composer.buffer.trim()) return step(state);
  // Slice 4: FIRST Enter on a /-draft freezes the immutable normalized
  // action and enters CONFIRM — no effect, no reqId (design REV 6).
  const parsed = parseActionDraft(composer.buffer);
  if (parsed.hint) return rendered(state, { ...composer, actionHint: parsed.hint });
  if (parsed.draft) {
    const { actionHint: _hint, ...rest } = composer;
    return rendered(state, { ...rest, confirming: parsed.draft });
  }
  // The //-escape sends the literal /-prefixed advisory body (ruling Q3).
  const body = composer.buffer.trim().startsWith('//') ? composer.buffer.replace('//', '/') : composer.buffer;
  const pending = {
    reqId: candidateReqId,
    target: composer.target,
    body,
    state: 'sending' as const,
  };
  return withSubmitEffect(state, { ...composer, buffer: '', pending }, pending);
}

function withSubmitEffect(
  state: WatchTuiState,
  composer: ComposerState,
  pending: NonNullable<ComposerState['pending']>,
): WatchStep {
  const effect: Extract<WatchEffect, { kind: 'submit' }> = {
    kind: 'submit', reqId: pending.reqId, target: pending.target, body: pending.body,
  };
  return step({ ...state, composer }, ['render', effect]);
}

function submitResult(state: WatchTuiState, event: Extract<WatchEvent, { kind: 'submit-result' }>): WatchStep {
  const composer = state.composer;
  if (!composer?.pending || composer.pending.reqId !== event.reqId) return step(state);
  // A successful wire result is not the source of truth: pending is cleared
  // only when committed observer activity with groupId === reqId arrives.
  if (event.ok) return step(state);
  const pending = {
    ...composer.pending,
    state: 'error' as const,
    error: event.error ?? 'send failed',
  };
  return rendered(state, { ...composer, pending });
}

function userChannel(
  state: WatchTuiState,
  channel: Extract<WatchEvent, { kind: 'user-channel' }>['state'],
  detail?: string,
): WatchStep {
  if (channel === 'unavailable') {
    if (!state.composer && !state.pendingChannel) return step(state);
    return step({ ...state, composer: undefined, pendingChannel: undefined }, state.model && state.composer ? ['render'] : []);
  }
  // Defense in depth: fs diagnostic projections can never acquire input
  // authority — but the event is DEFERRED, not dropped (close-out #2): the
  // stash is inert until a broker attach applies the latest deferred state.
  if (!isBroker(state)) {
    return step({ ...state, pendingChannel: { channel, ...(detail === undefined ? {} : { detail }) } });
  }
  const previous = state.composer;
  const composer: ComposerState = {
    channel,
    ...(detail === undefined ? {} : { channelDetail: detail }),
    buffer: previous?.buffer ?? '',
    target: validTarget(previous?.target, state.model.session.agents),
    scrollOffset: previous?.scrollOffset ?? 0,
    filter: previous?.filter ?? 'all',
    ...(previous?.pending === undefined ? {} : { pending: previous.pending }),
    // A registered/unregistered re-push during recovery must not orphan a
    // failed action's retry: the frozen draft survives the rebuild (codex
    // step-5 audit B).
    ...(previous?.confirming === undefined ? {} : { confirming: previous.confirming }),
    ...(previous?.actionHint === undefined ? {} : { actionHint: previous.actionHint }),
  };
  return rendered({ ...state, pendingChannel: undefined }, composer);
}

function activityComposer(
  state: WatchTuiState,
  entries: ReadonlyMap<string, TranscriptEntry>,
  agents: readonly string[],
): ComposerState | undefined {
  const previous = state.composer;
  if (!previous) return undefined;
  const before = visibleTranscriptCount([...state.entries.values()], previous.filter);
  const after = visibleTranscriptCount([...entries.values()], previous.filter);
  const added = Math.max(0, after - before);
  const scrollOffset = previous.scrollOffset > 0
    ? Math.min(maxScroll(after, state.tail), previous.scrollOffset + added)
    : 0;
  const committed = previous.pending && [...entries.values()].some((entry) => messageGroupId(entry) === previous.pending!.reqId);
  const next: ComposerState = {
    ...previous,
    target: validTarget(previous.target, agents),
    scrollOffset,
  };
  return committed ? clearPending(next) : next;
}

function normalizeComposer(
  composer: ComposerState | undefined,
  agents: readonly string[],
  entries: ReadonlyMap<string, TranscriptEntry>,
  tail: number,
): ComposerState | undefined {
  if (!composer) return undefined;
  const count = visibleTranscriptCount([...entries.values()], composer.filter);
  const committed = composer.pending && [...entries.values()].some((entry) => messageGroupId(entry) === composer.pending!.reqId);
  const next: ComposerState = {
    ...composer,
    target: validTarget(composer.target, agents),
    scrollOffset: Math.min(composer.scrollOffset, maxScroll(count, tail)),
  };
  return committed ? clearPending(next) : next;
}

function rendered(state: WatchTuiState, composer: ComposerState): WatchStep {
  return step({ ...state, composer }, state.model ? ['render'] : []);
}

function nextFilter(filter: ComposerState['filter']): ComposerState['filter'] {
  const filters: readonly ComposerState['filter'][] = ['all', 'dialogue', 'user', 'protocol'];
  return filters[(filters.indexOf(filter) + 1) % filters.length]!;
}

function nextTarget(current: ComposerState['target'], agents: readonly string[]): ComposerState['target'] {
  const targets = ['*', ...agents] as const;
  return targets[(targets.indexOf(current) + 1) % targets.length]!;
}

function validTarget(target: ComposerState['target'] | undefined, agents: readonly string[]): ComposerState['target'] {
  return target === '*' || (target !== undefined && agents.includes(target)) ? target : '*';
}

function maxScrollOffset(state: WatchTuiState, filter: ComposerState['filter']): number {
  return maxScroll(visibleTranscriptCount(state.model?.transcript ?? [], filter), state.tail);
}

function maxScroll(count: number, tail: number): number {
  return Math.max(0, count - Math.max(0, tail));
}

function messageGroupId(entry: TranscriptEntry): string | undefined {
  return (entry.message.header as typeof entry.message.header & { readonly groupId?: string }).groupId;
}

function clearPending(composer: ComposerState): ComposerState {
  // Also drops confirming/actionHint: a committed or discarded action's
  // frozen draft must not linger into the next interaction (slice 4).
  const { channel, channelDetail, buffer, target, scrollOffset, filter } = composer;
  return {
    channel,
    ...(channelDetail === undefined ? {} : { channelDetail }),
    buffer,
    target,
    scrollOffset,
    filter,
  };
}

function sendingPending(pending: NonNullable<ComposerState['pending']>): NonNullable<ComposerState['pending']> {
  return {
    reqId: pending.reqId,
    target: pending.target,
    body: pending.body,
    state: 'sending',
    // The action flag must survive the retry rebuild — dropping it turned
    // an action retry into a plain send (codex step-5 audit B).
    ...(pending.action === undefined ? {} : { action: pending.action }),
  };
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
