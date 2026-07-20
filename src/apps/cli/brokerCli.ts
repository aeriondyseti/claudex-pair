import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Command, GrantScopeInput } from '@core/commands.ts';
import { resolveRecipient } from '@core/queries.ts';
import type { AgentId, MessageType, TurnMode } from '@core/types.ts';
import type { ExecuteOutcome, StatusDto } from '@app/ports/gateway.ts';
import { systemClock, systemIds } from '@adapters/clock/index.ts';
import { BrokerGateway, BrokerWireError } from './brokerGateway.ts';
import { nextDelivery, printDeliveryThenAck } from './brokerWait.ts';
import { has, num, str } from './args.ts';

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
      flags.set('to', status.session.driver); flags.set('type', 'propose-end'); flags.set('turn', 'keep');
      return await runBrokerCli('send', flags, positionals, root, gatewayFactory);
    }
    if (command === 'init') {
      const task = required(flags, 'task', "init requires -Task '<what the agents are building>'");
      const agents = (str(flags, 'agents') ?? 'claude,codex').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
      const driver = (str(flags, 'driver') ?? 'claude').toLowerCase();
      const r = await execute(gateway, driver, { kind: 'init-session', task, agents, driver });
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
      const r = await execute(gateway, from, { kind: 'send-message', to, type, turn, body: await bodyFrom(flags) });
      const sent = r.events.find((e) => e.kind === 'message-sent' && e.from === from);
      const sentTo = sent?.kind === 'message-sent' ? sent.to : to;
      out(`Sent ${type} -> ${sentTo} (${r.receipt.messageFiles[0] ?? ''}). Turn: ${r.session.turn}. Driver: ${r.session.driver}. Status: ${r.session.status}.`);
      const fuse = turn === 'pass' && type !== 'done' && !has(flags, 'nowait') && r.session.status === 'active';
      if (!fuse) { if (turn === 'pass' && r.session.status === 'active') out(`You handed over the turn. Now block on: pair wait -As ${from}`); return 0; }
      out('You handed over the turn. Waiting for the reply (-NoWait skips the fused wait).');
      return await waitBroker(gateway, from, num(flags, 'timeoutsec', Infinity), true);
    }
    if (command === 'wait') return await waitBroker(gateway, required(flags, 'as', 'wait requires -As <your own agent name>').toLowerCase(), num(flags, 'timeoutsec', 300), false);
    if (command === 'status') { renderStatus(await gateway.status()); return 0; }
    if (command === 'log') { const messages = await gateway.log(num(flags, 'tail', 10)); if (!messages.length) out('No archived messages yet.'); for (const m of messages) out(`${'='.repeat(66)}\n${m.name}\n${'-'.repeat(66)}\n${m.raw}`); return 0; }
    if (command === 'grants') { const grants = [...await gateway.grants()].sort((a, b) => a.id.localeCompare(b.id)); if (has(flags, 'json')) out(JSON.stringify(grants, null, 2)); else if (!grants.length) out('No grants in this session.'); else for (const g of grants) { out(`${g.id}  [${g.state}]  ${g.issuer} -> ${g.assignee}  ${g.scope.mode === 'worktree' ? `worktree ${g.scope.worktree}` : `files: ${g.scope.files.join(', ')}`}`); out(`    task: ${g.task}${g.result ? `\n    result: ${g.result}` : ''}`); } return 0; }
    if (command === 'revoke-turn') {
      const from = required(flags, 'from', 'revoke-turn requires -From <driver>').toLowerCase();
      if (!has(flags, 'confirmunresponsive')) throw new Error('revoke-turn requires -ConfirmUnresponsive: explicitly attest that the turn holder is unresponsive.');
      const r = await execute(gateway, from, { kind: 'revoke-turn', reason: str(flags, 'reason') ?? '' });
      const revoked = r.events.find((e) => e.kind === 'turn-revoked');
      out(`Turn revoked from ${revoked?.kind === 'turn-revoked' ? revoked.from : 'partner'}; ${from} now holds the turn. Broker liveness guard verified there was no live delivery lease.`); return 0;
    }
    if (command === 'leave') { const as = required(flags, 'as', 'leave requires -As <you>').toLowerCase(); await execute(gateway, as, { kind: 'leave-session' }); out(`${as} left the session.`); return 0; }
    if (command === 'join') { const from = required(flags, 'from', 'join requires -From <driver>').toLowerCase(); const agent = required(flags, 'agent', 'join requires -Agent <name>').toLowerCase(); await execute(gateway, from, { kind: 'join-session', agent }); out(`${agent} joined the session. Earlier deliveries are not replayed; the rejoined agent starts with a fresh cursor.`); return 0; }
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

