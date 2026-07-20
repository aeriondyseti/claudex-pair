import type { CommandEnvelope, Command, GrantScopeInput } from './commands.ts';
import type { Event, UserActionKind } from './events.ts';
import { ProtocolError } from './errors.ts';
import { MAX_AGENTS, MESSAGE_ID_PATTERN, MESSAGE_TYPES, AGENT_NAME_PATTERN, USER_IDENTITY, err, ok, type Grant, type GrantScope, type Result, type SessionState } from './types.ts';

/**
 * The protocol state machine. Pure, deterministic, total. Every invariant in
 * PROTOCOL.md lives here — never in an adapter, never in the CLI.
 *
 * `state` is undefined only for init-session (no session yet, or the caller
 * loaded a completed one and is re-initializing).
 */
export function decide(
  state: SessionState | undefined,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const { command, meta } = envelope;
  switch (command.kind) {
    case 'init-session':
      return decideInit(state, command, meta.principal, meta.at);
    case 'send-message':
      return withActive(state, (s) => decideSend(s, command, envelope));
    case 'end-session':
      return withActive(state, (s) => decideEnd(s, command, envelope));
    case 'issue-grant':
      return withActive(state, (s) => decideIssueGrant(s, command, envelope), GRANT_INACTIVE);
    case 'accept-grant':
      return withActive(state, (s) => {
        const bad = assertParticipant(s, meta.principal, '-As');
        if (bad) return err(bad);
        return withGrant(s, command.grantId, ['offered'], meta.principal, () =>
          ok([{ kind: 'grant-accepted', grantId: command.grantId, at: meta.at }]),
        );
      }, GRANT_INACTIVE);
    case 'complete-grant':
      // Allowed while PAUSED for an ACTIVE grant (committed edits land their
      // record); the ['active'] grant-state check below enforces the rest.
      return withLive(state, (s) => {
        const bad = assertParticipant(s, meta.principal, '-As');
        if (bad) return err(bad);
        return withGrant(s, command.grantId, ['active'], meta.principal, (g) =>
          ok([
            { kind: 'grant-completed', grantId: command.grantId, result: command.result, at: meta.at },
            messageEvent(envelope, g.assignee, g.issuer, 'grant-done', `GRANT ${g.id} COMPLETE\n${command.result}`),
          ]),
        );
      }, GRANT_INACTIVE);
    case 'cancel-grant':
      return withActive(state, (s) => decideCancelGrant(s, command, envelope), GRANT_INACTIVE);
    case 'revoke-turn':
      return withActive(state, (s) => decideRevokeTurn(s, command, envelope));
    case 'leave-session':
      return withLive(state, (s) => decideLeave(s, envelope)); // an agent may bail while paused
    case 'join-session':
      return withActive(state, (s) => decideJoin(s, command, envelope));
    case 'kick-agent':
      return withActive(state, (s) => decideKick(s, command, envelope));
    case 'user-message':
      return withLive(state, (s) => decideUserMessage(s, command, envelope)); // pause never brakes the human
    case 'register-user-channel':
      return withLive(state, (s) => decideRegisterUserChannel(s, command, envelope));
    case 'user-end-session':
      return withLive(state, (s) => decideUserEnd(s, command, envelope)); // end-while-paused is valid (F-A6)
    case 'user-cancel-grant':
      return withLive(state, (s) => decideUserCancelGrant(s, command, envelope), GRANT_INACTIVE);
    case 'user-kick-agent':
      return withLive(state, (s) => decideUserKick(s, command, envelope));
    case 'user-pause-session':
      return withLive(state, (s) => decideUserPause(s, command, envelope));
    case 'user-resume-session':
      return withLive(state, (s) => decideUserResume(s, command, envelope));
  }
}

