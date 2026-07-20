import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Command, GrantScopeInput } from '@core/commands.ts';
import { resolveRecipient } from '@core/queries.ts';
import { MAX_AGENTS, type AgentId, type MessageType, type TurnMode } from '@core/types.ts';
import type { ExecuteOutcome, StatusDto } from '@app/ports/gateway.ts';
import { systemClock, systemIds } from '@adapters/clock/index.ts';
import { BrokerGateway, BrokerWireError } from './brokerGateway.ts';
import { nextDelivery, printDeliveryThenAck } from './brokerWait.ts';
import { has, num, str } from './args.ts';
import { loadOrCreateAgentCredential } from './credentialStore.ts';

type Flags = Map<string, string | true>;
const out = (text: string) => process.stdout.write(`${text}\n`);

/** Structural gateway surface the CLI needs — lets tests inject a fake
 * (codex regression seam, 20260720-101911-628). BrokerGateway satisfies it. */
export type CliGateway = import('@app/ports/gateway.ts').ProtocolGateway &
  import('@app/ports/gateway.ts').BrokerControl & { readonly clientId: string };

export async function runBrokerCli(
  command: string, flags: Flags, positionals: string[], root: string,
  gatewayFactory: (root: string) => CliGateway = BrokerGateway.forRoot,
): Promise<number | undefined> {
  if (command === 'watch' || command === 'help') return undefined;
  const gateway = gatewayFactory(root);
  try {
    if (command === 'broker') {
      const action = (positionals[0] ?? 'status').toLowerCase();
      if (action === 'status') { const s = await gateway.brokerStatus(); out(s.running ? `Broker running pid=${s.pid} epoch=${s.epoch} endpoint=${s.endpoint} connections=${s.connections ?? 0}` : 'Broker not running.'); return 0; }
      if (action === 'stop') { await gateway.stop(); out('Broker stopping cleanly.'); return 0; }
      throw new Error("pair broker requires 'status' or 'stop'");
    }
    // INVARIANT (root-caused 2026-07-20): every promise returned from inside
    // this try MUST be `return await`ed. A bare `return <promise>` runs the
    // finally's gateway.close() CONCURRENTLY with the returned work, which
    // destroys the socket under a just-armed fused/standalone wait
    // ('IPC connection closed', codex finding 20260720-101816-882).
    if (command === 'ask') { flags.set('type', 'ask'); flags.set('from', str(flags, 'from') ?? str(flags, 'as') ?? ''); return await runBrokerCli('send', flags, positionals, root, gatewayFactory); }
    if (command === 'propose-end') {
      required(flags, 'from', 'propose-end requires -From <you>');
      const status = await gateway.status();
      flags.set('to', status.session.driver ?? ''); flags.set('type', 'propose-end'); flags.set('turn', 'keep'); // peer: decide rejects with no-driver-authority
      return await runBrokerCli('send', flags, positionals, root, gatewayFactory);
    }
    if (command === 'init') {
      const task = required(flags, 'task', "init requires -Task '<what the agents are building>'");
      // M1 ids-vs-display + per-agent config: each -Agents token is
      // `id[=Display Name[=cliType[=role]]]` — the id stays filesystem-safe;
      // display is presentation-only; cliType/role are identifiers.
      const tokens = (str(flags, 'agents') ?? 'claude,codex').split(',').map((t) => t.trim()).filter(Boolean);
      const agents = tokens.map((t) => t.split('=')[0]!.trim().toLowerCase());
      const meta = Object.fromEntries(tokens.flatMap((t) => {
        const [id, display, cliType, role] = t.split('=').map((p) => p.trim());
        const m = { ...(display ? { display } : {}), ...(cliType ? { cliType: cliType.toLowerCase() } : {}), ...(role ? { role: role.toLowerCase() } : {}) };
        return Object.keys(m).length ? [[id!.toLowerCase(), m]] : [];
      }));
      const driver = (str(flags, 'driver') ?? 'claude').toLowerCase();
      // M1: session identity is minted HERE, once, at init (deferred from item 7).
      const sessionId = randomUUID();
      // Peer 1A: -Topology peer opens the admitting bootstrap; the INIT
      // carries the initiator's own credential at the transport edge.
      const topology = (str(flags, 'topology') ?? 'pair').toLowerCase() as 'pair' | 'peer';
      let credential: string | undefined;
      if (topology === 'peer') {
        const cred = await loadOrCreateAgentCredential(root, driver);
        if (cred.kind === 'error') throw new Error(`initiator credential: ${cred.detail}`);
        credential = cred.token;
      }
      // Pair inits OMIT topology entirely — the pre-peer event shape is a
      // byte-identity contract (codex 1A round 2 #7).
      const r = await execute(gateway, driver, { kind: 'init-session', task, agents, driver, sessionId, ...(topology === 'peer' ? { topology } : {}), ...(Object.keys(meta).length ? { meta } : {}) }, credential);
      if (r.gitignoreUpdated) out('Added .pair/ to .gitignore.');
      out(`Pairing session initialized in ${join(root, '.pair')}`);
      out(`  Task:      ${task}`); out(`  Agents:    ${r.session.agents.join(', ')}`);
      out(`  Driver:    ${driver}    Navigators: ${r.session.agents.filter((a) => a !== driver).join(', ')}    Turn: ${driver}`);
      return 0;
    }
    if (command === 'send') {
      const from = required(flags, 'from', 'send requires -From <you> — never impersonate a partner').toLowerCase();
      const type = (str(flags, 'type') ?? 'info').toLowerCase() as MessageType;
      const turn = (str(flags, 'turn') ?? 'pass').toLowerCase() as TurnMode;
      let to = str(flags, 'to')?.toLowerCase();
      if (!to) { const status = await gateway.status(); to = resolveRecipient(status.session, from); if (!to) throw new Error(`Ambiguous recipient: specify -To explicitly`); }
      const replyTo = str(flags, 'replyto');
      const r = await execute(gateway, from, { kind: 'send-message', to, type, turn, body: await bodyFrom(flags), ...(replyTo ? { replyTo } : {}) });
      const sent = r.events.find((e) => e.kind === 'message-sent' && e.from === from);
      const sentTo = sent?.kind === 'message-sent' ? sent.to : to;
      out(`Sent ${type} -> ${sentTo} (${r.receipt.messageFiles[0] ?? ''}). Turn: ${r.session.turn}. Driver: ${r.session.driver}. Status: ${r.session.status}.`);
      const fuse = turn === 'pass' && type !== 'done' && !has(flags, 'nowait') && r.session.status === 'active';
      if (!fuse) { if (turn === 'pass' && r.session.status === 'active') out(`You handed over the turn. Now block on: pair wait -As ${from}`); return 0; }
      out('You handed over the turn. Waiting for the reply (-NoWait skips the fused wait).');
      // Item 7: a fused ASK waits on its own thread — the sent message id.
      // Without this the first unrelated delivery ended the fused ask, and a
      // timeout re-arm lost the thread entirely (codex blocker 1).
      const fusedThread = type === 'ask' && sent?.kind === 'message-sent' ? sent.id : undefined;
      return await waitBroker(gateway, from, num(flags, 'timeoutsec', Infinity), true, fusedThread);
    }
    if (command === 'attach') {
      // Peer 1A: bind THIS connection as the agent using its own stored
      // (or freshly minted) credential; -Regenerate mints anew post-rebind.
      const as = required(flags, 'as', 'attach requires -As <your own agent name>').toLowerCase();
      if (gateway.agentAttach === undefined) throw new Error('attach requires the broker gateway.');
      const cred = await loadOrCreateAgentCredential(root, as, { regenerate: has(flags, 'regenerate') });
      if (cred.kind === 'error') throw new Error(`agent credential: ${cred.detail}`);
      const bound = await gateway.agentAttach(as, cred.token);
      out(`${bound.agent} attached (credential v${bound.credentialVersion})${bound.admitted ? ' and is ADMITTED' : ''}. The credential is provisioned in your store; every pair command auto-attaches on its own connection from now on.`);
      return 0;
    }
    if (command === 'propose') {
      // 1B: sealed blind proposal — the body crosses once at the transport
      // edge and is journaled only in the record's sealed field.
      const as = required(flags, 'as', 'propose requires -As <your own agent name>').toLowerCase();
      const r = await execute(gateway, as, { kind: 'propose', content: await bodyFrom(flags) });
      const sub = r.events.find((e) => e.kind === 'proposal-submitted');
      const revealed = r.events.some((e) => e.kind === 'barrier-revealed');
      out(`Proposal sealed (${sub?.kind === 'proposal-submitted' ? `${sub.bytes} bytes, sha256 ${sub.contentHash}` : 'committed'}).${revealed ? ' Your submission CLOSED the barrier — proposals are revealed; read them with: pair artifacts' : ' It stays blind until every opened member submits or is ruled.'}`);
      return 0;
    }
    if (command === 'draft') {
      // 1B-b: the living draft — holder-only, optimistic-concurrency
      // amendment. -BaseRevision must be the revision you last read;
      // stale-draft-revision rejects otherwise (re-read with: pair artifacts).
      const as = required(flags, 'as', 'draft requires -As <your own agent name>').toLowerCase();
      const baseRevisionRaw = required(flags, 'baserevision', 'draft requires -BaseRevision <n> (the draft revision you last read)');
      const baseRevision = Number(baseRevisionRaw);
      if (!Number.isInteger(baseRevision) || baseRevision < 0) throw new Error('-BaseRevision must be a non-negative integer');
      const r = await execute(gateway, as, { kind: 'draft-amend', content: await bodyFrom(flags), baseRevision });
      const amended = r.events.find((e) => e.kind === 'draft-amended');
      out(amended?.kind === 'draft-amended'
        ? `Draft amended to revision ${amended.revision} (sha256 ${amended.hash}).`
        : 'Draft amended.');
      return 0;
    }
    if (command === 'critique') {
      // 1B-c: file a finding against a draft revision or a rival proposal
      // (converging, electorate member only). The addressee is DERIVED from
      // the anchor — never claimed.
      const as = required(flags, 'as', 'critique requires -As <your own agent name>').toLowerCase();
      const draftRev = str(flags, 'draft');
      const proposal = str(flags, 'proposal');
      if ((draftRev === undefined) === (proposal === undefined)) throw new Error('critique requires exactly one of -Draft <revision> or -Proposal <author>');
      let anchor: import('@core/types.ts').Finding['anchor'];
      if (draftRev !== undefined) {
        const revision = Number(draftRev);
        if (!Number.isInteger(revision) || revision < 0) throw new Error('-Draft must be a non-negative integer revision');
        anchor = { kind: 'draft', revision };
      } else {
        anchor = { kind: 'proposal', author: proposal!.toLowerCase() };
      }
      const severity = (str(flags, 'severity') ?? '').toUpperCase();
      if (severity !== 'HIGH' && severity !== 'MED' && severity !== 'LOW') throw new Error('critique requires -Severity HIGH|MED|LOW');
      const agreement = (str(flags, 'agreement') ?? '').toLowerCase();
      if (agreement !== 'agreed' && agreement !== 'partial' && agreement !== 'disputed') throw new Error('critique requires -Agreement agreed|partial|disputed');
      const r = await execute(gateway, as, { kind: 'critique', anchor, severity, agreement, text: await bodyFrom(flags) });
      const filed = r.events.find((e) => e.kind === 'finding-filed');
      out(filed?.kind === 'finding-filed'
        ? `Finding ${filed.id} filed against ${filed.addressedTo} (${filed.severity}/${filed.agreement}).`
        : 'Finding filed.');
      return 0;
    }
    if (command === 'respond') {
      const as = required(flags, 'as', 'respond requires -As <your own agent name>').toLowerCase();
      const findingId = required(flags, 'id', 'respond requires -Id <findingId>');
      const disposition = (str(flags, 'disposition') ?? '').toLowerCase();
      if (disposition !== 'resolve' && disposition !== 'concede' && disposition !== 'dispute') throw new Error('respond requires -Disposition resolve|concede|dispute');
      const r = await execute(gateway, as, { kind: 'respond-critique', findingId, disposition, text: await bodyFrom(flags) });
      const ev = r.events.find((e) => e.kind === 'finding-responded');
      out(ev?.kind === 'finding-responded' ? `Responded to ${findingId} (${ev.disposition}).` : 'Responded.');
      return 0;
    }
    if (command === 'confirm') {
      const as = required(flags, 'as', 'confirm requires -As <your own agent name>').toLowerCase();
      const findingId = required(flags, 'id', 'confirm requires -Id <findingId>');
      const verdict = (str(flags, 'verdict') ?? '').toLowerCase();
      if (verdict !== 'accept' && verdict !== 'contest') throw new Error('confirm requires -Verdict accept|contest');
      const setDisputed = has(flags, 'setdisputed');
      const r = await execute(gateway, as, { kind: 'confirm-critique', findingId, verdict, text: await bodyFrom(flags), ...(setDisputed ? { setDisputed: true } : {}) });
      const ev = r.events.find((e) => e.kind === 'finding-confirmed');
      out(ev?.kind === 'finding-confirmed' ? `Confirmed ${findingId} (${ev.verdict}).` : 'Confirmed.');
      return 0;
    }
    if (command === 'withdraw') {
      // amend-critique withdraw — text is optional (a bare withdraw).
      const as = required(flags, 'as', 'withdraw requires -As <your own agent name>').toLowerCase();
      const findingId = required(flags, 'id', 'withdraw requires -Id <findingId>');
      const text = (str(flags, 'file') || str(flags, 'message')) ? await bodyFrom(flags) : undefined;
      const r = await execute(gateway, as, { kind: 'amend-critique', findingId, action: 'withdraw', ...(text ? { text } : {}) });
      const ev = r.events.find((e) => e.kind === 'finding-amended');
      out(ev?.kind === 'finding-amended' ? `Withdrew ${findingId}.` : 'Withdrawn.');
      return 0;
    }
    if (command === 'yield') {
      // 1B-c: the convergence holder passes the turn (must-respond gate first).
      const as = required(flags, 'as', 'yield requires -As <your own agent name>').toLowerCase();
      const r = await execute(gateway, as, { kind: 'yield-turn' });
      const passed = r.events.find((e) => e.kind === 'convergence-turn-passed');
      const halted = r.events.some((e) => e.kind === 'convergence-halted');
      out(passed?.kind === 'convergence-turn-passed'
        ? `Turn passed to ${passed.to} (round ${passed.round}).`
        : halted
          ? 'Convergence HALTED — no live successor; a member must rejoin or the user forces the phase.'
          : 'Turn yielded.');
      return 0;
    }
    if (command === 'artifacts') {
      if (gateway.planningArtifacts === undefined) throw new Error('artifacts requires the broker gateway.');
      renderArtifacts(await gateway.planningArtifacts());
      return 0;
    }
    if (command === 'wait') return await waitBroker(gateway, required(flags, 'as', 'wait requires -As <your own agent name>').toLowerCase(), num(flags, 'timeoutsec', 300), false, str(flags, 'thread'));
    if (command === 'status') { renderStatus(await gateway.status()); return 0; }
    if (command === 'log') {
      const thread = str(flags, 'thread');
      // Item 7 round 2: -Thread fetches the FULL archive — any horizon can
      // orphan a chain member and silently truncate the thread.
      const messages = await gateway.log(thread ? Number.MAX_SAFE_INTEGER : num(flags, 'tail', 10));
      const selected = thread ? threadChain(messages, thread) : messages;
      if (!selected.length) out(thread ? `No archived messages in thread ${thread}.` : 'No archived messages yet.');
      for (const m of selected) out(`${'='.repeat(66)}\n${m.name}\n${'-'.repeat(66)}\n${m.raw}`);
      return 0;
    }
    if (command === 'grants') { const grants = [...await gateway.grants()].sort((a, b) => a.id.localeCompare(b.id)); if (has(flags, 'json')) out(JSON.stringify(grants, null, 2)); else if (!grants.length) out('No grants in this session.'); else for (const g of grants) { out(`${g.id}  [${g.state}]  ${g.issuer} -> ${g.assignee}  ${g.scope.mode === 'worktree' ? `worktree ${g.scope.worktree}` : `files: ${g.scope.files.join(', ')}`}`); out(`    task: ${g.task}${g.result ? `\n    result: ${g.result}` : ''}`); } return 0; }
    if (command === 'revoke-turn') {
      const from = required(flags, 'from', 'revoke-turn requires -From <driver>').toLowerCase();
      if (!has(flags, 'confirmunresponsive')) throw new Error('revoke-turn requires -ConfirmUnresponsive: explicitly attest that the turn holder is unresponsive.');
      const r = await execute(gateway, from, { kind: 'revoke-turn', reason: str(flags, 'reason') ?? '' });
      const revoked = r.events.find((e) => e.kind === 'turn-revoked');
      out(`Turn revoked from ${revoked?.kind === 'turn-revoked' ? revoked.from : 'partner'}; ${from} now holds the turn. Broker liveness guard verified there was no live delivery lease.`); return 0;
    }
    if (command === 'leave') { const as = required(flags, 'as', 'leave requires -As <you>').toLowerCase(); await execute(gateway, as, { kind: 'leave-session' }); out(`${as} left the session.`); return 0; }
    if (command === 'join') {
      const from = required(flags, 'from', 'join requires -From <driver>').toLowerCase();
      const agent = required(flags, 'agent', 'join requires -Agent <name>').toLowerCase();
      // M1 per-agent config at admission time.
      const display = str(flags, 'display'); const cliType = str(flags, 'clitype'); const role = str(flags, 'role');
      const meta = { ...(display ? { display } : {}), ...(cliType ? { cliType: cliType.toLowerCase() } : {}), ...(role ? { role: role.toLowerCase() } : {}) };
      await execute(gateway, from, { kind: 'join-session', agent, ...(Object.keys(meta).length ? { meta } : {}) });
      out(`${agent} joined the session. Earlier deliveries are not replayed; the rejoined agent starts with a fresh cursor.`);
      return 0;
    }
    if (command === 'kick') { const from = required(flags, 'from', 'kick requires -From <driver>').toLowerCase(); const agent = required(flags, 'agent', 'kick requires -Agent <name>').toLowerCase(); await execute(gateway, from, { kind: 'kick-agent', agent, reason: str(flags, 'reason') ?? '' }); out(`${agent} was removed from the session; its pending deliveries were voided.`); return 0; }
    if (command === 'end') {
      const as = required(flags, 'as', 'end requires -As <your own agent name>').toLowerCase();
      const summary = str(flags, 'file') || str(flags, 'message') ? await bodyFrom(flags) : 'Session ended.';
      const r = await execute(gateway, as, { kind: 'end-session', summary });
      const memory = join(root, '.pair', 'memory.md');
      await Bun.write(memory, `${await Bun.file(memory).text()}\n## Session ended ${systemClock.now()} by ${as}\n\n${summary}`);
      out(`Session completed. Final summary appended to memory.md and sent to ${r.session.agents.filter((a) => a !== as).join(', ')} (${r.receipt.messageFiles.join(', ')}).`); return 0;
    }
    if (command === 'grant') {
      const from = required(flags, 'from', 'grant requires -From <driver>').toLowerCase(); const to = required(flags, 'to', 'grant requires -To <assignee>').toLowerCase();
      const worktree = str(flags, 'worktree'); const filesRaw = str(flags, 'files');
      const scope: GrantScopeInput = worktree ? { mode: 'worktree', worktree } : { mode: 'files', files: (filesRaw ?? '').split(','), riskAccepted: has(flags, 'acceptsharedworktreerisk') };
      const grantId = `g${systemIds.messageId()}-${to}`;
      await execute(gateway, from, { kind: 'issue-grant', grantId, to, task: str(flags, 'taskdesc') ?? '', scope, agreedIn: str(flags, 'agreedin') ?? '' });
      out(`Grant ${grantId} offered to ${to} (${scope.mode} scope). The conversation turn is unaffected.`); return 0;
    }
    if (command === 'grant-accept' || command === 'grant-done' || command === 'grant-cancel') {
      const as = required(flags, 'as', `${command} requires -As <you>`).toLowerCase(); const grantId = required(flags, 'id', `${command} requires -Id <grant id>`);
      const cmd: Command = command === 'grant-accept' ? { kind: 'accept-grant', grantId } : command === 'grant-done' ? { kind: 'complete-grant', grantId, result: await bodyFrom(flags) } : { kind: 'cancel-grant', grantId, reason: str(flags, 'message') ?? '' };
      const r = await execute(gateway, as, cmd); const g = r.session.grants[grantId];
      out(command === 'grant-accept' ? `Grant ${grantId} is ACTIVE. You may edit strictly within its scope (${g?.scope.mode}); finish with: pair grant-done -As ${as} -Id ${grantId} -Message '<result>'` : command === 'grant-done' ? `Grant ${grantId} done; issuer ${g?.issuer} notified. Stop editing its scope now.` : `Grant ${grantId} cancelled; ${g?.assignee} notified.`); return 0;
    }
    return undefined;
  } finally { await gateway.close(); }
}

