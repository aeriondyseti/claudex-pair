import type { Command, CommandEnvelope } from '@core/commands.ts';
import { decide } from '@core/decide.ts';
import { ProtocolError } from '@core/errors.ts';
import { openGrants, navigators, resolveRecipient } from '@core/queries.ts';
import type { AgentId, Grant, SessionState } from '@core/types.ts';
import type { Deps, StoredMessage } from './ports/index.ts';

/**
 * Use-case orchestration: load → decide (authorize + transition) → append →
 * publish (ARCHITECTURE.md). No protocol rules live here.
 */

async function execute(deps: Deps, principal: AgentId, command: Command) {
  return executeWithState(deps, await deps.store.load(), principal, command);
}

export type SessionView = {
  session: SessionState;
  navigators: readonly AgentId[];
  openGrants: readonly Grant[];
};

export function view(session: SessionState): SessionView {
  return { session, navigators: navigators(session), openGrants: openGrants(session) };
}

export async function initSession(deps: Deps, args: { task: string; agents: readonly AgentId[]; driver: AgentId }) {
  const existing = await deps.store.load();
  const r = await executeWithState(deps, existing, args.driver, {
    kind: 'init-session',
    task: args.task,
    agents: args.agents,
    driver: args.driver,
  });
  return r;
}

/** Like execute but with a pre-loaded state (init needs to inspect first). */
async function executeWithState(deps: Deps, state: SessionState | undefined, principal: AgentId, command: Command) {
  const envelope: CommandEnvelope = {
    command,
    meta: { id: deps.ids.messageId(), at: deps.clock.now(), principal },
  };
  const decided = decide(state, envelope);
  if (!decided.ok) throw decided.error;
  if (command.kind === 'init-session') {
    const init = await deps.store.initialize(envelope, decided.value);
    return {
      events: decided.value,
      receipt: { messageFiles: [] as readonly string[] },
      session: (await deps.store.load())!,
      gitignoreUpdated: init.gitignoreUpdated,
    };
  }
  const receipt = await deps.store.commit(envelope, decided.value);
  return { events: decided.value, receipt, session: (await deps.store.load())!, gitignoreUpdated: false };
}

export async function sendMessage(
  deps: Deps,
  args: { from: AgentId; to?: AgentId; type: string; turn: 'pass' | 'keep'; body: string },
) {
  const state = await deps.store.load();
  let to = args.to;
  if (!to && state) {
    to = resolveRecipient(state, args.from);
    if (!to) {
      const others = state.agents.filter((a) => a !== args.from);
      throw new ProtocolError('ambiguous-recipient', `Ambiguous recipient: specify -To explicitly (one of: ${others.join(', ')})`);
    }
  }
  return executeWithState(deps, state, args.from, {
    kind: 'send-message',
    to: to ?? '',
    type: args.type as never,
    turn: args.turn,
    body: args.body,
  });
}

export async function endSession(deps: Deps, args: { as: AgentId; summary: string }) {
  return execute(deps, args.as, { kind: 'end-session', summary: args.summary });
}

export async function issueGrant(
  deps: Deps,
  args: {
    from: AgentId;
    to: AgentId;
    task: string;
    worktree?: string;
    files?: readonly string[];
    riskAccepted: boolean;
    agreedIn: string;
  },
) {
  const grantId = `g${deps.ids.messageId()}-${args.to}`;
  const scope = args.worktree
    ? ({ mode: 'worktree', worktree: args.worktree } as const)
    : ({ mode: 'files', files: args.files ?? [], riskAccepted: args.riskAccepted } as const);
  return execute(deps, args.from, { kind: 'issue-grant', grantId, to: args.to, task: args.task, scope, agreedIn: args.agreedIn });
}

export async function acceptGrant(deps: Deps, args: { as: AgentId; grantId: string }) {
  return execute(deps, args.as, { kind: 'accept-grant', grantId: args.grantId });
}

export async function completeGrant(deps: Deps, args: { as: AgentId; grantId: string; result: string }) {
  return execute(deps, args.as, { kind: 'complete-grant', grantId: args.grantId, result: args.result });
}

export async function cancelGrant(deps: Deps, args: { as: AgentId; grantId: string; reason: string }) {
  return execute(deps, args.as, { kind: 'cancel-grant', grantId: args.grantId, reason: args.reason });
}

export type WaitOutcome =
  | { kind: 'delivered'; messages: readonly StoredMessage[]; session: SessionState }
  | { kind: 'timeout' };

export async function waitForMessages(
  deps: Deps,
  args: { as: AgentId; timeoutSec: number; pollSec: number },
): Promise<WaitOutcome> {
  const state = await deps.store.load();
  if (!state) throw new ProtocolError('session-not-active', "No active pairing session found (.pair/session.json in cwd or any parent). Run: pair init -Task '...'");
  if (!state.agents.includes(args.as)) {
    throw new ProtocolError('not-a-participant', `'${args.as}' is not a participant in this session (agents: ${state.agents.join(', ')}). Never impersonate another agent.`);
  }
  const deadline = deps.clock.epochMs() + args.timeoutSec * 1000;
  for (;;) {
    const messages = await deps.mailbox.claim(args.as);
    if (messages.length > 0) {
      const session = (await deps.store.load())!;
      return { kind: 'delivered', messages, session };
    }
    if (deps.clock.epochMs() >= deadline) return { kind: 'timeout' };
    await deps.clock.sleep(args.pollSec * 1000);
  }
}

export async function status(deps: Deps) {
  const state = await deps.store.load();
  if (!state) throw new ProtocolError('session-not-active', "No active pairing session found (.pair/session.json in cwd or any parent). Run: pair init -Task '...'");
  const pending = new Map<AgentId, readonly StoredMessage[]>();
  for (const agent of state.agents) pending.set(agent, await deps.mailbox.pending(agent));
  const recent = await deps.mailbox.archived(3);
  return { ...view(state), pending, recent };
}

export async function log(deps: Deps, args: { tail: number }) {
  return deps.mailbox.archived(args.tail);
}