/** U1 slice 4b: the brake. Repeated transitions are STABLE errors (F-A9). */
function decideUserPause(
  s: SessionState,
  command: Extract<Command, { kind: 'user-pause-session' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const bad = requireUserPrincipal(envelope, 'user-pause-session');
  if (bad) return err(bad);
  if (s.status === 'paused') {
    return err(new ProtocolError('session-already-paused', 'The session is already paused.'));
  }
  const reasonSuffix = command.reason ? ` Reason: ${command.reason}` : '';
  const events: Event[] = [{ kind: 'session-paused', reason: command.reason, at: envelope.meta.at }];
  s.agents.forEach((agent, i) => {
    events.push(userActionNotice(command, agent, i, 'pause', 'info', `SESSION PAUSED by the user.${reasonSuffix} Stand by — do not send, do not end. Mutations are accepted again after the user resumes; retry only if still appropriate.`, envelope.meta.at));
  });
  return ok(events);
}

function decideUserResume(
  s: SessionState,
  command: Extract<Command, { kind: 'user-resume-session' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const bad = requireUserPrincipal(envelope, 'user-resume-session');
  if (bad) return err(bad);
  if (s.status !== 'paused') {
    return err(new ProtocolError('session-not-paused', 'The session is not paused; there is nothing to resume.'));
  }
  const events: Event[] = [{ kind: 'session-resumed', at: envelope.meta.at }];
  s.agents.forEach((agent, i) => {
    events.push(userActionNotice(command, agent, i, 'resume', 'info', 'SESSION RESUMED by the user — normal protocol applies again.', envelope.meta.at));
  });
  return ok(events);
}

/**
 * U1 slice 4 (design REV 6): privileged user actions. Human authority
 * bypasses ROLE authorization (driver-only, issuer-only), never STRUCTURAL
 * validity. Each action's txn also carries durable ACTION NOTICES — from
 * `user`, groupId === reqId, provenance trusted_user_client, actionKind
 * discriminator — which are the composer's pending-clear correlation and
 * the ⚡ marker source. Notice ids derive `${noticeIdBase}-r${i}` (base is
 * handler-allocated, collision-proof); recipients are computed HERE, in
 * the core, because per-verb recipient rules are protocol.
 */
function requireUserPrincipal(envelope: CommandEnvelope, kind: string): ProtocolError | undefined {
  if (envelope.meta.principal !== USER_IDENTITY) {
    return new ProtocolError('user-channel-required', `${kind} may only originate from the authenticated user channel.`);
  }
  return undefined;
}

function userActionNotice(
  command: { groupId: string; noticeIdBase: string },
  to: string,
  index: number,
  actionKind: UserActionKind,
  type: Extract<Event, { kind: 'message-sent' }>['type'],
  body: string,
  at: string,
): Extract<Event, { kind: 'message-sent' }> {
  return {
    kind: 'message-sent',
    id: `${command.noticeIdBase}-r${index}`,
    from: USER_IDENTITY,
    to,
    type,
    turn: 'keep',
    body,
    at,
    groupId: command.groupId,
    provenance: 'trusted_user_client',
    actionKind,
  };
}

/** Non-vetoable immediate end; done notices to EVERY agent (design REV 6). */
function decideUserEnd(
  s: SessionState,
  command: Extract<Command, { kind: 'user-end-session' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const bad = requireUserPrincipal(envelope, 'user-end-session');
  if (bad) return err(bad);
  const summary = command.summary || 'Session ended by user.'; // ruling Q2
  const events: Event[] = [{ kind: 'session-ended', by: USER_IDENTITY, summary, at: envelope.meta.at }];
  s.agents.forEach((agent, i) => {
    events.push(userActionNotice(command, agent, i, 'end', 'done', summary, envelope.meta.at));
  });
  return ok(events);
}

/** Cancel ANY open grant; notices to issuer+assignee, DEDUPLICATED. */
function decideUserCancelGrant(
  s: SessionState,
  command: Extract<Command, { kind: 'user-cancel-grant' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const bad = requireUserPrincipal(envelope, 'user-cancel-grant');
  if (bad) return err(bad);
  const g = s.grants[command.grantId];
  if (!g) return err(new ProtocolError('grant-not-found', `No grant '${command.grantId}' (see: pair grants)`));
  if (g.state !== 'offered' && g.state !== 'active') {
    return err(
      new ProtocolError(
        'grant-stale-transition',
        `Grant '${command.grantId}' is '${g.state}' (expected: offered|active) — stale transition rejected`,
      ),
    );
  }
  const reasonSuffix = command.reason ? ` Reason: ${command.reason}` : '';
  const events: Event[] = [{ kind: 'grant-cancelled', grantId: command.grantId, reason: command.reason, at: envelope.meta.at }];
  // Deduplicated for a future issuer==assignee grant shape (round-2 C).
  [...new Set([g.issuer, g.assignee])].forEach((agent, i) => {
    events.push(
      userActionNotice(command, agent, i, 'cancel-grant', 'grant-cancel', `GRANT ${command.grantId} CANCELLED by the user.${reasonSuffix} Stop editing its scope immediately.`, envelope.meta.at),
    );
  });
  return ok(events);
}

/**
 * Forced removal by the user. STRUCTURAL invariants hold (critique R1):
 * the driver cannot be kicked in pair topology — /end is the drain verb —
 * so a survivor (the driver) always exists; the kicked agent's open grants
 * cancel in the same txn; a held turn returns to the DRIVER in the same
 * txn. Notices: stop-notice to the kicked agent (voided by the ledger with
 * the rest of its mail, journal-recorded) + action notices to survivors.
 */
function decideUserKick(
  s: SessionState,
  command: Extract<Command, { kind: 'user-kick-agent' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const bad = requireUserPrincipal(envelope, 'user-kick-agent');
  if (bad) return err(bad);
  if (command.agent === USER_IDENTITY) {
    return err(new ProtocolError('reserved-identity', `'${USER_IDENTITY}' is the reserved user-channel identity — it is never on the roster and cannot be kicked.`));
  }
  const notMember = assertParticipant(s, command.agent, '-Agent');
  if (notMember) return err(notMember);
  if (command.agent === s.driver) {
    return err(
      new ProtocolError(
        'kick-driver',
        `The driver cannot be kicked — evolve must never leave the driver outside the roster. To stop everything, end the session: /end (immediate and non-vetoable).`,
      ),
    );
  }
  const reasonSuffix = command.reason ? ` Reason: ${command.reason}` : '';
  const events: Event[] = [
    { kind: 'agent-kicked', agent: command.agent, reason: command.reason, at: envelope.meta.at },
    { kind: 'registry-updated', version: s.registry.version + 1, change: 'kicked', agent: command.agent, at: envelope.meta.at },
  ];
  for (const g of Object.values(s.grants)) {
    if (g.assignee === command.agent && (g.state === 'offered' || g.state === 'active')) {
      events.push({ kind: 'grant-cancelled', grantId: g.id, reason: `assignee kicked by the user${reasonSuffix}`, at: envelope.meta.at });
    }
  }
  const survivors = s.agents.filter((a) => a !== command.agent);
  events.push(
    userActionNotice(command, command.agent, survivors.length, 'kick', 'kick', `You were removed from the session by the user.${reasonSuffix} Stop all work immediately.`, envelope.meta.at),
  );
  survivors.forEach((agent, i) => {
    events.push(
      userActionNotice(command, agent, i, 'kick', 'info', `${command.agent} was removed from the session by the user.${reasonSuffix}`, envelope.meta.at),
    );
  });
  if (s.turn === command.agent) events.push({ kind: 'turn-passed', to: s.driver });
  return ok(events);
}

/**
 * U1 slice 3: advisory user broadcast/direct message. Defense in depth —
 * the broker's transport gate already rejects this kind on the generic
 * execute path; here we additionally require the `user` principal, which
 * only the authenticated user-channel handler can stamp. IDs arrive
 * pre-allocated by that handler (pure core cannot mint them; dedup by
 * (clientId, reqId) happened before allocation). NEVER a turn mutation.
 */
function decideUserMessage(
  s: SessionState,
  command: Extract<Command, { kind: 'user-message' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  if (envelope.meta.principal !== USER_IDENTITY) {
    return err(new ProtocolError('user-channel-required', 'user-message may only originate from the authenticated user channel.'));
  }
  if (command.recipients.length === 0) {
    return err(new ProtocolError('invalid-recipient', 'user-message requires at least one recipient.'));
  }
  const ids = new Set(command.recipients.map((r) => r.messageId));
  if (ids.size !== command.recipients.length) {
    return err(new ProtocolError('invalid-recipient', 'per-recipient message ids must be unique (allocation bug).'));
  }
  const targets = new Set(command.recipients.map((r) => r.to));
  if (targets.size !== command.recipients.length) {
    return err(new ProtocolError('invalid-recipient', 'recipients must be unique — one delivery per agent per logical send.'));
  }
  for (const r of command.recipients) {
    if (!s.agents.includes(r.to)) {
      return err(new ProtocolError('not-a-participant', `'${r.to}' is not a participant in this session.`));
    }
  }
  return ok(
    command.recipients.map((r) => ({
      kind: 'message-sent' as const,
      id: r.messageId,
      from: USER_IDENTITY,
      to: r.to,
      type: 'info' as const,
      turn: 'keep' as const,
      body: command.body,
      at: envelope.meta.at,
      groupId: command.groupId,
      provenance: 'trusted_user_client' as const,
    })),
  );
}

/**
 * U1 slice 3: journal-authoritative TOFU binding, made LOUD — the
 * registration txn carries per-agent notices as ordinary inbox deliveries
 * (distinct ids per the decideEnd fan-out pattern). No reset in slice 3:
 * a second registration is rejected regardless of mirror-file state.
 */
function decideRegisterUserChannel(
  s: SessionState,
  command: Extract<Command, { kind: 'register-user-channel' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  if (envelope.meta.principal !== USER_IDENTITY) {
    return err(new ProtocolError('user-channel-required', 'register-user-channel may only originate from the user channel.'));
  }
  if (s.userChannelTokenHash) {
    return err(new ProtocolError('user-channel-already-registered', 'A user channel is already bound to this session; slice 3 has no reset path.'));
  }
  if (!command.tokenHash) {
    return err(new ProtocolError('user-auth-failed', 'register-user-channel requires a token hash.'));
  }
  const events: Event[] = [{ kind: 'user-channel-registered', tokenHash: command.tokenHash, at: envelope.meta.at }];
  s.agents.forEach((agent, i) => {
    const msg = messageEvent(
      envelope,
      USER_IDENTITY,
      agent,
      'info',
      'USER CHANNEL REGISTERED: a trusted_user_client is now bound to this session (trust-on-first-use). User messages from `user` carry that provenance. If nobody attached a watch pane just now, flag this to your human immediately.',
    );
    events.push(i === 0 ? msg : { ...msg, id: `${envelope.meta.id}-${i}` });
  });
  return ok(events);
}

/**
 * ENHANCEMENTS 8a: the driver reclaims the turn from an unresponsive holder.
 * Hard authorization here (driver-only, active, partner holds the turn);
 * liveness (live delivery lease → partner-active) is the broker's pre-check —
 * a fact this pure core cannot know. The notice to the revoked navigator and
 * the turn return are ONE decided event list, so they commit in one txn.
 */
function decideRevokeTurn(
  s: SessionState,
  command: Extract<Command, { kind: 'revoke-turn' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const by = envelope.meta.principal;
  const bad = assertParticipant(s, by, '-From');
  if (bad) return err(bad);
  if (by !== s.driver) {
    return err(new ProtocolError('revoke-not-driver', `Only the driver (${s.driver}) may revoke the turn (you are '${by}').`));
  }
  if (s.turn === by) {
    return err(new ProtocolError('revoke-own-turn', 'You already hold the turn; there is nothing to revoke.'));
  }
  const holder = s.turn;
  const reasonSuffix = command.reason ? ` Reason: ${command.reason}` : '';
  return ok([
    { kind: 'turn-revoked', from: holder, reason: command.reason, at: envelope.meta.at },
    messageEvent(envelope, by, holder, 'turn-revoked', `TURN REVOKED by ${by} while you held it.${reasonSuffix} The driver has resumed; a reply you were composing is now advisory — send it with -Turn keep.`),
    { kind: 'turn-passed', to: by },
  ]);
}

/**
 * ENHANCEMENTS 11: voluntary leave. Blocked while holding an offered/active
 * grant; leaving while holding the turn returns it to the driver in the same
 * txn; the driver cannot leave (handoff first).
 */
function decideLeave(s: SessionState, envelope: CommandEnvelope): Result<Event[], ProtocolError> {
  const agent = envelope.meta.principal;
  const bad = assertParticipant(s, agent, '-As');
  if (bad) return err(bad);
  if (agent === s.driver) {
    return err(new ProtocolError('driver-cannot-leave', 'The driver cannot leave the session — hand off first (pair send -Type handoff), or end it.'));
  }
  const held = Object.values(s.grants).find((g) => g.assignee === agent && (g.state === 'offered' || g.state === 'active'));
  if (held) {
    return err(
      new ProtocolError(
        'leave-with-grant',
        `Cannot leave while grant '${held.id}' is ${held.state} — finish it (pair grant-done) or have the driver cancel it first.`,
      ),
    );
  }
  const events: Event[] = [
    { kind: 'agent-left', agent, at: envelope.meta.at },
    { kind: 'registry-updated', version: s.registry.version + 1, change: 'left', agent, at: envelope.meta.at },
    messageEvent(envelope, agent, s.driver, 'leave', `${agent} left the session.`),
  ];
  if (s.turn === agent) events.push({ kind: 'turn-passed', to: s.driver }); // F17: same txn
  return ok(events);
}

/**
 * ENHANCEMENTS 11: joins are driver-admitted — the DRIVER issues the join
 * for the arriving agent (roster authority is the driver's, uniformly).
 */
function decideJoin(
  s: SessionState,
  command: Extract<Command, { kind: 'join-session' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const by = envelope.meta.principal;
  const bad = assertParticipant(s, by, '-From');
  if (bad) return err(bad);
  if (by !== s.driver) {
    return err(new ProtocolError('join-not-driver', `Only the driver (${s.driver}) admits agents to the roster (you are '${by}').`));
  }
  if (command.agent === USER_IDENTITY) {
    return err(new ProtocolError('reserved-identity', `'${USER_IDENTITY}' is the reserved user-channel identity and cannot join the roster.`));
  }
  if (s.agents.includes(command.agent)) {
    return err(new ProtocolError('already-participant', `'${command.agent}' is already a participant.`));
  }
  if (!AGENT_NAME_PATTERN.test(command.agent)) {
    return err(new ProtocolError('invalid-agents', `invalid agent name '${command.agent}' (lowercase letter first, then letters/digits/dash/underscore, max 16 chars)`));
  }
  if (s.agents.length >= MAX_AGENTS) {
    return err(new ProtocolError('registry-full', `The roster is at the M1 bound (${MAX_AGENTS} live agents) — someone must leave before '${command.agent}' can join.`));
  }
  return ok([
    { kind: 'agent-joined', agent: command.agent, at: envelope.meta.at },
    { kind: 'registry-updated', version: s.registry.version + 1, change: 'joined', agent: command.agent, at: envelope.meta.at },
    messageEvent(
      envelope,
      by,
      command.agent,
      'join',
      `${command.agent} joined the session (admitted by ${by}). Catch up via .pair/memory.md and a rehydrate ask — earlier messages are not redelivered.`,
    ),
  ]);
}

/**
 * ENHANCEMENTS 11: driver-only forced removal. Open grants of the kicked
 * agent are cancelled in the SAME decided event list (one txn, F21); the
 * ledger layer voids the agent's undelivered deliveries (F18).
 */
function decideKick(
  s: SessionState,
  command: Extract<Command, { kind: 'kick-agent' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const by = envelope.meta.principal;
  if (command.agent === USER_IDENTITY) {
    return err(new ProtocolError('reserved-identity', `'${USER_IDENTITY}' is the reserved user-channel identity — it is never on the roster and cannot be kicked.`));
  }
  const bad = assertParticipant(s, by, '-From') ?? assertParticipant(s, command.agent, '-Agent');
  if (bad) return err(bad);
  if (by !== s.driver) {
    return err(new ProtocolError('kick-not-driver', `Only the driver (${s.driver}) may kick (you are '${by}').`));
  }
  if (command.agent === s.driver) {
    return err(new ProtocolError('kick-driver', 'The driver cannot be kicked — hand off first.'));
  }
  const reasonSuffix = command.reason ? ` Reason: ${command.reason}` : '';
  const events: Event[] = [
    { kind: 'agent-kicked', agent: command.agent, reason: command.reason, at: envelope.meta.at },
    { kind: 'registry-updated', version: s.registry.version + 1, change: 'kicked', agent: command.agent, at: envelope.meta.at },
  ];
  for (const g of Object.values(s.grants)) {
    if (g.assignee === command.agent && (g.state === 'offered' || g.state === 'active')) {
      events.push({ kind: 'grant-cancelled', grantId: g.id, reason: `assignee kicked${reasonSuffix}`, at: envelope.meta.at });
    }
  }
  // The stop-notice is emitted normally; the ledger voids it with the rest
  // of the kicked agent's deliveries (F21) — journaled, never delivered.
  events.push(messageEvent(envelope, by, command.agent, 'kick', `You were removed from the session by ${by}.${reasonSuffix} Stop all work immediately.`));
  if (s.turn === command.agent) events.push({ kind: 'turn-passed', to: by });
  return ok(events);
}

/** pair.ps1 parity: grant verbs report inactivity differently than send. */
const GRANT_INACTIVE = (status: string) =>
  `Session status is '${status}' — grant operations require an active session.`;
const SEND_INACTIVE = (status: string) =>
  `Session status is '${status}' — no messages can be sent. Start a new session with: pair init`;

function withActive(
  state: SessionState | undefined,
  fn: (s: SessionState) => Result<Event[], ProtocolError>,
  message: (status: string) => string = SEND_INACTIVE,
): Result<Event[], ProtocolError> {
  // The brake (U1 slice 4b): paused is LIVE, not terminal — agent mutations
  // get a stable, distinct code so CLIs can say "stand by", never "ended".
  if (state?.status === 'paused') {
    return err(new ProtocolError('session-paused', 'The user paused the session — stand by for resume. Mutations are accepted again after resume; retry only if still appropriate.'));
  }
  if (!state || state.status !== 'active') {
    const status = state ? state.status : 'missing';
    return err(new ProtocolError('session-not-active', message(status)));
  }
  return fn(state);
}

/** LIVE gate (active OR paused): the allowlisted agent verbs, all user
 * verbs, and user messages — pause is a brake on agents, never the human. */
function withLive(
  state: SessionState | undefined,
  fn: (s: SessionState) => Result<Event[], ProtocolError>,
  message: (status: string) => string = SEND_INACTIVE,
): Result<Event[], ProtocolError> {
  if (!state || (state.status !== 'active' && state.status !== 'paused')) {
    const status = state ? state.status : 'missing';
    return err(new ProtocolError('session-not-active', message(status)));
  }
  return fn(state);
}

function assertParticipant(s: SessionState, name: string, param: string): ProtocolError | undefined {
  if (!name) {
    return new ProtocolError('not-a-participant', `${param} is required (one of: ${s.agents.join(', ')})`);
  }
  if (!s.agents.includes(name)) {
    return new ProtocolError(
      'not-a-participant',
      `'${name}' is not a participant in this session (agents: ${s.agents.join(', ')}). Never impersonate another agent.`,
    );
  }
  return undefined;
}

function decideInit(
  state: SessionState | undefined,
  command: Extract<Command, { kind: 'init-session' }>,
  principal: string,
  at: string,
): Result<Event[], ProtocolError> {
  if (state && state.status !== 'completed') {
    // Paused is LIVE: re-init over it would destroy a braked session. The
    // guidance branches — agent end is itself braked while paused.
    const guidance = state.status === 'paused'
      ? 'The user must /resume it (after which an agent may end it) or /end it immediately.'
      : "Finish it with 'pair end' or delete .pair first.";
    return err(
      new ProtocolError('session-exists', `A ${state.status} session already exists here (task: ${state.task}). ${guidance}`),
    );
  }
  const agents = command.agents;
  if (agents.length < 2) {
    return err(new ProtocolError('invalid-agents', "init requires at least two agents (-Agents 'claude,codex[,agy,...]')"));
  }
  if (new Set(agents).size !== agents.length) {
    return err(new ProtocolError('invalid-agents', `agent names must be unique (got: ${agents.join(', ')})`));
  }
  if (agents.includes(USER_IDENTITY)) {
    return err(new ProtocolError('reserved-identity', `'${USER_IDENTITY}' is the reserved user-channel identity and cannot be a session agent.`));
  }
  for (const a of agents) {
    if (!AGENT_NAME_PATTERN.test(a)) {
      return err(
        new ProtocolError(
          'invalid-agents',
          `invalid agent name '${a}' (lowercase letter first, then letters/digits/dash/underscore, max 16 chars)`,
        ),
      );
    }
  }
  if (agents.length > MAX_AGENTS) {
    return err(new ProtocolError('invalid-agents', `at most ${MAX_AGENTS} agents per session (M1 registry bound); got ${agents.length}`));
  }
  if (!agents.includes(command.driver)) {
    return err(new ProtocolError('driver-not-agent', `driver '${command.driver}' must be one of the agents: ${agents.join(', ')}`));
  }
  // ENHANCEMENTS 11 (F22): roster authority is the driver's from session
  // creation onward — init must be issued AS the agent that becomes driver.
  // Checked after roster-shape validation so a malformed roster reports the
  // more diagnostic error first (DEC-04).
  if (principal !== command.driver) {
    return err(
      new ProtocolError(
        'init-not-driver',
        `init must be issued as the agent that becomes driver ('${command.driver}'), not '${principal}' — the initial roster is driver-declared.`,
      ),
    );
  }
  return ok([
    { kind: 'session-initialized', task: command.task, agents, driver: command.driver, at, ...(command.displays === undefined ? {} : { displays: command.displays }) },
    { kind: 'registry-updated', version: 1, change: 'init', at },
  ]);
}

function messageEvent(
  envelope: CommandEnvelope,
  from: string,
  to: string,
  type: Extract<Event, { kind: 'message-sent' }>['type'],
  body: string,
  turn: 'pass' | 'keep' = 'keep',
): Extract<Event, { kind: 'message-sent' }> {
  return { kind: 'message-sent', id: envelope.meta.id, from, to, type, turn, body, at: envelope.meta.at };
}

function decideSend(
  s: SessionState,
  command: Extract<Command, { kind: 'send-message' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const from = envelope.meta.principal;
  // U1: the user reads via the transcript; agents get no user inbox (v1).
  if (command.to === USER_IDENTITY) {
    return err(new ProtocolError('user-not-addressable', `'${USER_IDENTITY}' is a reserved identity and cannot receive messages (v1); the user reads the transcript via pair watch.`));
  }
  const bad = assertParticipant(s, from, '-From') ?? assertParticipant(s, command.to, '-To');
  if (bad) return err(bad);
  if (from === command.to) {
    return err(new ProtocolError('self-addressed', `-From and -To must differ (both were '${from}')`));
  }
  // Item 7 round 2 (codex): fail-closed runtime validation — the CLI casts
  // untrusted strings into these fields, and replyTo is serialized into a
  // header line (CR/LF or delimiter injection must never reach a codec).
  if (!MESSAGE_TYPES.has(command.type)) {
    return err(new ProtocolError('invalid-message-type', `Unknown message type '${command.type}'.`));
  }
  if (command.replyTo !== undefined && !MESSAGE_ID_PATTERN.test(command.replyTo)) {
    return err(new ProtocolError('invalid-reply-to', `-ReplyTo must be a plain message id (letters, digits, . _ : -; max 64 chars).`));
  }
  if (command.turn === 'pass' && s.turn !== from) {
    return err(
      new ProtocolError(
        'not-your-turn',
        `It is ${s.turn}'s turn; '${from}' cannot send a turn-passing message. Use -Turn keep for an FYI, or wait for the turn.`,
      ),
    );
  }
  if (command.type === 'handoff' && s.driver !== from) {
    return err(new ProtocolError('handoff-not-driver', `Only the driver (${s.driver}) may send handoff (you are '${from}').`));
  }
  // ENHANCEMENTS 11 (F19): ending is driver authority — the raw done-send
  // completion path is not a loophole. Navigators propose via
  // `send -Type propose-end`; the driver decides and executes the end.
  if (command.type === 'done' && s.driver !== from) {
    return err(
      new ProtocolError(
        'end-not-driver',
        `Only the driver (${s.driver}) may end the session (you are '${from}'). Propose it instead: pair send -Type propose-end -Turn keep -Message '<why>'`,
      ),
    );
  }
  const events: Event[] = [
    { kind: 'message-sent', id: envelope.meta.id, from, to: command.to, type: command.type, turn: command.turn, body: command.body, at: envelope.meta.at,
      ...(command.replyTo === undefined ? {} : { replyTo: command.replyTo }) },
  ];
  if (command.turn === 'pass') events.push({ kind: 'turn-passed', to: command.to });
  if (command.type === 'handoff') events.push({ kind: 'driver-changed', driver: command.to });
  // pair.ps1 parity: a raw `send -Type done` completes the session (pair end
  // is the richer verb — memory summary + fan-out — but done-send is legal).
  if (command.type === 'done') events.push({ kind: 'session-ended', by: from, summary: command.body, at: envelope.meta.at });
  return ok(events);
}

function decideEnd(
  s: SessionState,
  command: Extract<Command, { kind: 'end-session' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const by = envelope.meta.principal;
  const bad = assertParticipant(s, by, '-As');
  if (bad) return err(bad);
  // ENHANCEMENTS 11 (F19): end is driver authority — ending kicks everyone.
  if (by !== s.driver) {
    return err(
      new ProtocolError(
        'end-not-driver',
        `Only the driver (${s.driver}) may end the session (you are '${by}'). Propose it instead: pair send -Type propose-end -Turn keep -Message '<why>'`,
      ),
    );
  }
  const events: Event[] = [{ kind: 'session-ended', by, summary: command.summary, at: envelope.meta.at }];
  // Fan-out messages need DISTINCT ids: the mailbox file name is derived from
  // the id, and same-named files for different recipients later collide in
  // the shared archive (found live: both done files overwrote each other).
  const others = s.agents.filter((a) => a !== by);
  others.forEach((other, i) => {
    const msg = messageEvent(envelope, by, other, 'done', command.summary);
    events.push(i === 0 ? msg : { ...msg, id: `${envelope.meta.id}-${i}` });
  });
  return ok(events);
}

function validateScope(scope: GrantScopeInput): Result<GrantScope, ProtocolError> {
  if (scope.mode === 'worktree') {
    if (!scope.worktree) return err(new ProtocolError('grant-scope-invalid', 'grant requires a scope: -Worktree <path> (isolated) or -Files a,b,c (shared worktree, needs -AcceptSharedWorktreeRisk).'));
    return ok({ mode: 'worktree', worktree: scope.worktree });
  }
  if (!scope.riskAccepted) {
    return err(
      new ProtocolError(
        'grant-risk-unacknowledged',
        'A -Files scope shares the worktree: nothing mechanically stops overlapping edits (NOT M4-safe). All agents must have agreed the file sets are disjoint; acknowledge with -AcceptSharedWorktreeRisk.',
      ),
    );
  }
  const files = [...new Set(scope.files.map((f) => f.trim()).filter((f) => f.length > 0))];
  if (files.length === 0) {
    return err(new ProtocolError('grant-scope-invalid', `-Files contained no usable entries`));
  }
  return ok({ mode: 'files', files });
}

function decideIssueGrant(
  s: SessionState,
  command: Extract<Command, { kind: 'issue-grant' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const from = envelope.meta.principal;
  const bad = assertParticipant(s, from, '-From') ?? assertParticipant(s, command.to, '-To');
  if (bad) return err(bad);
  if (from !== s.driver) {
    return err(new ProtocolError('grant-not-driver', `Only the driver (${s.driver}) may issue grants (you are '${from}').`));
  }
  if (from === command.to) {
    return err(new ProtocolError('grant-to-self', 'Cannot grant work to yourself; the driver already edits under the turn.'));
  }
  if (!command.task) {
    return err(new ProtocolError('grant-task-missing', "grant requires -TaskDesc '<what the assignee should do>'"));
  }
  if (s.grants[command.grantId]) {
    return err(new ProtocolError('grant-id-collision', `Grant id collision for '${command.grantId}' — re-run the grant command.`));
  }
  const scope = validateScope(command.scope);
  if (!scope.ok) return scope;
  const scopeText =
    scope.value.mode === 'worktree'
      ? `worktree ${scope.value.worktree}`
      : `files: ${scope.value.files.join(', ')} (shared worktree — stay strictly inside this list)`;
  const body = `WORK GRANT ${command.grantId}\nTask: ${command.task}\nScope: ${scopeText}\n\nAccept with: pair grant-accept -As ${command.to} -Id ${command.grantId}\nThen work the task (editing allowed within scope only, even without the turn), and finish with: pair grant-done -As ${command.to} -Id ${command.grantId} -Message '<result summary>'`;
  return ok([
    { kind: 'grant-issued', grantId: command.grantId, issuer: from, assignee: command.to, task: command.task, scope: scope.value, agreedIn: command.agreedIn, at: envelope.meta.at },
    messageEvent(envelope, from, command.to, 'grant', body),
  ]);
}

function withGrant(
  s: SessionState,
  grantId: string,
  expected: readonly Grant['state'][],
  principal: string,
  fn: (g: Grant) => Result<Event[], ProtocolError>,
): Result<Event[], ProtocolError> {
  const g = s.grants[grantId];
  if (!g) return err(new ProtocolError('grant-not-found', `No grant '${grantId}' (see: pair grants)`));
  if (!expected.includes(g.state)) {
    return err(
      new ProtocolError(
        'grant-stale-transition',
        `Grant '${grantId}' is '${g.state}' (expected: ${expected.join('|')}) — stale transition rejected`,
      ),
    );
  }
  if (g.assignee !== principal) {
    return err(new ProtocolError('grant-wrong-assignee', `Grant '${g.id}' is assigned to ${g.assignee}, not '${principal}'`));
  }
  return fn(g);
}

function decideCancelGrant(
  s: SessionState,
  command: Extract<Command, { kind: 'cancel-grant' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const by = envelope.meta.principal;
  const bad = assertParticipant(s, by, '-As');
  if (bad) return err(bad);
  if (by !== s.driver) {
    return err(new ProtocolError('grant-not-driver', `Only the driver (${s.driver}) may cancel grants.`));
  }
  const g = s.grants[command.grantId];
  if (!g) return err(new ProtocolError('grant-not-found', `No grant '${command.grantId}' (see: pair grants)`));
  if (g.state !== 'offered' && g.state !== 'active') {
    return err(
      new ProtocolError(
        'grant-stale-transition',
        `Grant '${command.grantId}' is '${g.state}' (expected: offered|active) — stale transition rejected`,
      ),
    );
  }
  const reasonSuffix = command.reason ? ` Reason: ${command.reason}` : '';
  return ok([
    { kind: 'grant-cancelled', grantId: command.grantId, reason: command.reason, at: envelope.meta.at },
    messageEvent(envelope, by, g.assignee, 'grant-cancel', `GRANT ${command.grantId} CANCELLED by ${by}.${reasonSuffix} Stop editing its scope immediately.`),
  ]);
}