async function execute(gateway: CliGateway, as: AgentId, command: Command, credential?: string): Promise<ExecuteOutcome> { return gateway.execute({ as, command, identity: { clientId: gateway.clientId, reqId: randomUUID() }, ...(credential === undefined ? {} : { credential }) }); }

async function waitBroker(gateway: CliGateway, as: AgentId, timeoutSec: number, fused: boolean, threadId?: string): Promise<number> {
  const status = await gateway.status();
  if (!status.session.agents.includes(as)) throw new Error(`'${as}' is not a participant in this session`);
  const subscription = await gateway.subscribe(as, 0);
  try {
    return await waitOnSubscription(gateway, subscription, as, timeoutSec, fused, threadId);
  } catch (error) {
    // Slice 4 (design REV 6): a user kick terminates this wait — terminal
    // wording, exit 0, NO re-arm hint, never reconnect churn.
    if (error instanceof BrokerWireError && error.code === 'credential-revoked') {
      out('='.repeat(66));
      out(`YOUR CREDENTIAL WAS REBOUND by the user. Recover with: pair attach -As ${as} -Regenerate  — then re-arm this wait.`);
      return 2;
    }
    if (error instanceof BrokerWireError && error.code === 'removed-from-session') {
      out('='.repeat(66));
      out(`YOU WERE REMOVED FROM THE SESSION by the user. Stop all work immediately; do not re-arm this wait and do not send. Report to your human.`);
      return 0;
    }
    throw error;
  } finally { await subscription.close(); }
}

