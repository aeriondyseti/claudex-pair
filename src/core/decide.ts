import type { CommandEnvelope, Command, CommandMeta, GrantScopeInput } from './commands.ts';
import type { Event, UserActionKind } from './events.ts';
import { ProtocolError } from './errors.ts';
import { advanceRotation } from './rotation.ts';
import { DISPLAY_PATTERN, PROPOSAL_MAX_BYTES, PROPOSALS_TOTAL_MAX_BYTES, DRAFT_MAX_BYTES, DRAFT_REVISIONS_MAX, FINDING_TEXT_MAX, FINDINGS_MAX, FINDINGS_TEXT_TOTAL_MAX, REASONS_MAX, ROUND_CAP, BROKER_SENDER, findControlCharacter, MAX_AGENTS, SESSION_ID_PATTERN, type AgentId, MESSAGE_ID_PATTERN, MESSAGE_TYPES, AGENT_NAME_PATTERN, USER_IDENTITY, err, ok, type Finding, type Grant, type GrantScope, type Registry, type Result, type SessionState } from './types.ts';
import { validatePlanTaskBlock } from './plan.ts';

/**
 * The protocol state machine. Pure, deterministic, total. Every invariant in
 * PROTOCOL.md lives here — never in an adapter, never in the CLI.
 *
 * `state` is undefined only for init-session (no session yet, or the caller
 * loaded a completed one and is re-initializing).
 */
/** M1 round 2 (codex): ONE shared session-binding path - every
 * message-sent of every class (sends, grant/lifecycle notices, user
 * broadcasts, privileged-action notices) leaves decide carrying the
 * session id. Absent only for genuinely legacy state. */
export function decide(state: SessionState | undefined, envelope: CommandEnvelope): Result<Event[], ProtocolError> {
  const result = decideInner(state, envelope);
  if (!result.ok) return result;
  const init = result.value.find((e) => e.kind === 'session-initialized');
  const sessionId = state?.sessionId ?? (init?.kind === 'session-initialized' ? init.sessionId : undefined);
  if (sessionId === undefined) return result;
  return ok(result.value.map((e) => (e.kind === 'message-sent' && e.sessionId === undefined ? { ...e, sessionId } : e)));
}

function decideInner(
  state: SessionState | undefined,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const { command, meta } = envelope;
  // Peer 1A command matrix (rev 4): NO driver authority exists in peer
  // topology — the whole verb class is rejected fail-closed. Claims (the
  // grant successor) arrive in slice 3.
  if (state?.topology === 'peer') {
    const rejected: Partial<Record<Command['kind'], string>> = {
      'revoke-turn': 'Peer sessions have no turn to revoke.',
      'join-session': "Peer admission is authorized by the user or the plan's policy, never driver-admitted — the joining agent attaches with its own credential.",
      'kick-agent': 'Only the user removes peers (user-kick from the watch pane).',
      'end-session': 'No agent ends a peer session — the user ends it, or a phase exit does.',
      'issue-grant': PEER_GRANTS, 'accept-grant': PEER_GRANTS, 'complete-grant': PEER_GRANTS, 'cancel-grant': PEER_GRANTS,
    };
    const why = rejected[command.kind];
    if (why !== undefined) return err(new ProtocolError('no-driver-authority', why));
  }
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
    case 'user-admit-agent':
      return withLive(state, (s) => decideUserAdmit(s, command, envelope));
    case 'user-rebind-agent':
      return withLive(state, (s) => decideUserRebind(s, command, envelope));
    case 'user-rule-absentee':
      return withLive(state, (s) => decideUserRuleAbsentee(s, command, envelope));
    case 'user-force-phase':
      return withLive(state, (s) => decideUserForcePhase(s, command, envelope));
    case 'user-clear-attention':
      return withLive(state, (s) => decideUserClearAttention(s, command, envelope));
    case 'propose':
      return withActive(state, (s) => decidePropose(s, command, envelope));
    case 'draft-amend':
      return withActive(state, (s) => decideDraftAmend(s, command, envelope));
    case 'critique':
      return withActive(state, (s) => decideCritique(s, command, envelope));
    case 'respond-critique':
      return withActive(state, (s) => decideRespondCritique(s, command, envelope));
    case 'confirm-critique':
      return withActive(state, (s) => decideConfirmCritique(s, command, envelope));
    case 'amend-critique':
      return withActive(state, (s) => decideAmendCritique(s, command, envelope));
    case 'yield-turn':
      return withActive(state, (s) => decideYield(s, envelope));
    case 'call-question':
      return withActive(state, (s) => decideCallQuestion(s, envelope));
    case 'vote':
      return withActive(state, (s) => decideVote(s, command, envelope));
    case 'address-agenda':
      return withActive(state, (s) => decideAddressAgenda(s, command, envelope));
  }
}

/** Round 2 #6: a departure during ADMITTING shrinks both the admitted set
 * and the completion set — if the survivors now satisfy it, the SAME txn
 * opens the barrier over them (durable fact, frozen electorate). */
function appendAdmittingCompletion(s: SessionState, departing: AgentId, events: Event[], at: string): void {
  if (s.topology !== 'peer' || s.planning?.substate !== 'admitting') return;
  const expected = s.planning.authorizedExpected.filter((a) => a !== departing);
  const admitted = s.planning.admitted.filter((a) => a !== departing);
  if (expected.length > 0 && expected.every((a) => admitted.includes(a))) {
    events.push({ kind: 'admission-completed', at });
    events.push({ kind: 'barrier-opened', members: admitted, registryVersion: s.registry.version + 1, at });
  }
}

