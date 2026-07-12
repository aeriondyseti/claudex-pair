import type { CommandEnvelope, Command, GrantScopeInput } from './commands.ts';
import type { Event } from './events.ts';
import { ProtocolError } from './errors.ts';
import { AGENT_NAME_PATTERN, err, ok, type Grant, type GrantScope, type Result, type SessionState } from './types.ts';

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
      return decideInit(state, command, meta.at);
    case 'send-message':
      return withActive(state, (s) => decideSend(s, command, envelope));
    case 'end-session':
      return withActive(state, (s) => decideEnd(s, command, envelope));
    case 'issue-grant':
      return withActive(state, (s) => decideIssueGrant(s, command, envelope));
    case 'accept-grant':
      return withActive(state, (s) => {
        const bad = assertParticipant(s, meta.principal, '-As');
        if (bad) return err(bad);
        return withGrant(s, command.grantId, ['offered'], meta.principal, () =>
          ok([{ kind: 'grant-accepted', grantId: command.grantId, at: meta.at }]),
        );
      });
    case 'complete-grant':
      return withActive(state, (s) => {
        const bad = assertParticipant(s, meta.principal, '-As');
        if (bad) return err(bad);
        return withGrant(s, command.grantId, ['active'], meta.principal, (g) =>
          ok([
            { kind: 'grant-completed', grantId: command.grantId, result: command.result, at: meta.at },
            messageEvent(envelope, g.assignee, g.issuer, 'grant-done', `GRANT ${g.id} COMPLETE\n${command.result}`),
          ]),
        );
      });
    case 'cancel-grant':
      return withActive(state, (s) => decideCancelGrant(s, command, envelope));
  }
}

function withActive(
  state: SessionState | undefined,
  fn: (s: SessionState) => Result<Event[], ProtocolError>,
): Result<Event[], ProtocolError> {
  if (!state || state.status !== 'active') {
    const status = state ? state.status : 'missing';
    return err(
      new ProtocolError(
        'session-not-active',
        `Session status is '${status}' — no messages can be sent. Start a new session with: pair init`,
      ),
    );
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
  at: string,
): Result<Event[], ProtocolError> {
  if (state && state.status === 'active') {
    return err(
      new ProtocolError(
        'session-exists',
        `An active session already exists here (task: ${state.task}). Finish it with 'pair end' or delete .pair first.`,
      ),
    );
  }
  const agents = command.agents;
  if (agents.length < 2) {
    return err(new ProtocolError('invalid-agents', "init requires at least two agents (-Agents 'claude,codex[,agy,...]')"));
  }
  if (new Set(agents).size !== agents.length) {
    return err(new ProtocolError('invalid-agents', `agent names must be unique (got: ${agents.join(', ')})`));
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
  if (!agents.includes(command.driver)) {
    return err(new ProtocolError('driver-not-agent', `driver '${command.driver}' must be one of the agents: ${agents.join(', ')}`));
  }
  return ok([{ kind: 'session-initialized', task: command.task, agents, driver: command.driver, at }]);
}

function messageEvent(
  envelope: CommandEnvelope,
  from: string,
  to: string,
  type: Extract<Event, { kind: 'message-sent' }>['type'],
  body: string,
  turn: 'pass' | 'keep' = 'keep',
): Event {
  return { kind: 'message-sent', id: envelope.meta.id, from, to, type, turn, body, at: envelope.meta.at };
}

function decideSend(
  s: SessionState,
  command: Extract<Command, { kind: 'send-message' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const from = envelope.meta.principal;
  const bad = assertParticipant(s, from, '-From') ?? assertParticipant(s, command.to, '-To');
  if (bad) return err(bad);
  if (from === command.to) {
    return err(new ProtocolError('self-addressed', `-From and -To must differ (both were '${from}')`));
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
  const events: Event[] = [
    { kind: 'message-sent', id: envelope.meta.id, from, to: command.to, type: command.type, turn: command.turn, body: command.body, at: envelope.meta.at },
  ];
  if (command.turn === 'pass') events.push({ kind: 'turn-passed', to: command.to });
  if (command.type === 'handoff') events.push({ kind: 'driver-changed', driver: command.to });
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
  const events: Event[] = [{ kind: 'session-ended', by, summary: command.summary, at: envelope.meta.at }];
  for (const other of s.agents.filter((a) => a !== by)) {
    events.push(messageEvent(envelope, by, other, 'done', command.summary));
  }
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