async function waitOnSubscription(gateway: CliGateway, subscription: Awaited<ReturnType<CliGateway['subscribe']>>, as: AgentId, timeoutSec: number, fused: boolean, threadId?: string): Promise<number> {
  // Item 7: -Thread <messageId> — every delivery still prints and acks
  // normally (at-least-once consumption is unchanged); the wait simply
  // EXITS only when the reply to that specific message arrives.
  // A timeout re-arm must preserve the thread scope (codex blocker 1).
  const rearm = `pair wait -As ${as} -TimeoutSec ${timeoutSec}${threadId ? ` -Thread ${threadId}` : ''}`;
  for (;;) {
    const delivery = await nextDelivery(subscription, timeoutSec);
    if (!delivery) { if (fused) { out('SEND ALREADY COMMITTED — do NOT re-send.'); out(`No reply after ${timeoutSec}s; your partner is likely still working.`); out(`NEXT: ${rearm}`); } else out(`No message after ${timeoutSec}s; your partner is likely still working. Re-run: ${rearm}`); return 2; }
    await printDeliveryThenAck(delivery, subscription);
    const header = delivery.message.header;
    // Item 7 (codex blocker 5): user-channel traffic must WAKE a
    // thread-scoped wait — the harness has to act on the user's input NOW.
    // It never resolves the thread. Seam: future control notices
    // (phase/lease) belong on this exit too.
    if (threadId && (header.provenance === 'trusted_user_client' || header.actionKind !== undefined)) {
      const s = await gateway.status();
      renderTurn(s, as);
      if (s.session.agents.includes(as) && s.session.status !== 'completed') out(`Thread ${threadId} is NOT resolved by this — after handling the user input above, re-arm: pair wait -As ${as} -Thread ${threadId}`);
      return 0;
    }
    if (threadId) {
      // Round 3 (codex): resolution may arrive UNTAGGED (compat rule), so
      // consult the authoritative awaiting-set on EVERY non-control
      // delivery — exit iff the watched ask disappeared from a PRESENT
      // set. An absent set is NOT confirmation: fail closed, keep armed.
      const s = await gateway.status();
      if (s.awaiting === undefined) {
        out(`(cannot confirm thread ${threadId}: this broker reports no awaiting-set; still listening — check pair status manually)`);
        continue;
      }
      if (!s.awaiting.some((a) => a.messageId === threadId)) { renderTurn(s, as); return 0; }
      out(header.replyTo === threadId
        ? `(a reply candidate named thread ${threadId} but did not resolve the ask — wrong type or endpoints; still listening)`
        : `(waiting on thread ${threadId} — the above did not resolve it; still listening)`);
      continue;
    }
    renderTurn((await gateway.status()), as); return 0;
  }
}

