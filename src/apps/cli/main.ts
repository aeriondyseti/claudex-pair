import { ProtocolError } from '@core/errors.ts';
import * as uc from '@app/usecases.ts';
import { bindFsDeps } from './bind.ts';
import { parseArgs, str, num, has } from './args.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { runBrokerCli } from './brokerCli.ts';

/**
 * `pair` CLI — verb-for-verb parity with bin/pair.ps1, including output text
 * that partner agents parse and exit codes (0 ok, 1 error, 2 wait timeout).
 */

function findRoot(explicit?: string): string {
  if (explicit) {
    const root = resolve(explicit);
    if (existsSync(join(root, '.pair', 'session.json'))) return root;
    throw new ProtocolError('session-not-active', `No .pair/session.json under -Root ${explicit}. Run: pair init -Task '...'`);
  }
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, '.pair', 'session.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ProtocolError(
    'session-not-active',
    "No active pairing session found (.pair/session.json in cwd or any parent). Run: pair init -Task '...'",
  );
}

const out = (s: string) => process.stdout.write(`${s}\n`);

/** True when `.pair/` holds an active pre-broker session (no journal dir). */
function isActiveLegacyFsSession(root: string): boolean {
  const pairDir = join(root, '.pair');
  if (existsSync(join(pairDir, 'journal'))) return false;
  try {
    const session = JSON.parse(readFileSync(join(pairDir, 'session.json'), 'utf8')) as { status?: string };
    return session.status === 'active';
  } catch {
    return false;
  }
}

function requireStr(flags: Map<string, string | true>, name: string, message: string): string {
  const v = str(flags, name);
  if (!v) throw new ProtocolError('session-not-active', message);
  return v;
}

async function bodyFrom(flags: Map<string, string | true>): Promise<string> {
  const file = str(flags, 'file');
  if (file) return await Bun.file(file).text();
  const message = str(flags, 'message');
  if (message) return message;
  throw new ProtocolError(
    'session-not-active',
    "Provide the message body via -Message '...' or -File <path> (use -File for anything long or with tricky quoting).",
  );
}

function printMessages(messages: readonly { name: string; raw: string }[]) {
  for (const m of messages) {
    out('='.repeat(66));
    out(`INCOMING ${m.name}`);
    out('-'.repeat(66));
    out(m.raw);
  }
}

/**
 * Shared wait orchestration for `wait` and the fused turn-passing `send`
 * (ENHANCEMENTS.md U3). The caller supplies the timeout wording because the
 * two paths differ there: a fused send has ALREADY committed, so its timeout
 * text must forbid re-sending.
 */