function decideUserClearAttention(
  s: SessionState,
  command: Extract<Command, { kind: 'user-clear-attention' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const bad = requireUserPrincipal(envelope, 'user-clear-attention');
  if (bad) return err(bad);
  const peer = requirePeer(s, 'user-clear-attention');
  if (peer instanceof ProtocolError) return err(peer);
  if (!peer.attention.some((a) => a.id === command.id)) {
    return err(new ProtocolError('unknown-attention', `No attention item '${command.id}' — it may already be cleared (status lists open items).`));
  }
  return ok([{ kind: 'attention-cleared', id: command.id, at: envelope.meta.at }]);
}

/** Peer 1A privileged user verbs — all typed, all through the same
 * auth->dedup->state routing as the slice-4 set. */
function requirePeer(s: SessionState, verb: string): SessionState & { topology: 'peer' } | ProtocolError {
  if (s.topology !== 'peer') return new ProtocolError('not-peer-topology', `${verb} is peer-topology machinery.`);
  return s as SessionState & { topology: 'peer' };
}

function decideUserAdmit(
  s: SessionState,
  command: Extract<Command, { kind: 'user-admit-agent' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const bad = requireUserPrincipal(envelope, 'user-admit-agent');
  if (bad) return err(bad);
  const peer = requirePeer(s, 'user-admit-agent');
  if (peer instanceof ProtocolError) return err(peer);
  if (command.agent === USER_IDENTITY) return err(new ProtocolError('reserved-identity', `'${USER_IDENTITY}' is the reserved user-channel identity.`));
  if (!AGENT_NAME_PATTERN.test(command.agent)) return err(new ProtocolError('invalid-agents', `invalid agent name '${command.agent}'`));
  // Round 2 #3: authorization works in EVERY substate — during admitting
  // it joins the current completion set; afterwards the agent attaches as
  // an observer (never entering a frozen barrier electorate).
  if (peer.authorized.includes(command.agent) || peer.agents.includes(command.agent)) {
    return err(new ProtocolError('already-participant', `'${command.agent}' is already authorized or admitted.`));
  }
  const pending = peer.authorized.filter((a) => !peer.agents.includes(a)).length;
  if (peer.agents.length + pending >= MAX_AGENTS) {
    return err(new ProtocolError('registry-full', `The roster is at the M1 bound (${MAX_AGENTS}).`));
  }
  const observer = peer.planning?.substate !== 'admitting';
  const events: Event[] = [{ kind: 'admission-authorized', agent: command.agent, at: envelope.meta.at }];
  peer.agents.forEach((agent, i) => {
    events.push(userActionNotice(command, agent, i, 'admit', 'info', `USER AUTHORIZED '${command.agent}' to join${observer ? ' as an OBSERVER (the current barrier electorate is frozen)' : ''} — it becomes a member when it attaches with its own credential.`, envelope.meta.at));
  });
  return ok(events);
}

function decideUserRebind(
  s: SessionState,
  command: Extract<Command, { kind: 'user-rebind-agent' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const bad = requireUserPrincipal(envelope, 'user-rebind-agent');
  if (bad) return err(bad);
  const peer = requirePeer(s, 'user-rebind-agent');
  if (peer instanceof ProtocolError) return err(peer);
  const record = peer.registry.agents[command.agent];
  if (!record?.binding) {
    return err(new ProtocolError('invalid-agents', `'${command.agent}' has no credential binding to rebind.`));
  }
  const events: Event[] = [
    { kind: 'registry-updated', version: peer.registry.version + 1, change: 'rebound', agent: command.agent, at: envelope.meta.at },
  ];
  peer.agents.forEach((agent, i) => {
    events.push(userActionNotice(command, agent, i, 'rebind', 'info', `USER REBOUND '${command.agent}' — its old credential is revoked; it must re-attach with a freshly generated one.`, envelope.meta.at));
  });
  return ok(events);
}

function decideUserRuleAbsentee(
  s: SessionState,
  command: Extract<Command, { kind: 'user-rule-absentee' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const bad = requireUserPrincipal(envelope, 'user-rule-absentee');
  if (bad) return err(bad);
  const peer = requirePeer(s, 'user-rule-absentee');
  if (peer instanceof ProtocolError) return err(peer);
  // 1B: the same verb rules non-submitters while the barrier COLLECTS.
  if (peer.planning?.substate === 'collecting') {
    return decideCollectingRuling(peer, peer.planning, command, envelope);
  }
  if (peer.planning?.substate !== 'admitting') {
    return err(new ProtocolError('admitting-closed', 'Absentee rulings apply to the admitting and collecting substates.'));
  }
  const isAbsentee = peer.planning.authorizedExpected.includes(command.agent) && !peer.planning.admitted.includes(command.agent);
  if (!isAbsentee) return err(new ProtocolError('not-an-absentee', `'${command.agent}' is not an expected-but-unadmitted invitee.`));
  if (command.ruling === 'wait' && !command.newDeadlineAt) {
    return err(new ProtocolError('not-an-absentee', "ruling 'wait' requires a new absolute deadline (-NewDeadlineAt)."));
  }
  const events: Event[] = [{ kind: 'absentee-ruled', agent: command.agent, ruling: command.ruling, ...(command.newDeadlineAt === undefined ? {} : { newDeadlineAt: command.newDeadlineAt }), at: envelope.meta.at }];
  if (command.ruling === 'wait') {
    // Peer slice 2: a new deadline resolves whatever a prior expiry paged.
    events.push(...clearDeadlineExpiredAttention(peer, envelope.meta.at));
  }
  if (command.ruling === 'abstain') {
    // The CLOSING ruling opens the barrier atomically (rev 3), emitting
    // the durable barrier-open fact with the FROZEN electorate (round 2 #4).
    const remaining = peer.planning.authorizedExpected.filter((a) => a !== command.agent);
    const admitted = peer.planning.admitted;
    if (remaining.every((a) => admitted.includes(a))) {
      events.push({ kind: 'admission-completed', at: envelope.meta.at });
      events.push({ kind: 'barrier-opened', members: [...admitted], registryVersion: peer.registry.version, at: envelope.meta.at });
      // Peer slice 2: the closing ruling resolves any pending expiry too.
      events.push(...clearDeadlineExpiredAttention(peer, envelope.meta.at));
    }
  }
  peer.agents.forEach((agent, i) => {
    events.push(userActionNotice(command, agent, i, 'rule-absentee', 'info', `USER RULED absentee '${command.agent}': ${command.ruling}${command.newDeadlineAt ? ` (new deadline ${command.newDeadlineAt})` : ''}.`, envelope.meta.at));
  });
  return ok(events);
}

/** 1B: sealed blind proposal (collecting; author must be an opened member
 * who has neither submitted nor been abstained). The body is validated
 * here (grammar/bounds) but journaled only in the record's sealed field. */
function decidePropose(
  s: SessionState,
  command: Extract<Command, { kind: 'propose' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const peer = requirePeer(s, 'propose');
  if (peer instanceof ProtocolError) return err(peer);
  if (peer.planning?.substate !== 'collecting') {
    return err(new ProtocolError('phase-unavailable', 'Proposals are collected only while the blind barrier is open.'));
  }
  const from = envelope.meta.principal;
  const planning = peer.planning;
  if (!planning.barrier.openedMembers.includes(from)) {
    return err(new ProtocolError('not-in-electorate', `'${from}' is not in this barrier's opened membership — observers contribute via ordinary messages.`));
  }
  if (planning.abstained.includes(from)) {
    return err(new ProtocolError('already-abstained', `'${from}' was ruled abstained for this barrier and cannot submit to it.`));
  }
  if (planning.submitted[from] !== undefined) {
    return err(new ProtocolError('already-submitted', 'One proposal per member per barrier — amendments belong to convergence.'));
  }
  if (!command.content.trim()) {
    return err(new ProtocolError('blank-content', 'A proposal cannot be blank.'));
  }
  const ctl = findControlCharacter(command.content);
  if (ctl >= 0) {
    return err(new ProtocolError('control-characters', `Control character at offset ${ctl} — allowed: \n, \t, \r only.`));
  }
  const bytes = envelope.meta.contentBytes;
  const contentHash = envelope.meta.contentHash;
  if (bytes === undefined || contentHash === undefined) {
    return err(new ProtocolError('blank-content', 'Internal: content accounting missing (the broker stamps it).'));
  }
  if (bytes > PROPOSAL_MAX_BYTES) {
    return err(new ProtocolError('proposal-too-large', `Proposal is ${bytes} bytes; the bound is ${PROPOSAL_MAX_BYTES}.`));
  }
  const cumulative = Object.values(planning.submitted).reduce((sum, sub) => sum + sub.bytes, 0) + bytes;
  if (cumulative > PROPOSALS_TOTAL_MAX_BYTES) {
    // Checked at EVERY propose so the cap can never first bite on the
    // last submission (design rev 2 #4).
    return err(new ProtocolError('proposals-exhausted', `Cumulative sealed bytes would reach ${cumulative}; the bound is ${PROPOSALS_TOTAL_MAX_BYTES}.`));
  }
  return ok([{ kind: 'proposal-submitted', author: from, contentHash, bytes, at: envelope.meta.at }]);
}

/** 1B-b: the living draft (converging substate only). Holder-only,
 * optimistic-concurrency amendment — baseRevision must match the CURRENT
 * draft revision (stale-draft-revision otherwise). draft-history-exhausted
 * is a PURE rejection (design rev 4 Ruling A semantics: commits nothing)
 * once revisionLog hits DRAFT_REVISIONS_MAX, signalling a likely livelock. */
function decideDraftAmend(
  s: SessionState,
  command: Extract<Command, { kind: 'draft-amend' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const peer = requirePeer(s, 'draft-amend');
  if (peer instanceof ProtocolError) return err(peer);
  // convergence-blocked also rejects here (no rotation.holder to check).
  if (peer.planning?.substate !== 'converging') {
    return err(new ProtocolError('phase-unavailable', 'the draft is amendable only while converging'));
  }
  const planning = peer.planning;
  const principal = envelope.meta.principal;
  if (principal !== planning.rotation.holder) {
    return err(new ProtocolError('not-convergence-holder', `Only the convergence holder ('${planning.rotation.holder}') may amend the draft.`));
  }
  if (!command.content.trim()) {
    return err(new ProtocolError('blank-content', 'A draft amendment cannot be blank.'));
  }
  const ctl = findControlCharacter(command.content);
  if (ctl >= 0) {
    return err(new ProtocolError('control-characters', `Control character at offset ${ctl} — allowed: \n, \t, \r only.`));
  }
  const bytes = envelope.meta.contentBytes;
  const contentHash = envelope.meta.contentHash;
  if (bytes === undefined || contentHash === undefined) {
    return err(new ProtocolError('blank-content', 'Internal: content accounting missing (the broker stamps it).'));
  }
  if (bytes > DRAFT_MAX_BYTES) {
    return err(new ProtocolError('draft-too-large', `Draft is ${bytes} bytes; the bound is ${DRAFT_MAX_BYTES}.`));
  }
  if (command.baseRevision !== planning.draft.revision) {
    return err(new ProtocolError('stale-draft-revision', `baseRevision ${command.baseRevision} is stale — the current draft revision is ${planning.draft.revision}.`));
  }
  if (planning.revisionLog.length >= DRAFT_REVISIONS_MAX) {
    return err(new ProtocolError('draft-history-exhausted', `The draft has reached ${DRAFT_REVISIONS_MAX} revisions — convergence has likely livelocked; a human should intervene.`));
  }
  const events: Event[] = [{ kind: 'draft-amended', revision: command.baseRevision + 1, hash: contentHash, author: principal, content: command.content, bytes, at: envelope.meta.at }];
  // 1C revision binding: an amendment moves the target, so any open ballot is
  // voided in the SAME txn (votes bound to the old revision hash are stale).
  if (planning.ballot) {
    events.push({ kind: 'ballot-closed', outcome: 'voided', at: envelope.meta.at });
  }
  return ok(events);
}

/** 1B-c: the converging peer + electorate gate shared by every finding verb.
 * Findings exist ONLY while converging (convergence-blocked has no live
 * rotation and rejects with phase-unavailable, same as draft-amend). */
function requireConverging(
  s: SessionState,
  verb: string,
): { peer: SessionState & { topology: 'peer' }; planning: Extract<NonNullable<SessionState['planning']>, { substate: 'converging' }> } | ProtocolError {
  const peer = requirePeer(s, verb);
  if (peer instanceof ProtocolError) return peer;
  if (peer.planning?.substate !== 'converging') {
    return new ProtocolError('phase-unavailable', `${verb} is available only while converging.`);
  }
  return { peer, planning: peer.planning };
}

/** 1B-c: validate a finding text field. Grammar and byte bound mirror the
 * proposal/draft rules; blank maps to the caller's code ('reason-required'
 * for dispute/contest, 'blank-content' otherwise). meta is broker-stamped. */
function validateFindingText(
  text: string,
  meta: CommandMeta,
  blankCode: 'blank-content' | 'reason-required',
): Result<{ bytes: number; textHash: string }, ProtocolError> {
  if (!text.trim()) {
    return err(new ProtocolError(blankCode, blankCode === 'reason-required' ? 'A reason (non-blank text) is required for this action.' : 'The finding text cannot be blank.'));
  }
  const ctl = findControlCharacter(text);
  if (ctl >= 0) {
    return err(new ProtocolError('control-characters', `Control character at offset ${ctl} — allowed: \n, \t, \r only.`));
  }
  const bytes = meta.contentBytes;
  const textHash = meta.contentHash;
  if (bytes === undefined || textHash === undefined) {
    return err(new ProtocolError('blank-content', 'Internal: content accounting missing (the broker stamps it).'));
  }
  if (bytes > FINDING_TEXT_MAX) {
    return err(new ProtocolError('finding-too-large', `Finding text is ${bytes} bytes; the bound is ${FINDING_TEXT_MAX}.`));
  }
  return ok({ bytes, textHash });
}

const FINDING_TERMINAL: ReadonlySet<Finding['lifecycle']> = new Set(['resolved', 'conceded', 'withdrawn']);

/** 1B-c: file a finding against a draft revision or a rival proposal. The
 * addressee is DERIVED from the anchor (the revision's or proposal's author),
 * never claimed. Deterministic id `${envelope.meta.id}-f`. */
function decideCritique(
  s: SessionState,
  command: Extract<Command, { kind: 'critique' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const gate = requireConverging(s, 'critique');
  if (gate instanceof ProtocolError) return err(gate);
  const { planning } = gate;
  const principal = envelope.meta.principal;
  if (!planning.rotation.electorate.includes(principal)) {
    return err(new ProtocolError('not-in-electorate', `'${principal}' is not in the barrier electorate — only electorate members file findings.`));
  }
  const text = validateFindingText(command.text, envelope.meta, 'blank-content');
  if (!text.ok) return text;
  let addressedTo: AgentId;
  if (command.anchor.kind === 'draft') {
    const rev = command.anchor.revision;
    if (rev === 0) {
      return err(new ProtocolError('not-anchorable', 'Draft revision 0 is the empty reveal draft — there is nothing to critique.'));
    }
    if (rev < 0 || rev > planning.draft.revision) {
      return err(new ProtocolError('unknown-finding', `Draft revision ${rev} does not exist (current revision is ${planning.draft.revision}).`));
    }
    const entry = planning.revisionLog.find((r) => r.revision === rev);
    if (!entry || entry.author === null) {
      return err(new ProtocolError('unknown-finding', `Draft revision ${rev} has no attributable author.`));
    }
    addressedTo = entry.author;
  } else {
    if (!planning.rotation.electorate.includes(command.anchor.author)) {
      return err(new ProtocolError('unknown-finding', `'${command.anchor.author}' is not an electorate member with a proposal to anchor to.`));
    }
    addressedTo = command.anchor.author;
  }
  if (addressedTo === principal) {
    return err(new ProtocolError('self-addressed-finding', 'A finding cannot address your own artifact.'));
  }
  if (Object.keys(planning.findings).length >= FINDINGS_MAX) {
    return err(new ProtocolError('findings-exhausted', `The finding cap (${FINDINGS_MAX}) is reached — convergence has likely livelocked; a human should intervene.`));
  }
  const priorBytes = Object.values(planning.findings).reduce((sum, f) => sum + f.history.reduce((h, e) => h + e.bytes, 0), 0);
  if (priorBytes + text.value.bytes > FINDINGS_TEXT_TOTAL_MAX) {
    return err(new ProtocolError('findings-exhausted', `Cumulative finding text would reach ${priorBytes + text.value.bytes} bytes; the bound is ${FINDINGS_TEXT_TOTAL_MAX}.`));
  }
  return ok([{
    kind: 'finding-filed',
    id: `${envelope.meta.id}-f`,
    author: principal,
    addressedTo,
    anchor: command.anchor,
    severity: command.severity,
    agreement: command.agreement,
    text: command.text,
    bytes: text.value.bytes,
    textHash: text.value.textHash,
    at: envelope.meta.at,
  }]);
}

/** 1B-c: shared lookup + terminal guard for the transition verbs. */
function locateFinding(
  s: SessionState,
  verb: string,
  findingId: string,
): { planning: Extract<NonNullable<SessionState['planning']>, { substate: 'converging' }>; finding: Finding } | ProtocolError {
  const gate = requireConverging(s, verb);
  if (gate instanceof ProtocolError) return gate;
  const finding = gate.planning.findings[findingId];
  if (!finding) return new ProtocolError('unknown-finding', `No finding '${findingId}'.`);
  if (FINDING_TERMINAL.has(finding.lifecycle)) {
    return new ProtocolError('finding-terminal', `Finding '${findingId}' is ${finding.lifecycle} (terminal) — no further transitions.`);
  }
  return { planning: gate.planning, finding };
}

/** 1B-c transition rows 1-3: the ADDRESSEE answers an open finding. */
function decideRespondCritique(
  s: SessionState,
  command: Extract<Command, { kind: 'respond-critique' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const located = locateFinding(s, 'respond-critique', command.findingId);
  if (located instanceof ProtocolError) return err(located);
  const { finding } = located;
  const principal = envelope.meta.principal;
  if (principal !== finding.addressedTo) {
    return err(new ProtocolError('not-the-addressee', `Only the addressee ('${finding.addressedTo}') may respond to finding '${finding.id}'.`));
  }
  if (finding.lifecycle !== 'open') {
    return err(new ProtocolError('wrong-lifecycle', `respond-critique applies only to an OPEN finding ('${finding.id}' is ${finding.lifecycle}).`));
  }
  if (finding.history.length >= REASONS_MAX) {
    return err(new ProtocolError('finding-history-exhausted', `Finding '${finding.id}' reached ${REASONS_MAX} history entries — a human should intervene.`));
  }
  const text = validateFindingText(command.text, envelope.meta, command.disposition === 'dispute' ? 'reason-required' : 'blank-content');
  if (!text.ok) return text;
  return ok([{ kind: 'finding-responded', id: finding.id, disposition: command.disposition, text: command.text, bytes: text.value.bytes, textHash: text.value.textHash, at: envelope.meta.at }]);
}

/** 1B-c transition rows 4-5: the AUTHOR confirms an answered finding. */
function decideConfirmCritique(
  s: SessionState,
  command: Extract<Command, { kind: 'confirm-critique' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const located = locateFinding(s, 'confirm-critique', command.findingId);
  if (located instanceof ProtocolError) return err(located);
  const { finding } = located;
  const principal = envelope.meta.principal;
  if (principal !== finding.author) {
    return err(new ProtocolError('not-your-finding', `Only the author ('${finding.author}') may confirm finding '${finding.id}'.`));
  }
  if (finding.lifecycle !== 'answered') {
    return err(new ProtocolError('wrong-lifecycle', `confirm-critique applies only to an ANSWERED finding ('${finding.id}' is ${finding.lifecycle}).`));
  }
  if (finding.history.length >= REASONS_MAX) {
    return err(new ProtocolError('finding-history-exhausted', `Finding '${finding.id}' reached ${REASONS_MAX} history entries — a human should intervene.`));
  }
  const text = validateFindingText(command.text, envelope.meta, command.verdict === 'contest' ? 'reason-required' : 'blank-content');
  if (!text.ok) return text;
  const setDisputed = command.verdict === 'contest' && command.setDisputed === true;
  return ok([{ kind: 'finding-confirmed', id: finding.id, verdict: command.verdict, text: command.text, bytes: text.value.bytes, textHash: text.value.textHash, at: envelope.meta.at, ...(setDisputed ? { setDisputed: true } : {}) }]);
}

/** 1B-c transition rows 6-7: the AUTHOR withdraws or re-labels its finding.
 * text is OPTIONAL — a bare withdraw carries none (bytes 0). */
function decideAmendCritique(
  s: SessionState,
  command: Extract<Command, { kind: 'amend-critique' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const located = locateFinding(s, 'amend-critique', command.findingId);
  if (located instanceof ProtocolError) return err(located);
  const { finding } = located;
  const principal = envelope.meta.principal;
  if (principal !== finding.author) {
    return err(new ProtocolError('not-your-finding', `Only the author ('${finding.author}') may amend finding '${finding.id}'.`));
  }
  if (command.action === 'set-agreement') {
    if (finding.lifecycle !== 'open') {
      return err(new ProtocolError('wrong-lifecycle', `set-agreement applies only to an OPEN finding ('${finding.id}' is ${finding.lifecycle}).`));
    }
    if (command.agreement === undefined) {
      return err(new ProtocolError('reason-required', 'amend-critique set-agreement requires -Agreement agreed|partial|disputed.'));
    }
  }
  if (finding.history.length >= REASONS_MAX) {
    return err(new ProtocolError('finding-history-exhausted', `Finding '${finding.id}' reached ${REASONS_MAX} history entries — a human should intervene.`));
  }
  // Optional text: present-and-non-blank is recorded; absent/blank is bytes 0.
  let textFields: { text: string; bytes: number; textHash: string } | undefined;
  if (typeof command.text === 'string' && command.text.trim().length > 0) {
    const text = validateFindingText(command.text, envelope.meta, 'blank-content');
    if (!text.ok) return text;
    textFields = { text: command.text, bytes: text.value.bytes, textHash: text.value.textHash };
  }
  return ok([{
    kind: 'finding-amended',
    id: finding.id,
    action: command.action,
    ...(command.action === 'set-agreement' && command.agreement !== undefined ? { agreement: command.agreement } : {}),
    ...(textFields ? { text: textFields.text, bytes: textFields.bytes, textHash: textFields.textHash } : {}),
    at: envelope.meta.at,
  }]);
}

/** 1B-c: the convergence holder passes the turn. MUST-RESPOND gate — any
 * OPEN finding addressed to the holder blocks the yield until answered. The
 * advance (Ruling B) may pass to a live successor or halt. */
function decideYield(s: SessionState, envelope: CommandEnvelope): Result<Event[], ProtocolError> {
  const gate = requireConverging(s, 'yield-turn');
  if (gate instanceof ProtocolError) return err(gate);
  const { peer, planning } = gate;
  const principal = envelope.meta.principal;
  if (principal !== planning.rotation.holder) {
    return err(new ProtocolError('not-convergence-holder', `Only the convergence holder ('${planning.rotation.holder}') may yield the turn.`));
  }
  const unanswered = Object.values(planning.findings)
    .filter((f) => f.lifecycle === 'open' && f.addressedTo === principal)
    .map((f) => f.id);
  if (unanswered.length > 0) {
    return err(new ProtocolError('unanswered-findings', `Respond to the open findings addressed to you before yielding: ${unanswered.join(', ')}.`));
  }
  const outcome = advanceRotation(planning.rotation, peer.registry, undefined);
  if (outcome.kind === 'passed') {
    return ok([
      { kind: 'convergence-turn-passed', from: principal, to: outcome.holder, round: outcome.round, at: envelope.meta.at },
      // Peer slice 2: a derived convenience nudge to the new holder ONLY —
      // never load-bearing, the WAL event above is authoritative.
      { kind: 'message-sent', id: `${envelope.meta.id}-n0`, from: BROKER_SENDER, to: outcome.holder, type: 'info', turn: 'keep', body: `the convergence turn is yours (round ${outcome.round}) — amend the draft, respond to findings, or yield`, at: envelope.meta.at, provenance: 'broker' },
    ]);
  }
  return ok([{ kind: 'convergence-halted', at: envelope.meta.at }]);
}

/** 1C settled-findings gate (§1c / 1B design). A finding gates the question
 * IFF its severity is HIGH|MED and it is NOT settled. Settled predicate
 * (EXACT): resolved|conceded|withdrawn -> settled; 'answered' -> settled IFF
 * the AUTHOR is departed (registry status 'left'); 'open' -> unsettled always.
 * LOW never gates. */
function isFindingSettled(f: Finding, registry: Registry): boolean {
  if (f.lifecycle === 'resolved' || f.lifecycle === 'conceded' || f.lifecycle === 'withdrawn') return true;
  if (f.lifecycle === 'answered') return registry.agents[f.author]?.status === 'left';
  return false; // open
}

/** 1C (§1c/§1d): call the question on the current draft. Any ELECTORATE
 * member, converging, no open ballot. Gates IN ORDER: not-in-electorate,
 * ballot-open, findings-unsettled (HIGH|MED), agenda-unaddressed, then the
 * task-block validation from the broker-stamped meta.draftBody. The ballot
 * snapshots the CURRENT rotation electorate and binds the CURRENT draft hash. */
function decideCallQuestion(s: SessionState, envelope: CommandEnvelope): Result<Event[], ProtocolError> {
  const gate = requireConverging(s, 'call-question');
  if (gate instanceof ProtocolError) return err(gate);
  const { peer, planning } = gate;
  const principal = envelope.meta.principal;
  if (!planning.rotation.electorate.includes(principal)) {
    return err(new ProtocolError('not-in-electorate', `'${principal}' is not in the barrier electorate — only electorate members may call the question.`));
  }
  if (planning.ballot) {
    return err(new ProtocolError('ballot-open', 'A ballot is already open — wait for it to close, or amend the draft to void it.'));
  }
  const unsettled = Object.values(planning.findings)
    .filter((f) => (f.severity === 'HIGH' || f.severity === 'MED') && !isFindingSettled(f, peer.registry))
    .map((f) => f.id);
  if (unsettled.length > 0) {
    return err(new ProtocolError('findings-unsettled', `The question cannot be called while HIGH/MED findings are unsettled: ${unsettled.join(', ')}.`));
  }
  const pending = planning.agenda.filter((a) => !a.addressed).map((a) => a.id);
  if (pending.length > 0) {
    return err(new ProtocolError('agenda-unaddressed', `The prior round's agenda is not fully addressed: ${pending.join(', ')} — address each (pair address-agenda) before re-calling.`));
  }
  // Task-block validation from the broker-stamped CURRENT draft body. A
  // caller cannot forge it (transport-boundary stamp like contentHash).
  const draftBody = envelope.meta.draftBody;
  if (draftBody === undefined) {
    return err(new ProtocolError('invalid-task-block', 'Internal: the draft body is missing (the broker stamps it).'));
  }
  const validated = validatePlanTaskBlock(draftBody);
  if (!validated.ok) {
    return err(new ProtocolError('invalid-task-block', validated.error));
  }
  const events: Event[] = [{
    kind: 'question-called',
    revision: planning.draft.revision,
    revisionHash: planning.draft.hash,
    electorate: [...planning.rotation.electorate],
    taskBlock: validated.value,
    calledBy: principal,
    at: envelope.meta.at,
  }];
  // Peer slice 2: a derived convenience nudge to every ballot-electorate
  // member — never load-bearing, the question-called event above is
  // authoritative.
  const prefix = planning.draft.hash.slice(0, 12);
  planning.rotation.electorate.forEach((agent, i) => {
    events.push({ kind: 'message-sent', id: `${envelope.meta.id}-n${i}`, from: BROKER_SENDER, to: agent, type: 'info', turn: 'keep', body: `a ballot is open on revision ${prefix} — vote approve/reject`, at: envelope.meta.at, provenance: 'broker' });
  });
  return ok(events);
}

/** 1C (§1c): each vote-cast additionally PROJECTS one @broker archive notice
 * per current agent — derived, never load-bearing (WAL is authoritative).
 * Deterministic ids `${meta.id}-v${i}`. */
function voteNotice(envelope: CommandEnvelope, to: AgentId, index: number, body: string): Extract<Event, { kind: 'message-sent' }> {
  return { kind: 'message-sent', id: `${envelope.meta.id}-v${index}`, from: BROKER_SENDER, to, type: 'info', turn: 'keep', body, at: envelope.meta.at, provenance: 'broker' };
}

/** 1C (§1c): cast a ballot vote. Gates IN ORDER: no-open-ballot,
 * not-in-electorate, already-voted, stale-ballot-revision, then reject
 * discipline (vote-reject-without-reason). A reject CLOSES the ballot
 * (unanimity impossible) and records the mandatory next-round agenda; the
 * final approve atomically passes the ballot AND transitions the phase. Every
 * vote projects @broker archive notices to all current agents. */
function decideVote(
  s: SessionState,
  command: Extract<Command, { kind: 'vote' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const gate = requireConverging(s, 'vote');
  if (gate instanceof ProtocolError) return err(gate);
  const { peer, planning } = gate;
  const ballot = planning.ballot;
  if (!ballot) {
    return err(new ProtocolError('no-open-ballot', 'There is no open ballot — call the question first (pair call-question).'));
  }
  const voter = envelope.meta.principal;
  if (!ballot.electorate.includes(voter)) {
    return err(new ProtocolError('not-in-electorate', `'${voter}' is not in this ballot's frozen electorate (${ballot.electorate.join(', ')}).`));
  }
  if (ballot.votes[voter] !== undefined) {
    return err(new ProtocolError('already-voted', `'${voter}' has already voted on this ballot — votes are final until the ballot closes.`));
  }
  if (command.revisionHash !== ballot.revisionHash) {
    return err(new ProtocolError('stale-ballot-revision', `Vote carries revision hash '${command.revisionHash}' but the ballot is bound to '${ballot.revisionHash}' — re-read the draft and re-vote.`));
  }
  const reasons = command.reasons?.trim() ?? '';
  if (!command.approve && reasons.length === 0) {
    return err(new ProtocolError('vote-reject-without-reason', 'A reject vote MUST carry non-blank reasons — they become the next round\'s mandatory agenda.'));
  }
  const events: Event[] = [{
    kind: 'vote-cast', voter, approve: command.approve, ...(command.approve ? {} : { reasons }), at: envelope.meta.at,
  }];
  if (!command.approve) {
    // Reject closes the ballot immediately and records the agenda; the round
    // cap pages the human (never auto-acts) when hit.
    events.push({ kind: 'ballot-closed', outcome: 'rejected', at: envelope.meta.at });
    events.push({ kind: 'agenda-recorded', items: [{ id: `${envelope.meta.id}-a0`, reason: reasons, from: voter, at: envelope.meta.at }], at: envelope.meta.at });
    if (planning.rotation.round >= ROUND_CAP) {
      events.push({ kind: 'attention-raised', id: `round-cap-${envelope.meta.id}`, category: 'round-cap', detail: `convergence exceeded the round cap (round ${planning.rotation.round}) — arbitrate, re-scope, or force the phase`, at: envelope.meta.at });
    }
  } else {
    const approvers = new Set([...Object.keys(ballot.votes), voter]);
    const unanimous = ballot.electorate.every((m) => approvers.has(m));
    if (unanimous) {
      // The FINAL approving vote atomically passes the ballot AND transitions
      // planning -> provisioning (there is NO separate plan-freeze command).
      events.push({ kind: 'ballot-passed', revision: ballot.revision, hash: ballot.revisionHash, taskBlock: ballot.taskBlock, at: envelope.meta.at });
      events.push({ kind: 'phase-transition', from: 'planning', to: 'provisioning', outcome: 'ballot-passed', at: envelope.meta.at });
    }
  }
  const prefix = ballot.revisionHash.slice(0, 12);
  const summary = `${voter} voted ${command.approve ? 'approve' : 'reject'} on revision ${prefix}`;
  peer.agents.forEach((agent, i) => events.push(voteNotice(envelope, agent, i, summary)));
  return ok(events);
}

/** 1C (§1c): mark a next-round agenda item addressed (any electorate member),
 * optionally linking the finding that addressed it. call-question stays
 * refused until every agenda item is addressed. */
function decideAddressAgenda(
  s: SessionState,
  command: Extract<Command, { kind: 'address-agenda' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const gate = requireConverging(s, 'address-agenda');
  if (gate instanceof ProtocolError) return err(gate);
  const { planning } = gate;
  const principal = envelope.meta.principal;
  if (!planning.rotation.electorate.includes(principal)) {
    return err(new ProtocolError('not-in-electorate', `'${principal}' is not in the barrier electorate — only electorate members may address agenda items.`));
  }
  if (!planning.agenda.some((a) => a.id === command.agendaId)) {
    return err(new ProtocolError('unknown-agenda-item', `No agenda item '${command.agendaId}' (see: pair status).`));
  }
  if (command.findingId !== undefined && planning.findings[command.findingId] === undefined) {
    return err(new ProtocolError('unknown-finding', `No finding '${command.findingId}' to link to agenda item '${command.agendaId}'.`));
  }
  return ok([{
    kind: 'agenda-addressed',
    agendaId: command.agendaId,
    ...(command.findingId === undefined ? {} : { findingId: command.findingId }),
    ...(command.note === undefined ? {} : { note: command.note }),
    at: envelope.meta.at,
  }]);
}

/** 1B collecting rulings (Ruling A: an empty-electorate abstain REJECTS
 * with no mutation — no event, no attention, no dedup record). */
function decideCollectingRuling(
  peer: SessionState & { topology: 'peer' },
  planning: Extract<NonNullable<import('./types.ts').PlanningState>, { substate: 'collecting' }>,
  command: Extract<Command, { kind: 'user-rule-absentee' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const isAbsentee = planning.barrier.openedMembers.includes(command.agent)
    && planning.submitted[command.agent] === undefined
    && !planning.abstained.includes(command.agent);
  if (!isAbsentee) return err(new ProtocolError('not-an-absentee', `'${command.agent}' is not an unruled non-submitter of this barrier.`));
  if (command.ruling === 'wait') {
    if (!command.newDeadlineAt) return err(new ProtocolError('not-an-absentee', "ruling 'wait' requires a new absolute deadline (-NewDeadlineAt)."));
    return ok([
      { kind: 'absentee-ruled', agent: command.agent, ruling: 'wait', newDeadlineAt: command.newDeadlineAt, at: envelope.meta.at },
      // Peer slice 2: a new deadline resolves whatever a prior expiry paged.
      ...clearDeadlineExpiredAttention(peer, envelope.meta.at),
      ...noticeFanout(peer, command, `USER RULED barrier absentee '${command.agent}': wait (new deadline ${command.newDeadlineAt}).`, envelope.meta.at),
    ]);
  }
  const effective = planning.barrier.openedMembers.filter((a) => a !== command.agent && !planning.abstained.includes(a));
  if (effective.length === 0) {
    return err(new ProtocolError('empty-electorate', `Abstaining '${command.agent}' would leave nobody in the electorate — wait, admit someone, or force the phase.`));
  }
  // Peer slice 2: does THIS abstain complete the barrier (every opened
  // member now submitted-or-abstained)? The actual reveal is computed by
  // the broker (#revealExtension, sealed-body verification); this mirrors
  // ONLY the completeness predicate, which needs no broker-private data.
  const submitted = new Set(Object.keys(planning.submitted));
  const abstainedAfter = new Set([...planning.abstained, command.agent]);
  const completing = planning.barrier.openedMembers.every((m) => submitted.has(m) || abstainedAfter.has(m));
  return ok([
    { kind: 'absentee-ruled', agent: command.agent, ruling: 'abstain', at: envelope.meta.at },
    ...(completing ? clearDeadlineExpiredAttention(peer, envelope.meta.at) : []),
    ...noticeFanout(peer, command, `USER RULED barrier absentee '${command.agent}': abstain — the barrier reveals without them; they remain an authorized observer.`, envelope.meta.at),
  ]);
}

/** Peer slice 2: a wait ruling that sets a NEW deadline, or an abstain
 * ruling that closes the barrier, clears any existing 'deadline-expired'
 * attention item in the SAME txn — the situation the watcher paged is
 * resolved. Pure: reads state.attention only (never touches the watcher). */
function clearDeadlineExpiredAttention(peer: SessionState & { topology: 'peer' }, at: string): Event[] {
  return peer.attention
    .filter((item) => item.category === 'deadline-expired')
    .map((item) => ({ kind: 'attention-cleared' as const, id: item.id, at }));
}

function noticeFanout(
  peer: SessionState & { topology: 'peer' },
  command: Extract<Command, { kind: 'user-rule-absentee' }>,
  text: string,
  at: string,
): Event[] {
  return peer.agents.map((agent, i) => userActionNotice(command, agent, i, 'rule-absentee', 'info', text, at));
}

function decideUserForcePhase(
  s: SessionState,
  command: Extract<Command, { kind: 'user-force-phase' }>,
  envelope: CommandEnvelope,
): Result<Event[], ProtocolError> {
  const bad = requireUserPrincipal(envelope, 'user-force-phase');
  if (bad) return err(bad);
  const peer = requirePeer(s, 'user-force-phase');
  if (peer instanceof ProtocolError) return err(peer);
  // Bounded (rev 3): only planning->provisioning is forceable — no phase
  // can exist before its substrate (implementation needs the slice-4 saga).
  if (!(peer.phase === 'planning' && command.to === 'provisioning')) {
    return err(new ProtocolError('phase-unavailable', `Forcing ${peer.phase} -> ${command.to} is unavailable: only planning -> provisioning until the slice-4 branch saga exists.`));
  }
  const reasonSuffix = command.reason ? ` Reason: ${command.reason}` : '';
  const events: Event[] = [{ kind: 'phase-transition', from: 'planning', to: 'provisioning', outcome: 'forced', ...(command.reason ? { reason: command.reason } : {}), at: envelope.meta.at }];
  peer.agents.forEach((agent, i) => {
    events.push(userActionNotice(command, agent, i, 'force-phase', 'info', `USER FORCED the phase to provisioning (outcome: FORCED — this is not a ballot pass).${reasonSuffix}`, envelope.meta.at));
  });
  return ok(events);
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
  appendAdmittingCompletion(s, command.agent, events, envelope.meta.at);
  if (s.topology === 'peer') {
    appendFindingsDepartureAttention(s, command.agent, events, command.noticeIdBase, envelope.meta.at);
    appendBallotStallAttention(s, command.agent, events, command.noticeIdBase, envelope.meta.at);
    appendConvergenceHolderDeparture(s, command.agent, events, envelope.meta.at);
  }
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
    messageEvent(envelope, agent, sessionAnchor(s), 'leave', `${agent} left the session.`),
  ];
  appendAdmittingCompletion(s, agent, events, envelope.meta.at);
  if (s.topology === 'pair' && s.turn === agent) events.push({ kind: 'turn-passed', to: s.driver }); // F17: same txn
  if (s.topology === 'peer') {
    appendFindingsDepartureAttention(s, agent, events, envelope.meta.id, envelope.meta.at);
    appendBallotStallAttention(s, agent, events, envelope.meta.id, envelope.meta.at);
    appendConvergenceHolderDeparture(s, agent, events, envelope.meta.at);
  }
  return ok(events);
}

/** 1B-c: a departure while converging/blocked strands the departed agent's
 * open|answered findings — raise ONE aggregate attention item per departure
 * (durable; the human clears it once the block is understood). */
function appendFindingsDepartureAttention(s: SessionState, agent: AgentId, events: Event[], idSeed: string, at: string): void {
  if (s.topology !== 'peer') return;
  const planning = s.planning;
  if (!planning || (planning.substate !== 'converging' && planning.substate !== 'convergence-blocked')) return;
  const blocked = Object.values(planning.findings)
    .filter((f) => (f.author === agent || f.addressedTo === agent) && (f.lifecycle === 'open' || f.lifecycle === 'answered'))
    .map((f) => f.id);
  if (blocked.length === 0) return;
  const shown = blocked.slice(0, 5);
  const more = blocked.length - shown.length;
  const detail = `${blocked.length} finding${blocked.length === 1 ? '' : 's'} blocked by ${agent}'s departure: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
  events.push({ kind: 'attention-raised', id: `fblock-${agent}-${idSeed}`, category: 'findings-blocked', detail, at });
}

/** 1C: a leave/kick of an OPEN ballot's electorate member stalls the vote —
 * unanimity cannot complete without a rejoin+vote (or a user force-phase).
 * Raise a durable attention item; the ballot REMAINS open (fixed-electorate
 * ruling — a post-call departure is an abstention that pages, never a silent
 * shrink). */
function appendBallotStallAttention(s: SessionState, agent: AgentId, events: Event[], idSeed: string, at: string): void {
  if (s.topology !== 'peer' || s.planning?.substate !== 'converging') return;
  const ballot = s.planning.ballot;
  if (!ballot || !ballot.electorate.includes(agent)) return;
  events.push({ kind: 'attention-raised', id: `ballot-stall-${agent}-${idSeed}`, category: 'ballot-stalled', detail: `${agent} left with a ballot open — unanimity cannot complete until they rejoin and vote, or the user forces the phase.`, at });
}

/** 1B-c: when the departing agent HELD the convergence turn, the same txn
 * advances the rotation (Ruling B) — passing `leaving` so decide (registry
 * still shows the departer active) matches evolve (registry shows it left).
 * A non-holder member's departure needs no event: it is skipped at the next
 * advance. */
function appendConvergenceHolderDeparture(s: SessionState, agent: AgentId, events: Event[], at: string): void {
  if (s.topology !== 'peer' || s.planning?.substate !== 'converging') return;
  if (s.planning.rotation.holder !== agent) return;
  const outcome = advanceRotation(s.planning.rotation, s.registry, agent);
  if (outcome.kind === 'passed') {
    events.push({ kind: 'convergence-turn-passed', from: agent, to: outcome.holder, round: outcome.round, at });
  } else {
    events.push({ kind: 'convergence-halted', at });
  }
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
  const badMeta = validateAgentMeta(command.meta, command.agent);
  if (badMeta) return err(badMeta);
  return ok([
    { kind: 'agent-joined', agent: command.agent, at: envelope.meta.at },
    { kind: 'registry-updated', version: s.registry.version + 1, change: 'joined', agent: command.agent, at: envelope.meta.at, ...(command.meta === undefined ? {} : { meta: command.meta }) },
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
  if (command.topology !== undefined && command.topology !== 'pair' && command.topology !== 'peer') {
    return err(new ProtocolError('invalid-agents', `unknown topology '${String(command.topology)}' (pair | peer)`));
  }
  // Peer slice 2: -DeadlineAt seeds admitting.deadlineAt. Format-validated
  // only here (no automatic default — a deadline exists ONLY when someone
  // explicitly asked for one, at init or via a later 'wait' ruling).
  if (command.deadlineAt !== undefined && !DEADLINE_PATTERN.test(command.deadlineAt)) {
    return err(new ProtocolError('invalid-agents', `-DeadlineAt must match 'YYYY-MM-DD HH:mm:ss' (got '${command.deadlineAt}')`));
  }
  // M1 round 2 (codex): session identity is an INVARIANT of every NEW
  // session — only genuinely legacy state (replayed events, old mirrors)
  // may lack it. Every ingress must mint or supply one.
  if (command.sessionId === undefined || !SESSION_ID_PATTERN.test(command.sessionId)) {
    return err(new ProtocolError('invalid-session-id', 'init requires a sessionId of 8-64 letters/digits/dashes - the CLI mints one; direct callers must supply their own.'));
  }
  for (const [id, meta] of Object.entries(command.meta ?? {})) {
    if (!agents.includes(id)) return err(new ProtocolError('invalid-agents', `meta declared for unknown agent '${id}'`));
    const bad = validateAgentMeta(meta, id);
    if (bad) return err(bad);
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
    { kind: 'session-initialized', task: command.task, agents, driver: command.driver, at, ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }), ...(command.meta === undefined ? {} : { meta: command.meta }), ...(command.topology === undefined ? {} : { topology: command.topology }), ...(command.deadlineAt === undefined ? {} : { deadlineAt: command.deadlineAt }) },
    { kind: 'registry-updated', version: 1, change: 'init', at },
  ]);
}

/** Peer slice 2: the -DeadlineAt / -NewDeadlineAt wire format — an absolute
 * local timestamp, same shape as Clock.now(). */
const DEADLINE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** M1: bounded, control-safe per-agent config validation (fail-closed). */
function validateAgentMeta(meta: import('./types.ts').AgentMeta | undefined, agent: string): ProtocolError | undefined {
  if (!meta) return undefined;
  // Round 2: unknown keys are rejected, not ignored - transport casts
  // arbitrary JSON into this shape (fail-closed like MessageType).
  for (const key of Object.keys(meta)) {
    if (key !== 'display' && key !== 'cliType' && key !== 'role') {
      return new ProtocolError('invalid-agents', `unknown meta property '${key}' for '${agent}' (allowed: display, cliType, role)`);
    }
  }
  if (meta.display !== undefined && !DISPLAY_PATTERN.test(meta.display)) {
    return new ProtocolError('invalid-agents', `display for '${agent}' must be 1-64 printable characters (control codes rejected)`);
  }
  for (const [field, value] of [['cliType', meta.cliType], ['role', meta.role]] as const) {
    if (value !== undefined && !AGENT_NAME_PATTERN.test(value)) {
      return new ProtocolError('invalid-agents', `${field} for '${agent}' must be a lowercase identifier (letter first, letters/digits/dash/underscore, max 16 chars)`);
    }
  }
  return undefined;
}

const PEER_GRANTS = 'Grants are pair-topology machinery; peer work authorization is claims (slice 3).';

/** The union-safe notice anchor: pair notices route to the driver, peer
 * notices to the initiator (the only standing identity a peer session has). */
function sessionAnchor(s: SessionState): AgentId {
  return s.topology === 'pair' ? s.driver : s.initiator;
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
  // 1B: reveal manifests are broker-authored ONLY — no topology may send
  // type 'proposal' (spoofed reveal artifacts, design rev 3 #8).
  if (command.type === 'proposal') {
    return err(new ProtocolError('broker-authored-type', "'proposal' messages are broker-authored reveal manifests and cannot be sent by agents."));
  }
  // U1: the user reads via the transcript; agents get no user inbox (v1).
  if (command.to === USER_IDENTITY) {
    return err(new ProtocolError('user-not-addressable', `'${USER_IDENTITY}' is a reserved identity and cannot receive messages (v1); the user reads the transcript via pair watch.`));
  }
  if (s.topology === 'peer') {
    if (command.type === 'handoff' || command.type === 'done' || command.type === 'propose-end') {
      return err(new ProtocolError('no-driver-authority', `'${command.type}' is pair-topology machinery; peer sessions have no driver to ${command.type === 'handoff' ? 'hand off to' : 'petition'}.`));
    }
    if (command.turn === 'pass') {
      // 1A: only the admitting substate exists — there is no turn token
      // yet. The convergence rotation lands with 1C; until then all peer
      // traffic is -Turn keep.
      return err(new ProtocolError('no-turn-in-phase', 'This peer phase has no turn token; send with -Turn keep.'));
    }
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
