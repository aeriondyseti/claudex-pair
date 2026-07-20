import { describe, expect, test } from 'bun:test';
import type { CommandEnvelope } from '../../src/core/commands.ts';
import type { Event } from '../../src/core/events.ts';
import { decide } from '../../src/core/decide.ts';
import { evolve, replay } from '../../src/core/evolve.ts';
import { validatePlanTaskBlock } from '../../src/core/plan.ts';
import { ROUND_CAP, type Rotation, type SessionState } from '../../src/core/types.ts';

/** Peer 1C: the ballot/round automaton (PEER-MODEL §1c/§1d). Pure core; the
 * broker path is pinned in tests/broker/peer-collecting.test.ts. */

const AT = '2026-07-20 20:00:00';
const cenv = (command: unknown, principal: string, id: string, extra: Record<string, unknown> = {}): CommandEnvelope =>
  ({ command, meta: { id, at: AT, principal, ...extra } }) as CommandEnvelope;
const code = (r: ReturnType<typeof decide>) => (r.ok ? '' : (r.error as { code?: string }).code);
const apply = (s: SessionState, events: readonly Event[]): SessionState =>
  events.reduce<SessionState | undefined>((acc, e) => (acc ? (evolve(acc, e) ?? acc) : acc), s)!;

/** A canonical valid normative task block, fenced in a draft body. */
const BLOCK = {
  plan: { wip_cap: 1, verification: { fast_gate: 'bun test', full_suite: 'bun run check', cadence: 'exit-only' } },
  tasks: [
    { id: 't1', title: 'Build core', class: 'production', description: 'the thing', acceptance: ['works'], deps: [], size: 'M' },
    { id: 't2', title: 'Verify', class: 'assist', merges: false, description: 'test it', acceptance: ['passes'], deps: ['t1'], affinity: ['tests/**'] },
  ],
};
const draftWith = (block: unknown): string => `# Prose design\n\nrationale here.\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
const VALID_DRAFT = draftWith(BLOCK);

/** A converging peer session over `members` (all live, holder = members[0]). */
function converging(members: string[] = ['claude', 'codex']): SessionState {
  const init = decide(undefined, cenv({ kind: 'init-session', task: 'p', agents: members, driver: members[0], sessionId: 'session-c-000001', topology: 'peer' }, members[0]!, 'bi'));
  if (!init.ok) throw init.error;
  let s = replay(init.value)!;
  let v = s.registry.version;
  for (const m of members.slice(1)) {
    s = evolve(s, { kind: 'registry-updated', version: ++v, change: 'joined', agent: m, at: AT })!;
    s = evolve(s, { kind: 'agent-admitted', agent: m, at: AT })!;
  }
  s = evolve(s, { kind: 'admission-completed', at: AT })!;
  s = evolve(s, { kind: 'barrier-opened', members, registryVersion: v, at: AT })!;
  s = evolve(s, { kind: 'barrier-revealed', electorate: members, at: AT })!;
  if (s.topology !== 'peer' || s.planning?.substate !== 'converging') throw new Error('harness shape');
  return s;
}

const DRAFT_HASH = 'a'.repeat(64);
/** Converging with the draft advanced to revision 1 (concrete hash). */
function drafted(members: string[] = ['claude', 'codex']): SessionState {
  return apply(converging(members), [{ kind: 'draft-amended', revision: 1, hash: DRAFT_HASH, author: members[0]!, content: 'draft v1', bytes: 8, at: AT }]);
}
const cq = (s: SessionState, principal: string, id: string, draftBody = VALID_DRAFT): ReturnType<typeof decide> =>
  decide(s, cenv({ kind: 'call-question' }, principal, id, { draftBody }));
const rotationOf = (s: SessionState): Rotation => {
  if (s.topology !== 'peer' || s.planning?.substate !== 'converging') throw new Error('not converging');
  return s.planning.rotation;
};
const ballotOf = (s: SessionState) => {
  if (s.topology !== 'peer' || s.planning?.substate !== 'converging') throw new Error('not converging');
  return s.planning.ballot;
};
/** Open a ballot at revision 1 (hash DRAFT_HASH), returning state + hash. */
function balloted(members: string[] = ['claude', 'codex']): { s: SessionState; hash: string } {
  const s0 = drafted(members);
  const called = cq(s0, members[0]!, 'open-q');
  if (!called.ok) throw new Error(`call-question rejected: ${called.error.code}`);
  return { s: apply(s0, called.value), hash: DRAFT_HASH };
}
const vote = (s: SessionState, who: string, approve: boolean, hash: string, id: string, reasons?: string) =>
  decide(s, cenv({ kind: 'vote', approve, revisionHash: hash, ...(reasons === undefined ? {} : { reasons }) }, who, id));

describe('1C validatePlanTaskBlock direct matrix', () => {
  test('missing fence -> reason names the missing task block', () => {
    const r = validatePlanTaskBlock('just prose, no fence');
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error).toContain('json task block');
  });
  test('bad JSON in the fence', () => {
    const r = validatePlanTaskBlock('```json\n{ not valid\n```\n');
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error).toContain('not valid JSON');
  });
  test('wip_cap 0 rejects', () => {
    const r = validatePlanTaskBlock(draftWith({ ...BLOCK, plan: { ...BLOCK.plan, wip_cap: 0 } }));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error).toContain('wip_cap');
  });
  test('missing fast_gate rejects', () => {
    const r = validatePlanTaskBlock(draftWith({ plan: { wip_cap: 1, verification: { full_suite: 'x' } }, tasks: BLOCK.tasks }));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error).toContain('fast_gate');
  });
  test('duplicate task ids reject', () => {
    const dup = { ...BLOCK, tasks: [BLOCK.tasks[0], { ...BLOCK.tasks[1], id: 't1', deps: [] }] };
    const r = validatePlanTaskBlock(draftWith(dup));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error).toContain('duplicate');
  });
  test('unknown dep rejects', () => {
    const bad = { ...BLOCK, tasks: [{ ...BLOCK.tasks[0], deps: ['ghost'] }, { ...BLOCK.tasks[1], deps: [] }] };
    const r = validatePlanTaskBlock(draftWith(bad));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error).toContain('unknown task id');
  });
  test('self-dep rejects', () => {
    const bad = { ...BLOCK, tasks: [{ ...BLOCK.tasks[0], deps: ['t1'] }, { ...BLOCK.tasks[1], deps: [] }] };
    const r = validatePlanTaskBlock(draftWith(bad));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error).toContain('depend on itself');
  });
  test('dependency cycle (a->b->a) rejects', () => {
    const cyc = { ...BLOCK, tasks: [{ ...BLOCK.tasks[0], deps: ['t2'] }, { ...BLOCK.tasks[1], deps: ['t1'] }] };
    const r = validatePlanTaskBlock(draftWith(cyc));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error).toContain('cycle');
  });
  test('merges on a production task rejects', () => {
    const bad = { ...BLOCK, tasks: [{ ...BLOCK.tasks[0], merges: true }, { ...BLOCK.tasks[1], deps: [] }] };
    const r = validatePlanTaskBlock(draftWith(bad));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error).toContain('merges');
  });
  test('empty acceptance rejects', () => {
    const bad = { ...BLOCK, tasks: [{ ...BLOCK.tasks[0], acceptance: [] }, { ...BLOCK.tasks[1], deps: [] }] };
    const r = validatePlanTaskBlock(draftWith(bad));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.error).toContain('acceptance');
  });
  test('valid block passes; affinity/size are optional and preserved', () => {
    const r = validatePlanTaskBlock(VALID_DRAFT);
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    expect(r.value.plan.wip_cap).toBe(1);
    expect(r.value.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(r.value.tasks[1]).toMatchObject({ class: 'assist', merges: false });
    expect(r.value.tasks[1]!.size).toBeUndefined(); // size is optional
    expect(r.value.tasks[0]!.size).toBe('M');
    expect(r.value.tasks[1]!.affinity).toEqual(['tests/**']);
  });
});

describe('1C call-question gates in order', () => {
  test('not-in-electorate (an observer never in the electorate)', () => {
    expect(code(cq(drafted(), 'gemini', 'e1'))).toBe('not-in-electorate');
  });
  test('ballot-open when a ballot is already open', () => {
    const { s } = balloted();
    expect(code(cq(s, 'claude', 'e2'))).toBe('ballot-open');
  });
  test('findings-unsettled: an OPEN HIGH finding gates', () => {
    const s = apply(drafted(), [{ kind: 'finding-filed', id: 'h1-f', author: 'codex', addressedTo: 'claude', anchor: { kind: 'proposal', author: 'claude' }, severity: 'HIGH', agreement: 'disputed', text: 't', bytes: 1, textHash: 'h'.repeat(64), at: AT }]);
    expect(code(cq(s, 'claude', 'e3'))).toBe('findings-unsettled');
  });
  test('findings gate PASSES when an answered HIGH has a departed author (settled predicate)', () => {
    const s = apply(drafted(), [
      { kind: 'finding-filed', id: 'h2-f', author: 'codex', addressedTo: 'claude', anchor: { kind: 'draft', revision: 1 }, severity: 'HIGH', agreement: 'disputed', text: 't', bytes: 1, textHash: 'h'.repeat(64), at: AT },
      { kind: 'finding-responded', id: 'h2-f', disposition: 'resolve', text: 'ok', bytes: 1, textHash: 'h'.repeat(64), at: AT },
      { kind: 'registry-updated', version: 90, change: 'left', agent: 'codex', at: AT }, // author departed -> answered is settled
    ]);
    const r = cq(s, 'claude', 'e4');
    expect(r.ok).toBeTrue(); // findings no longer gate; block valid; no agenda
  });
  test('agenda-unaddressed gates while an unaddressed item remains', () => {
    const s = apply(drafted(), [{ kind: 'agenda-recorded', items: [{ id: 'ag-0', reason: 'redo the api', from: 'codex', at: AT }], at: AT }]);
    expect(code(cq(s, 'claude', 'e5'))).toBe('agenda-unaddressed');
  });
  test('invalid-task-block when the stamped draft body has no fence', () => {
    expect(code(cq(drafted(), 'claude', 'e6', 'prose only, no json fence'))).toBe('invalid-task-block');
    // internal guard: missing draftBody entirely.
    expect(code(decide(drafted(), cenv({ kind: 'call-question' }, 'claude', 'e6b')))).toBe('invalid-task-block');
  });
  test('happy path: snapshots the CURRENT rotation electorate and binds the draft hash', () => {
    const s = drafted(['claude', 'codex', 'agy']);
    const r = cq(s, 'claude', 'e7');
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    const called = r.value[0]!;
    expect(called).toMatchObject({ kind: 'question-called', revision: 1, revisionHash: DRAFT_HASH, electorate: ['claude', 'codex', 'agy'], calledBy: 'claude' });
    if (called.kind !== 'question-called') return;
    expect(called.taskBlock.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    const after = apply(s, r.value);
    const b = ballotOf(after)!;
    expect(b.revisionHash).toBe(DRAFT_HASH);
    expect(b.electorate).toEqual(['claude', 'codex', 'agy']);
    expect(b.votes).toEqual({});
  });
});

describe('1C vote matrix', () => {
  test('no-open-ballot on a converging session with no ballot', () => {
    expect(code(vote(drafted(), 'claude', true, DRAFT_HASH, 'v0'))).toBe('no-open-ballot');
  });
  test('not-in-electorate for a non-member', () => {
    const { s, hash } = balloted();
    expect(code(vote(s, 'gemini', true, hash, 'v1'))).toBe('not-in-electorate');
  });
  test('already-voted rejects a second vote', () => {
    const { s, hash } = balloted(['claude', 'codex', 'agy']);
    const once = apply(s, (vote(s, 'claude', true, hash, 'v2a') as { value: Event[] }).value);
    expect(code(vote(once, 'claude', true, hash, 'v2b'))).toBe('already-voted');
  });
  test('stale-ballot-revision when the vote hash does not match the ballot', () => {
    const { s } = balloted();
    expect(code(vote(s, 'claude', true, 'b'.repeat(64), 'v3'))).toBe('stale-ballot-revision');
  });
  test('a draft amendment VOIDS the open ballot in the same txn; a later vote is no-open-ballot', () => {
    const { s, hash } = balloted();
    // holder claude amends (baseRevision 1 -> revision 2), voiding the ballot.
    const d = decide(s, cenv({ kind: 'draft-amend', content: 'new draft body', baseRevision: 1 }, 'claude', 'amX', { contentHash: 'c'.repeat(64), contentBytes: 14 }));
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(d.value.map((e) => e.kind)).toEqual(['draft-amended', 'ballot-closed']);
    expect(d.value[1]).toMatchObject({ kind: 'ballot-closed', outcome: 'voided' });
    const after = apply(s, d.value);
    expect(ballotOf(after)).toBeUndefined();
    expect(code(vote(after, 'claude', true, hash, 'v4'))).toBe('no-open-ballot');
  });
  test('vote-reject-without-reason: a reject must carry non-blank reasons', () => {
    const { s, hash } = balloted();
    expect(code(vote(s, 'claude', false, hash, 'v5'))).toBe('vote-reject-without-reason');
    expect(code(vote(s, 'claude', false, hash, 'v5b', '   '))).toBe('vote-reject-without-reason');
  });
  test('a reject CLOSES the ballot and records the mandatory agenda (addressed:false)', () => {
    const { s, hash } = balloted(['claude', 'codex', 'agy']);
    const d = vote(s, 'codex', false, hash, 'rj', 'the ordering is wrong');
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    const kinds = d.value.map((e) => e.kind);
    expect(kinds.slice(0, 3)).toEqual(['vote-cast', 'ballot-closed', 'agenda-recorded']);
    expect(d.value[1]).toMatchObject({ kind: 'ballot-closed', outcome: 'rejected' });
    const recorded = d.value.find((e) => e.kind === 'agenda-recorded');
    expect(recorded).toMatchObject({ kind: 'agenda-recorded', items: [{ id: 'rj-a0', reason: 'the ordering is wrong', from: 'codex' }] });
    // @broker vote notices to every current agent.
    const notices = d.value.filter((e) => e.kind === 'message-sent');
    expect(notices).toHaveLength(3);
    expect(notices.every((n) => n.kind === 'message-sent' && n.from === '@broker' && n.provenance === 'broker')).toBeTrue();
    const after = apply(s, d.value);
    expect(ballotOf(after)).toBeUndefined();
    if (after.topology !== 'peer' || after.planning?.substate !== 'converging') throw new Error('shape');
    expect(after.planning.agenda).toEqual([{ id: 'rj-a0', reason: 'the ordering is wrong', from: 'codex', at: AT, addressed: false }]);
  });
  test('non-final approve leaves the ballot open with the vote recorded', () => {
    const { s, hash } = balloted(['claude', 'codex', 'agy']);
    const d = vote(s, 'claude', true, hash, 'ap1');
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(d.value.some((e) => e.kind === 'ballot-passed')).toBeFalse();
    const after = apply(s, d.value);
    const b = ballotOf(after)!;
    expect(b.votes).toEqual({ claude: { vote: 'approve' } });
  });
  test('the FINAL approve emits vote-cast + ballot-passed + phase-transition ATOMICALLY; evolve lands provisioning with the frozen plan', () => {
    const { s, hash } = balloted(['claude', 'codex']);
    const s1 = apply(s, (vote(s, 'claude', true, hash, 'f1') as { value: Event[] }).value); // non-final
    const d = vote(s1, 'codex', true, hash, 'f2'); // final
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(d.value.map((e) => e.kind)).toEqual(['vote-cast', 'ballot-passed', 'phase-transition', 'message-sent', 'message-sent']);
    expect(d.value[1]).toMatchObject({ kind: 'ballot-passed', revision: 1, hash: DRAFT_HASH });
    expect(d.value[2]).toMatchObject({ kind: 'phase-transition', from: 'planning', to: 'provisioning', outcome: 'ballot-passed' });
    const passed = d.value[1]!;
    if (passed.kind === 'ballot-passed') expect(passed.taskBlock.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    const after = apply(s1, d.value);
    if (after.topology !== 'peer') throw new Error('shape');
    expect(after.phase).toBe('provisioning');
    expect(after.planning).toBeUndefined();
    expect(after.plan).toMatchObject({ revision: 1, hash: DRAFT_HASH });
    expect(after.plan!.taskBlock.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('1C address-agenda', () => {
  function rejected(): { s: SessionState; agendaId: string } {
    const { s, hash } = balloted(['claude', 'codex']);
    const d = vote(s, 'codex', false, hash, 'rej', 'redo it');
    const after = apply(s, (d as { value: Event[] }).value);
    return { s: after, agendaId: 'rej-a0' };
  }
  test('unknown-agenda-item for a missing id', () => {
    const { s } = rejected();
    expect(code(decide(s, cenv({ kind: 'address-agenda', agendaId: 'nope' }, 'claude', 'aa0')))).toBe('unknown-agenda-item');
  });
  test('not-in-electorate for an outsider', () => {
    const { s, agendaId } = rejected();
    expect(code(decide(s, cenv({ kind: 'address-agenda', agendaId }, 'gemini', 'aa1')))).toBe('not-in-electorate');
  });
  test('marks the item addressed; call-question then unblocks', () => {
    const { s, agendaId } = rejected();
    // still blocked before addressing (re-amend to keep the block valid + hash fresh).
    const s1 = apply(s, [{ kind: 'draft-amended', revision: 2, hash: 'e'.repeat(64), author: 'claude', content: 'v2', bytes: 2, at: AT }]);
    expect(code(cq(s1, 'claude', 'blk'))).toBe('agenda-unaddressed');
    const d = decide(s1, cenv({ kind: 'address-agenda', agendaId, note: 'reworked' }, 'claude', 'aa2'));
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(d.value[0]).toMatchObject({ kind: 'agenda-addressed', agendaId, note: 'reworked' });
    const s2 = apply(s1, d.value);
    if (s2.topology !== 'peer' || s2.planning?.substate !== 'converging') throw new Error('shape');
    expect(s2.planning.agenda.every((a) => a.addressed)).toBeTrue();
    expect(cq(s2, 'claude', 'ok').ok).toBeTrue();
  });
});

describe('1C round cap + ballot stall attention', () => {
  test('a rejected ballot at or beyond ROUND_CAP raises a round-cap attention item', () => {
    let s = converging(['claude', 'codex']);
    let guard = 0;
    while (rotationOf(s).round < ROUND_CAP && guard < 30) {
      const holder = rotationOf(s).holder;
      s = apply(s, (decide(s, cenv({ kind: 'yield-turn' }, holder, `yy${guard}`)) as { value: Event[] }).value);
      guard++;
    }
    expect(rotationOf(s).round).toBeGreaterThanOrEqual(ROUND_CAP);
    const holder = rotationOf(s).holder;
    s = apply(s, [{ kind: 'draft-amended', revision: 1, hash: DRAFT_HASH, author: holder, content: 'd', bytes: 1, at: AT }]);
    s = apply(s, (cq(s, holder, 'cap-q') as { value: Event[] }).value);
    const d = vote(s, holder, false, DRAFT_HASH, 'cap-rej', 'still no');
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    const cap = d.value.find((e) => e.kind === 'attention-raised');
    expect(cap).toMatchObject({ kind: 'attention-raised', category: 'round-cap' });
  });

  test('a ballot-electorate member leaving raises ballot-stalled; the ballot SURVIVES', () => {
    const { s } = balloted(['claude', 'codex', 'agy']); // holder claude
    const d = decide(s, cenv({ kind: 'leave-session' }, 'codex', 'lv')); // non-holder leaves
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    const stall = d.value.find((e) => e.kind === 'attention-raised' && e.category === 'ballot-stalled');
    expect(stall).toBeDefined();
    const after = apply(s, d.value);
    // ballot survives (fixed-electorate ruling: a departure is an abstention).
    expect(ballotOf(after)).toBeDefined();
    if (after.topology !== 'peer') throw new Error('shape');
    expect(after.attention.some((a) => a.category === 'ballot-stalled')).toBeTrue();
  });
});