async function execute(gateway: CliGateway, as: AgentId, command: Command): Promise<ExecuteOutcome> { return gateway.execute({ as, command, identity: { clientId: gateway.clientId, reqId: randomUUID() } }); }

async function waitBroker(gateway: CliGateway, as: AgentId, timeoutSec: number, fused: boolean): Promise<number> {
  const status = await gateway.status();
  if (!status.session.agents.includes(as)) throw new Error(`'${as}' is not a participant in this session`);
  const subscription = await gateway.subscribe(as, 0);
  try {
    return await waitOnSubscription(gateway, subscription, as, timeoutSec, fused);
  } catch (error) {
    // Slice 4 (design REV 6): a user kick terminates this wait — terminal
    // wording, exit 0, NO re-arm hint, never reconnect churn.
    if (error instanceof BrokerWireError && error.code === 'removed-from-session') {
      out('='.repeat(66));
      out(`YOU WERE REMOVED FROM THE SESSION by the user. Stop all work immediately; do not re-arm this wait and do not send. Report to your human.`);
      return 0;
    }
    throw error;
  } finally { await subscription.close(); }
}

async function waitOnSubscription(gateway: CliGateway, subscription: Awaited<ReturnType<CliGateway['subscribe']>>, as: AgentId, timeoutSec: number, fused: boolean): Promise<number> {
  {
    const delivery = await nextDelivery(subscription, timeoutSec);
    if (!delivery) { if (fused) { out('SEND ALREADY COMMITTED — do NOT re-send.'); out(`No reply after ${timeoutSec}s; your partner is likely still working.`); out(`NEXT: pair wait -As ${as} -TimeoutSec ${timeoutSec}`); } else out(`No message after ${timeoutSec}s; your partner is likely still working. Re-run: pair wait -As ${as} -TimeoutSec ${timeoutSec}`); return 2; }
    await printDeliveryThenAck(delivery, subscription);
    renderTurn((await gateway.status()), as); return 0;
  }
}

function renderStatus(s: StatusDto) { out(`Task:      ${s.session.task}`); out(`Status:    ${s.session.status}   (started ${s.session.started})`); out(`Agents:    ${s.session.agents.join(', ')}`); out(`Driver:    ${s.session.driver}   Navigators: ${s.navigators.join(', ')}   Turn: ${s.session.turn}`); for (const agent of s.session.agents) { const pending = s.pending[agent] ?? []; out(`Inbox ${agent}: ${pending.length} pending${pending.length ? ` — ${pending.map((p) => p.name).join(', ')}` : ''}`); } }
function renderTurn(s: StatusDto, as: AgentId) {
  out('='.repeat(66));
  // Membership re-check (slice 4, defense in depth behind the preemptive
  // latch): a removed agent must NEVER be advised to re-arm, whatever path
  // delivered its final message.
  if (!s.session.agents.includes(as)) { out(`YOU WERE REMOVED FROM THE SESSION. Stop all work immediately; do not re-arm this wait and do not send. Report to your human.`); return; }
  if (s.session.status !== 'active') out(`SESSION ${s.session.status.toUpperCase()} — your partner ended the session. Wrap up and report to the user; do not wait again.`);
  else if (s.session.turn === as) out(`It is now YOUR turn, ${as}. Your role: ${s.session.driver === as ? 'DRIVER' : 'NAVIGATOR'}. Act on the message, then send a reply (turn: pass) and wait again.`);
  else out(`FYI only — the turn stays with ${s.session.turn}. Note the content and continue; if you are idle, re-arm: pair wait -As ${as}`);
}
function required(flags: Flags, name: string, message: string): string { const value = str(flags, name); if (!value) throw new Error(message); return value; }
async function bodyFrom(flags: Flags): Promise<string> { const file = str(flags, 'file'); if (file) return Bun.file(file).text(); const message = str(flags, 'message'); if (message) return message; throw new Error("Provide the message body via -Message '...' or -File <path>"); }