async function runWait(
  deps: ReturnType<typeof bindFsDeps>,
  args: { as: string; timeoutSec: number; pollSec: number; timeoutLines: readonly string[] },
): Promise<number> {
  const outcome = await uc.waitForMessages(deps, { as: args.as, timeoutSec: args.timeoutSec, pollSec: args.pollSec });
  if (outcome.kind === 'timeout') {
    for (const line of args.timeoutLines) out(line);
    return 2;
  }
  printMessages(outcome.messages);
  const s = outcome.session;
  out('='.repeat(66));
  if (s.status !== 'active') {
    out(`SESSION ${s.status.toUpperCase()} — your partner ended the session. Wrap up and report to the user; do not wait again.`);
  } else if (s.turn === args.as) {
    const role = s.driver === args.as ? 'DRIVER' : 'NAVIGATOR';
    out(`It is now YOUR turn, ${args.as}. Your role: ${role}. Act on the message, then send a reply (turn: pass) and wait again.`);
  } else {
    out(`FYI only — the turn stays with ${s.turn}. Note the content and continue; if you are idle, re-arm: pair wait -As ${args.as}`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { command, flags, positionals } = parseArgs(argv);
  const rootFlag = str(flags, 'root');

  // Broker is the authoritative default. The explicit fs mode is retained
  // for read-only diagnostics and the legacy compatibility test suite.
  if (process.env.CLAUDEX_PROTOCOL_MODE !== 'fs' && command !== 'watch' && command !== 'help') {
    const root = command === 'init' || command === 'broker' ? resolve(rootFlag ?? process.cwd()) : findRoot(rootFlag);
    // Legacy-session guard: an ACTIVE session with no journal predates the
    // broker — it must complete in fs mode (an empty journal would report it
    // session-not-active and strand the participants). Broker mode owns
    // sessions it created; `pair broker` itself needs no session.
    if (command === 'broker' || !isActiveLegacyFsSession(root)) {
      const result = await runBrokerCli(command, flags, positionals, root);
      if (result !== undefined) return result;
    }
  }

  switch (command) {
    case 'init': {
      const task = requireStr(flags, 'task', "init requires -Task '<what the agents are building>'");
      const agents = (str(flags, 'agents') ?? 'claude,codex').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
      const driver = (str(flags, 'driver') ?? 'claude').toLowerCase();
      const base = resolve(rootFlag ?? process.cwd());
      const deps = bindFsDeps(base);
      const r = await uc.initSession(deps, { task, agents, driver });
      const view = uc.view(r.session);
      if (r.gitignoreUpdated) out('Added .pair/ to .gitignore.');
      out(`Pairing session initialized in ${join(base, '.pair')}`);
      out(`  Task:      ${task}`);
      out(`  Agents:    ${r.session.agents.join(', ')}`);
      out(`  Driver:    ${driver}    Navigators: ${view.navigators.join(', ')}    Turn: ${driver}`);
      out('');
      out('Next: in each other pane, tell that agent to join the pairing session (/pair in Claude Code and agy, $pair in Codex).');
      return 0;
    }
    case 'send': {
      const deps = bindFsDeps(findRoot(rootFlag));
      const from = requireStr(flags, 'from', 'send requires -From <you> — never impersonate a partner').toLowerCase();
      const to = str(flags, 'to')?.toLowerCase();
      const type = (str(flags, 'type') ?? 'info').toLowerCase() as import('@core/types.ts').MessageType;
      const VALID_TYPES = ['ask', 'answer', 'handoff', 'review', 'info', 'done', 'propose-end'];
      if (!VALID_TYPES.includes(type)) {
        throw new ProtocolError('session-not-active', `-Type '${type}' is not valid. Valid values: ${VALID_TYPES.join(', ')}`);
      }
      const turnRaw = (str(flags, 'turn') ?? 'pass').toLowerCase();
      if (turnRaw !== 'pass' && turnRaw !== 'keep') {
        throw new ProtocolError('session-not-active', `-Turn '${turnRaw}' is not valid. Valid values: pass, keep`);
      }
      const turn = turnRaw as 'pass' | 'keep';
      const body = await bodyFrom(flags);
      const r = await uc.sendMessage(deps, { from, ...(to ? { to } : {}), type, turn, body });
      const s = r.session;
      const name = r.receipt.messageFiles[0] ?? '';
      const sentTo = to ?? r.events.find((e) => e.kind === 'message-sent')?.to;
      out(`Sent ${type} -> ${sentTo} (${name}). Turn: ${s.turn}. Driver: ${s.driver}. Status: ${s.status}.`);
      // U3 fused send+wait: a send that actually moved the turn rolls straight
      // into the wait loop — subscribing is control flow, not a step the agent
      // can forget. Terminal `done` and -NoWait return immediately.
      const fuse = turn === 'pass' && type !== 'done' && !has(flags, 'nowait') && s.status === 'active';
      if (!fuse) {
        // No wait hint on a session-ending send: `done` commits session-ended,
        // so telling the agent to block on a completed session is a trap.
        if (turn === 'pass' && s.status === 'active') out(`You handed over the turn. Now block on: pair wait -As ${from}`);
        return 0;
      }
      out('You handed over the turn. Waiting for the reply (-NoWait skips the fused wait).');
      const timeoutSec = num(flags, 'timeoutsec', Infinity);
      return runWait(deps, {
        as: from,
        timeoutSec,
        pollSec: Math.max(1, num(flags, 'pollsec', 2)),
        timeoutLines: [
          'SEND ALREADY COMMITTED — do NOT re-send.',
          `No reply after ${timeoutSec}s; your partner is likely still working.`,
          `NEXT: pair wait -As ${from} -TimeoutSec ${timeoutSec}`,
        ],
      });
    }
    case 'wait': {
      const deps = bindFsDeps(findRoot(rootFlag));
      const as = requireStr(flags, 'as', 'wait requires -As <your own agent name>').toLowerCase();
      const timeoutSec = num(flags, 'timeoutsec', 300);
      return runWait(deps, {
        as,
        timeoutSec,
        pollSec: Math.max(1, num(flags, 'pollsec', 2)),
        timeoutLines: [
          `No message after ${timeoutSec}s; your partner is likely still working. Re-run: pair wait -As ${as} -TimeoutSec ${timeoutSec}`,
        ],
      });
    }
    case 'ask': {
      const from = (str(flags, 'from') ?? str(flags, 'as'))?.toLowerCase();
      if (!from) throw new ProtocolError('session-not-active', 'ask requires -From <your own agent name>');
      flags.set('from', from);
      if (!flags.has('type')) flags.set('type', 'ask');
      // Pure alias: send now fuses the wait itself — delegating exactly once
      // is what prevents the historical double-wait.
      return main(['send', ...flattenFlags(flags)]);
    }
    case 'propose-end': {
      const from = requireStr(flags, 'from', 'propose-end requires -From <you>').toLowerCase();
      const s = await uc.status(bindFsDeps(findRoot(rootFlag)));
      flags.set('from', from); flags.set('to', s.session.driver ?? ''); flags.set('type', 'propose-end'); flags.set('turn', 'keep');
      return main(['send', ...flattenFlags(flags)]);
    }
    case 'revoke-turn': {
      const deps = bindFsDeps(findRoot(rootFlag));
      const from = requireStr(flags, 'from', 'revoke-turn requires -From <driver>').toLowerCase();
      if (!has(flags, 'confirmunresponsive')) throw new ProtocolError('session-not-active', 'revoke-turn requires -ConfirmUnresponsive: explicitly attest that the turn holder is unresponsive.');
      const r = await uc.revokeTurn(deps, { from, reason: str(flags, 'reason') ?? '' });
      const revoked = r.events.find((e) => e.kind === 'turn-revoked');
      out(`Turn revoked from ${revoked?.kind === 'turn-revoked' ? revoked.from : 'partner'}; ${from} now holds the turn.`);
      out('FS MODE LIMITATION: no liveness guard is available; -ConfirmUnresponsive is the only stale-partner check.');
      return 0;
    }
    case 'leave': {
      const as = requireStr(flags, 'as', 'leave requires -As <you>').toLowerCase();
      await uc.leaveSession(bindFsDeps(findRoot(rootFlag)), { as }); out(`${as} left the session.`); return 0;
    }
    case 'join': {
      const from = requireStr(flags, 'from', 'join requires -From <driver>').toLowerCase();
      const agent = requireStr(flags, 'agent', 'join requires -Agent <name>').toLowerCase();
      await uc.joinSession(bindFsDeps(findRoot(rootFlag)), { from, agent }); out(`${agent} joined the session. Earlier deliveries are not replayed; the rejoined agent starts fresh.`); return 0;
    }
    case 'kick': {
      const from = requireStr(flags, 'from', 'kick requires -From <driver>').toLowerCase();
      const agent = requireStr(flags, 'agent', 'kick requires -Agent <name>').toLowerCase();
      await uc.kickAgent(bindFsDeps(findRoot(rootFlag)), { from, agent, reason: str(flags, 'reason') ?? '' }); out(`${agent} was removed from the session; its pending deliveries were voided.`); return 0;
    }
    case 'status': {
      const deps = bindFsDeps(findRoot(rootFlag));
      const s = await uc.status(deps);
      out(`Task:      ${s.session.task}`);
      out(`Status:    ${s.session.status}   (started ${s.session.started})`);
      out(`Agents:    ${s.session.agents.join(', ')}`);
      out(`Driver:    ${s.session.driver}   Navigators: ${s.navigators.join(', ')}   Turn: ${s.session.turn}`);
      for (const agent of s.session.agents) {
        const pending = s.pending.get(agent) ?? [];
        const suffix = pending.length ? ` — ${pending.map((p) => p.name).join(', ')}` : '';
        out(`Inbox ${agent}: ${pending.length} pending${suffix}`);
      }
      if (s.recent.length) out(`Recent:    ${s.recent.map((m) => m.name).join(', ')}`);
      if (s.openGrants.length) {
        out(`Grants:    ${s.openGrants.map((g) => `${g.id} [${g.state}] -> ${g.assignee}`).join('; ')}`);
      }
      return 0;
    }
    case 'log': {
      const deps = bindFsDeps(findRoot(rootFlag));
      const messages = await uc.log(deps, { tail: num(flags, 'tail', 10) });
      if (!messages.length) {
        out('No archived messages yet.');
        return 0;
      }
      for (const m of messages) {
        out('='.repeat(66));
        out(m.name);
        out('-'.repeat(66));
        out(m.raw);
      }
      return 0;
    }
    case 'end': {
      const deps = bindFsDeps(findRoot(rootFlag));
      const as = requireStr(flags, 'as', 'end requires -As <your own agent name>').toLowerCase();
      const summary = str(flags, 'file') || str(flags, 'message') ? await bodyFrom(flags) : 'Session ended.';
      const root = findRoot(rootFlag);
      const memory = join(root, '.pair', 'memory.md');
      const stamp = bindFsDeps(root).clock.now();
      const r = await uc.endSession(deps, { as, summary });
      const others = r.session.agents.filter((a) => a !== as);
      await Bun.write(memory, `${await Bun.file(memory).text()}\n## Session ended ${stamp} by ${as}\n\n${summary}`);
      out(`Session completed. Final summary appended to memory.md and sent to ${others.join(', ')} (${r.receipt.messageFiles.join(', ')}).`);
      return 0;
    }
    case 'grant': {
      const deps = bindFsDeps(findRoot(rootFlag));
      const from = requireStr(flags, 'from', 'grant requires -From <driver>').toLowerCase();
      const to = requireStr(flags, 'to', 'grant requires -To <assignee>').toLowerCase();
      const task = str(flags, 'taskdesc') ?? '';
      const worktree = str(flags, 'worktree');
      const filesRaw = str(flags, 'files');
      if (worktree && filesRaw) throw new ProtocolError('grant-scope-invalid', 'Scope is either -Worktree <path> or -Files a,b,c — not both.');
      if (!worktree && filesRaw === undefined) {
        throw new ProtocolError('grant-scope-invalid', 'grant requires a scope: -Worktree <path> (isolated) or -Files a,b,c (shared worktree, needs -AcceptSharedWorktreeRisk).');
      }
      const r = await uc.issueGrant(deps, {
        from, to, task,
        ...(worktree ? { worktree } : {}),
        files: filesRaw !== undefined ? filesRaw.split(',') : [],
        riskAccepted: has(flags, 'acceptsharedworktreerisk'),
        agreedIn: str(flags, 'agreedin') ?? '',
      });
      const issued = r.events.find((e) => e.kind === 'grant-issued');
      const mode = issued && issued.kind === 'grant-issued' ? issued.scope.mode : '?';
      const grantId = issued && issued.kind === 'grant-issued' ? issued.grantId : '?';
      out(`Grant ${grantId} offered to ${to} (${mode} scope). The conversation turn is unaffected.`);
      return 0;
    }
    case 'grants': {
      const deps = bindFsDeps(findRoot(rootFlag));
      const state = await deps.store.load();
      if (!state) throw new ProtocolError('session-not-active', 'No session.');
      const grants = Object.values(state.grants).sort((a, b) => a.id.localeCompare(b.id));
      if (has(flags, 'json')) {
        out(JSON.stringify(grants, null, 2));
        return 0;
      }
      if (!grants.length) {
        out('No grants in this session.');
        return 0;
      }
      for (const g of grants) {
        const scopeText = g.scope.mode === 'worktree' ? `worktree ${g.scope.worktree}` : `files: ${g.scope.files.join(', ')}`;
        out(`${g.id}  [${g.state}]  ${g.issuer} -> ${g.assignee}  ${scopeText}`);
        out(`    task: ${g.task}${g.result ? `\n    result: ${g.result}` : ''}`);
      }
      return 0;
    }
    case 'grant-accept': {
      const deps = bindFsDeps(findRoot(rootFlag));
      const as = requireStr(flags, 'as', 'grant-accept requires -As <you>').toLowerCase();
      const id = requireStr(flags, 'id', 'grant-accept requires -Id <grant id>');
      const r = await uc.acceptGrant(deps, { as, grantId: id });
      const g = r.session.grants[id];
      out(`Grant ${id} is ACTIVE. You may edit strictly within its scope (${g?.scope.mode}); finish with: pair grant-done -As ${as} -Id ${id} -Message '<result>'`);
      return 0;
    }
    case 'grant-done': {
      const deps = bindFsDeps(findRoot(rootFlag));
      const as = requireStr(flags, 'as', 'grant-done requires -As <you>').toLowerCase();
      const id = requireStr(flags, 'id', 'grant-done requires -Id <grant id>');
      const result = await bodyFrom(flags).catch(() => {
        throw new ProtocolError('grant-scope-invalid', "grant-done requires -Message/-File '<what was done, files touched, how verified>'");
      });
      const r = await uc.completeGrant(deps, { as, grantId: id, result });
      const g = r.session.grants[id];
      out(`Grant ${id} done; issuer ${g?.issuer} notified. Stop editing its scope now.`);
      return 0;
    }
    case 'grant-cancel': {
      const deps = bindFsDeps(findRoot(rootFlag));
      const as = requireStr(flags, 'as', 'grant-cancel requires -As <driver>').toLowerCase();
      const id = requireStr(flags, 'id', 'grant-cancel requires -Id <grant id>');
      const r = await uc.cancelGrant(deps, { as, grantId: id, reason: str(flags, 'message') ?? '' });
      const g = r.session.grants[id];
      out(`Grant ${id} cancelled; ${g?.assignee} notified.`);
      return 0;
    }
    case 'watch': {
      // Broker-native by default (non-consuming observer, authoritative);
      // legacy/no-journal sessions fall back to the fs-diagnostic poller.
      const { runWatch } = await import('./watch.ts');
      return runWatch(findRoot(rootFlag), {
        tail: num(flags, 'tail', 10),
        refreshSec: Math.max(1, num(flags, 'refreshsec', 2)),
      });
    }
    default: {
      out(HELP);
      return 0;
    }
  }
}

function flattenFlags(flags: Map<string, string | true>): string[] {
  const argv: string[] = [];
  for (const [k, v] of flags) {
    argv.push(`-${k}`);
    if (v !== true) argv.push(v);
  }
  return argv;
}

const HELP = `claudex pair — turn-based pairing between AI CLI agents (claude, codex, agy, ...)

Usage:
  pair init   -Task '<goal>' [-Agents 'claude,codex[,agy,...]'] [-Driver <agent>] [-Root <repo>]
  pair send   -From <me> [-To <agent>] [-Type ask|answer|handoff|review|info|propose-end]
              (-Message '<text>' | -File <path>) [-Turn pass|keep]
              [-NoWait] [-TimeoutSec N] [-PollSec 2]
              # -To required when more than one possible recipient
              # A send that passes the turn WAITS for the reply in the same
              # process (unbounded unless -TimeoutSec; -NoWait opts out).
              # Timeout exit 2 means the send COMMITTED — re-arm with 'pair
              # wait', never re-send. -Turn keep returns immediately.
  pair wait   -As <me> [-TimeoutSec 300] [-PollSec 2]      # 0 = check once
  pair ask    -From <me> (-Message '<text>' | -File <path>) # = send -Type ask
  pair propose-end -From <me> (-Message '<why>' | -File <path>) # FYI to driver
  pair revoke-turn -From <driver> -ConfirmUnresponsive [-Reason '<why>']
              # Broker rejects while a live delivery lease exists. FS mode has
              # NO liveness guard; the confirmation is its only stale check.
  pair leave  -As <me>
  pair join   -From <driver> -Agent <name>
  pair kick   -From <driver> -Agent <name> [-Reason '<why>']
  pair status
  pair log    [-Tail 10]
  pair watch  [-Tail 10] [-RefreshSec 2]   # live dashboard (for the human's pane)
  pair broker status|stop [-Root <repo>]
  pair end    -As <driver> [-Message '<summary>'] # driver-only; notifies all

Work grants (grants-lite — parallel editing; driver-only issuance):
  pair grant        -From <driver> -To <agent> -TaskDesc '<task>'
                    (-Worktree <path> | -Files a,b,c -AcceptSharedWorktreeRisk)
                    [-AgreedIn <message-id>]
  pair grants       [-Json]                      # list all grants
  pair grant-accept -As <me> -Id <grant-id>      # offered -> active, then edit within scope
  pair grant-done   -As <me> -Id <grant-id> -Message '<result>'
  pair grant-cancel -As <driver> -Id <grant-id> [-Message '<reason>']
  Grant traffic never moves the conversation turn. -Files scopes share the
  worktree and are advisory only (NOT M4-safe); -Worktree scopes are isolated.

Message types:
  ask      question or request needing a reply
  answer   reply to an ask
  review   review verdict on the driver's work
  handoff  the RECIPIENT becomes driver; everyone else navigates
  info     FYI, usually with -Turn keep
  done     session complete (sent by 'pair end')

Exit codes: 0 ok, 2 wait timed out (re-run wait; after a fused send timeout
the message IS committed — never re-send), 1 error.
State lives in .pair/ at the repo root; protocol spec in the claudex repo.`;

const code = await main(process.argv.slice(2)).catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`${message}\n`);
  return 1;
});
process.exit(code);