function renderStatus(s: StatusDto) { out(`Task:      ${s.session.task}`);
  // M1: a RUNNING pre-M1 broker serves a session without registry/sessionId
  // — render compatibly, never crash (codex M1 finding 5).
  const reg = s.session.registry as StatusDto['session']['registry'] | undefined;
  if (reg) {
    const left = Object.values(reg.agents).filter((a) => a.status === 'left').map((a) => a.id);
    out(`Session:   ${s.session.sessionId ?? '(pre-M1 — none)'}   Registry: v${reg.version} (${s.session.agents.length} live, cap ${MAX_AGENTS}${left.length ? `; left: ${left.join(', ')}` : ''})`);
  } else out('Session:   (pre-M1 broker — no registry)');
  // Peer 1A: durable human-attention + admitting progress.
  if (s.session.topology === 'peer') {
    const planning = s.session.planning;
    if (planning?.substate === 'admitting') out(`Admitting: ${planning.admitted.length}/${planning.authorizedExpected.length} attached (${planning.authorizedExpected.filter((a) => !planning.admitted.includes(a)).join(', ') || 'none'} outstanding)${planning.deadlineAt ? `; deadline ${planning.deadlineAt}` : ''}`);
    else if (planning?.substate === 'converging') { out(`Phase:     ${s.session.phase} (converging)   Turn: ${planning.rotation.holder} (round ${planning.rotation.round})`); out(`Findings:  ${renderFindingsSummary(planning.findings)}`); }
    else if (planning?.substate === 'convergence-blocked') { out(`Phase:     ${s.session.phase}   CONVERGENCE BLOCKED (no live member in the rotation — a member must rejoin, or the user forces the phase)`); out(`Findings:  ${renderFindingsSummary(planning.findings)}`); }
    else out(`Phase:     ${s.session.phase}${planning ? ` (${planning.substate})` : ''}`);
    for (const item of s.session.attention) out(`ATTENTION [${item.id}] (${item.category}) ${item.detail} — clear with /clear-attention ${item.id} (${item.at})`);
  } out(`Status:    ${s.session.status}   (started ${s.session.started})`); out(`Agents:    ${s.session.agents.join(', ')}`); if (s.session.topology !== 'peer') out(`Driver:    ${s.session.driver}   Navigators: ${s.navigators.join(', ')}   Turn: ${s.session.turn}`); for (const agent of s.session.agents) { const pending = s.pending[agent] ?? []; out(`Inbox ${agent}: ${pending.length} pending${pending.length ? ` — ${pending.map((p) => p.name).join(', ')}` : ''}`); }
  for (const a of s.awaiting ?? []) out(`Awaiting: ${a.to} owes ${a.from} a reply to ${a.messageId} (asked ${a.sentAt})`); }
