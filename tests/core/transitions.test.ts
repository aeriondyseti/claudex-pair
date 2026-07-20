import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide, evolve, resolveRecipient, type CommandEnvelope, type Grant, type SessionState } from '../../src/core/index.ts';
import { ProtocolError } from '../../src/core/errors.ts';

/**
 * Transition-table runner over tests/core/transitions.jsonl (authored by agy
 * from INVARIANTS.md + decide.ts). Each row: {inv, given, command, expect}.
 */

type Row = {
  inv: string;
  given: Record<string, unknown> | null;
  command: Record<string, unknown> & { kind: string; principal: string };
  expect: string;
};

const rows: Row[] = readFileSync(join(import.meta.dir, 'transitions.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Row);

function buildGrant(id: string, partial: Partial<Grant>): Grant {
  return {
    id,
    issuer: 'claude',
    assignee: 'agy',
    task: 'work',
    scope: { mode: 'worktree', worktree: 'wt' },
    state: 'offered',
    agreedIn: '',
    result: '',
    revision: 0,
    created: 't0',
    updated: 't0',
    ...partial,
  };
}

function buildState(given: Row['given']): SessionState | undefined {
  if (given === null) return undefined;
  const agents = (given['agents'] as string[] | undefined) ?? ['claude', 'agy'];
  const driver = (given['driver'] as string | undefined) ?? agents[0]!;
  const grantsIn = (given['grants'] as Record<string, Partial<Grant>> | undefined) ?? {};
  const grants: Record<string, Grant> = {};
  for (const [id, g] of Object.entries(grantsIn)) grants[id] = buildGrant(id, g);
  return {
    topology: 'pair',
    task: (given['task'] as string | undefined) ?? 'work',
    registry: { version: 1, agents: Object.fromEntries(agents.map((a) => [a, { id: a, display: a, status: 'active' as const, joinedAt: 's' }])) },
    agents,
    driver,
    turn: (given['turn'] as string | undefined) ?? driver,
    status: (given['status'] as SessionState['status'] | undefined) ?? 'active',
    started: 't0',
    grants,
  };
}

function buildCommand(raw: Row['command']): { command: Record<string, unknown>; principal: string } {
  const { principal, ...rest } = raw;
  const command: Record<string, unknown> = { ...rest };
  switch (command['kind']) {
    case 'init-session':
      command['task'] ??= 'work';
      command['sessionId'] ??= 'session-tt-0001'; // M1 round 2: init invariant
      break;
    case 'send-message':
      command['type'] ??= 'info';
      command['turn'] ??= 'keep';
      command['body'] ??= 'x';
      break;
    case 'issue-grant':
      command['grantId'] ??= 'gX';
      command['task'] ??= 'work'; // ??= keeps an explicit "" (DEC-17)
      command['scope'] ??= { mode: 'worktree', worktree: 'wt' };
      command['agreedIn'] ??= '';
      break;
    case 'complete-grant':
      command['result'] ??= 'done';
      break;
    case 'cancel-grant':
      command['reason'] ??= '';
      break;
  }
  return { command, principal };
}

describe('protocol transition table', () => {
  for (const row of rows) {
    test(`${row.inv} → ${row.expect}`, () => {
      const state = buildState(row.given);
      const { command, principal } = buildCommand(row.command);

      // App-layer recipient resolution (to: null) mirrors sendMessage's logic.
      if (command['kind'] === 'send-message' && command['to'] === null) {
        expect(state).toBeDefined();
        const resolved = resolveRecipient(state!, principal);
        if (row.expect === 'ambiguous-recipient') {
          expect(resolved).toBeUndefined();
          return;
        }
        command['to'] = resolved;
      }

      const envelope = {
        command,
        meta: { id: 'test-msg', at: 't1', principal },
      } as unknown as CommandEnvelope;
      const result = decide(state, envelope);

      if (row.expect === 'ok') {
        if (!result.ok) throw new Error(`${row.inv}: expected ok, got ${result.error.code}: ${result.error.message}`);
        // Replay safety: evolve must fold every emitted event without throwing.
        let s = state;
        for (const event of result.value) s = evolve(s, event);
        expect(result.value.length).toBeGreaterThan(0);
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(ProtocolError);
          expect(result.error.code).toBe(row.expect as ProtocolError['code']);
        }
      }
    });
  }
});