/** 1B-c: one-line finding tally for the converging/blocked status panes. */
function renderFindingsSummary(findings: Readonly<Record<string, import('@core/types.ts').Finding>>): string {
  const all = Object.values(findings);
  const openAnswered = all.filter((f) => f.lifecycle === 'open' || f.lifecycle === 'answered').length;
  return `${all.length} total, ${openAnswered} open/answered`;
}
function renderTurn(s: StatusDto, as: AgentId) {
  out('='.repeat(66));
  // Membership re-check (slice 4, defense in depth behind the preemptive
  // latch): a removed agent must NEVER be advised to re-arm, whatever path
  // delivered its final message.
  if (!s.session.agents.includes(as)) { out(`YOU WERE REMOVED FROM THE SESSION. Stop all work immediately; do not re-arm this wait and do not send. Report to your human.`); return; }
  if (s.session.status === 'paused') out(`SESSION PAUSED by the user — stand by for resume. Do not re-send and do not end; re-arm: pair wait -As ${as}`);
  else if (s.session.status !== 'active') out(`SESSION ${s.session.status.toUpperCase()} — your partner ended the session. Wrap up and report to the user; do not wait again.`);
  else if (s.session.turn === as) out(`It is now YOUR turn, ${as}. Your role: ${s.session.driver === as ? 'DRIVER' : 'NAVIGATOR'}. Act on the message, then send a reply (turn: pass) and wait again.`);
  else out(`FYI only — the turn stays with ${s.session.turn}. Note the content and continue; if you are idle, re-arm: pair wait -As ${as}`);
}
/** Item 7 (`pair log -Thread`): the root plus every message whose replyTo
 * chains back into the thread. Computed to a fixpoint so the closure never
 * depends on parent-before-child ordering (round 2: archives are id-sorted
 * today, but correctness must not lean on that). */
/** 1B: human rendering of the per-phase artifact view. */
function renderArtifacts(raw: unknown): void {
  const a = raw as { phase?: string; submissions?: { author: string; contentHash: string; bytes: number; at: string }[]; proposals?: Record<string, { contentHash: string; bytes: number; at: string; body: string }>; draft?: { revision: number; hash: string; author: string | null; at: string; body: string } | null; revisionLog?: unknown[] };
  out(`Artifacts:  ${a.phase ?? 'unknown'}`);
  if (a.phase === 'sealed') {
    for (const sub of a.submissions ?? []) out(`  sealed: ${sub.author} — ${sub.bytes} bytes, sha256 ${sub.contentHash} (${sub.at})`);
    if (!(a.submissions ?? []).length) out('  (no submissions yet)');
    return;
  }
  if (a.phase !== 'revealed') return;
  for (const [author, p] of Object.entries(a.proposals ?? {})) {
    out(`${'='.repeat(66)}
PROPOSAL ${author} — ${p.bytes} bytes, sha256 ${p.contentHash} (${p.at})
${'-'.repeat(66)}
${p.body}`);
  }
  if (a.draft) out(`${'='.repeat(66)}
DRAFT r${a.draft.revision}${a.draft.author ? ` by ${a.draft.author}` : ''} (${a.draft.at})
${'-'.repeat(66)}
${a.draft.body || '(empty)'}`);
}

function threadChain<T extends { readonly header: { readonly id: string; readonly replyTo?: string } }>(messages: readonly T[], root: string): T[] {
  const inThread = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const m of messages) {
      if (inThread.has(m.header.id)) continue;
      if (m.header.replyTo !== undefined && inThread.has(m.header.replyTo)) { inThread.add(m.header.id); grew = true; }
    }
  }
  return messages.filter((m) => inThread.has(m.header.id));
}
function required(flags: Flags, name: string, message: string): string { const value = str(flags, name); if (!value) throw new Error(message); return value; }
async function bodyFrom(flags: Flags): Promise<string> { const file = str(flags, 'file'); if (file) return Bun.file(file).text(); const message = str(flags, 'message'); if (message) return message; throw new Error("Provide the message body via -Message '...' or -File <path>"); }
