import { describe, expect, test } from 'bun:test';
import type { CommandEnvelope } from '../../src/core/commands.ts';
import type { Event } from '../../src/core/events.ts';
import { decide } from '../../src/core/decide.ts';
import { evolve, replay } from '../../src/core/evolve.ts';
import { advanceRotation, resumeHolder } from '../../src/core/rotation.ts';
import { FINDINGS_MAX, REASONS_MAX, type Finding, type Registry, type Rotation, type SessionState } from '../../src/core/types.ts';

/** Peer 1B-c: findings state machine + convergence rotation (design rev 4
 * rulings B/C). Pure core; the broker paths are pinned in the broker suite. */

const AT = '2026-07-20 19:00:00';
const cenv = (command: unknown, principal: string, id: string, extra: Record<string, unknown> = {}): CommandEnvelope =>
  ({ command, meta: { id, at: AT, principal, ...extra } }) as CommandEnvelope;
const cmeta = (text: string) => ({ contentHash: 'h'.repeat(64), contentBytes: Buffer.byteLength(text, 'utf8') });
const code = (r: ReturnType<typeof decide>) => (r.ok ? '' : (r.error as { code?: string }).code);
const apply = (s: SessionState, events: readonly Event[]): SessionState =>
  events.reduce<SessionState | undefined>((acc, e) => (acc ? (evolve(acc, e) ?? acc) : acc), s)!;

/** A converging peer session over `members` (all live, holder = members[0]),
 * built by replaying the barrier-open/reveal event shapes. */
function converging(members: string[] = ['claude', 'codex']): SessionState {
  const init = decide(undefined, cenv({ kind: 'init-session', task: 'p', agents: members, driver: members[0], sessionId: 'session-f-000001', topology: 'peer' }, members[0]!, 'fi'));
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

const findingsOf = (s: SessionState): Record<string, Finding> => {
  if (s.topology !== 'peer' || (s.planning?.substate !== 'converging' && s.planning?.substate !== 'convergence-blocked')) throw new Error('not converging');
  return s.planning.findings;
};
const rotationOf = (s: SessionState): Rotation => {
  if (s.topology !== 'peer' || s.planning?.substate !== 'converging') throw new Error('not converging');
  return s.planning.rotation;
};

/** File one finding via decide+evolve, returning the new state and its id. */
function file(s: SessionState, principal: string, anchor: Finding['anchor'], id: string, text = 'a problem worth noting'): { state: SessionState; id: string } {
  const d = decide(s, cenv({ kind: 'critique', anchor, severity: 'MED', agreement: 'partial', text }, principal, id, cmeta(text)));
  if (!d.ok) throw new Error(`file rejected: ${d.error.code}`);
  return { state: apply(s, d.value), id: `${id}-f` };
}

describe('1B-c critique: creation, anchors, derived addressee', () => {
  test('proposal anchor derives the addressee from the electorate author; emits one finding-filed', () => {
    const s = converging();
    const d = decide(s, cenv({ kind: 'critique', anchor: { kind: 'proposal', author: 'codex' }, severity: 'HIGH', agreement: 'disputed', text: 'this proposal double-frees' }, 'claude', 'c1', cmeta('this proposal double-frees')));
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(d.value).toHaveLength(1);
    const filed = d.value[0]!;
    expect(filed).toMatchObject({ kind: 'finding-filed', id: 'c1-f', author: 'claude', addressedTo: 'codex', severity: 'HIGH', agreement: 'disputed' });
    const after = apply(s, d.value);
    const f = findingsOf(after)['c1-f']!;
    expect(f.lifecycle).toBe('open');
    expect(f.history).toEqual([{ actor: 'claude', at: AT, kind: 'filed', bytes: Buffer.byteLength('this proposal double-frees', 'utf8'), textHash: 'h'.repeat(64) }]);
  });

  test('draft-revision anchor derives the addressee from revisionLog[revision].author', () => {
    let s = converging();
    s = apply(s, [{ kind: 'draft-amended', revision: 1, hash: 'f'.repeat(64), author: 'claude', content: 'draft v1', bytes: 8, at: AT }]);
    const d = decide(s, cenv({ kind: 'critique', anchor: { kind: 'draft', revision: 1 }, severity: 'LOW', agreement: 'agreed', text: 'nit in v1' }, 'codex', 'c2', cmeta('nit in v1')));
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(d.value[0]).toMatchObject({ addressedTo: 'claude', anchor: { kind: 'draft', revision: 1 } });
  });

  test('anchor + membership + self-address rejections are typed', () => {
    let s = converging();
    s = apply(s, [{ kind: 'draft-amended', revision: 1, hash: 'f'.repeat(64), author: 'claude', content: 'draft v1', bytes: 8, at: AT }]);
    // not-in-electorate: an outsider.
    expect(code(decide(s, cenv({ kind: 'critique', anchor: { kind: 'proposal', author: 'codex' }, severity: 'MED', agreement: 'partial', text: 'x' }, 'gemini', 'e1', cmeta('x'))))).toBe('not-in-electorate');
    // revision 0 is not anchorable.
    expect(code(decide(s, cenv({ kind: 'critique', anchor: { kind: 'draft', revision: 0 }, severity: 'MED', agreement: 'partial', text: 'x' }, 'codex', 'e2', cmeta('x'))))).toBe('not-anchorable');
    // revision beyond current is unknown.
    expect(code(decide(s, cenv({ kind: 'critique', anchor: { kind: 'draft', revision: 5 }, severity: 'MED', agreement: 'partial', text: 'x' }, 'codex', 'e3', cmeta('x'))))).toBe('unknown-finding');
    // proposal author not in electorate is unknown.
    expect(code(decide(s, cenv({ kind: 'critique', anchor: { kind: 'proposal', author: 'gemini' }, severity: 'MED', agreement: 'partial', text: 'x' }, 'codex', 'e4', cmeta('x'))))).toBe('unknown-finding');
    // self-addressed: claude critiques its own rev-1 draft (addressedTo === claude).
    expect(code(decide(s, cenv({ kind: 'critique', anchor: { kind: 'draft', revision: 1 }, severity: 'MED', agreement: 'partial', text: 'x' }, 'claude', 'e5', cmeta('x'))))).toBe('self-addressed-finding');
  });

  test('text grammar/bytes rejections; findings only while converging', () => {
    const s = converging();
    expect(code(decide(s, cenv({ kind: 'critique', anchor: { kind: 'proposal', author: 'codex' }, severity: 'MED', agreement: 'partial', text: '   ' }, 'claude', 't1', cmeta(' '))))).toBe('blank-content');
    expect(code(decide(s, cenv({ kind: 'critique', anchor: { kind: 'proposal', author: 'codex' }, severity: 'MED', agreement: 'partial', text: 'badbell' }, 'claude', 't2', cmeta('bad'))))).toBe('control-characters');
    expect(code(decide(s, cenv({ kind: 'critique', anchor: { kind: 'proposal', author: 'codex' }, severity: 'MED', agreement: 'partial', text: 'big' }, 'claude', 't3', { contentHash: 'h'.repeat(64), contentBytes: 4_097 })))).toBe('finding-too-large');
    // convergence-blocked rejects critique (no live rotation): halt a converging
    // session whose members have all departed.
    let dead = apply(converging(), [{ kind: 'registry-updated', version: 90, change: 'left', agent: 'claude', at: AT }, { kind: 'registry-updated', version: 91, change: 'left', agent: 'codex', at: AT }]);
    dead = evolve(dead, { kind: 'convergence-halted', at: AT })!;
    if (dead.topology !== 'peer' || dead.planning?.substate !== 'convergence-blocked') throw new Error('expected blocked');
    expect(code(decide(dead, cenv({ kind: 'critique', anchor: { kind: 'proposal', author: 'codex' }, severity: 'MED', agreement: 'partial', text: 'x' }, 'claude', 'tb', cmeta('x'))))).toBe('phase-unavailable');
  });

  test('FINDINGS_MAX is a pure rejection', () => {
    let s = converging();
    for (let i = 0; i < FINDINGS_MAX; i++) {
      s = apply(s, [{ kind: 'finding-filed', id: `x${i}-f`, author: 'claude', addressedTo: 'codex', anchor: { kind: 'proposal', author: 'codex' }, severity: 'LOW', agreement: 'partial', text: 't', bytes: 1, textHash: 'h'.repeat(64), at: AT }]);
    }
    expect(Object.keys(findingsOf(s)).length).toBe(FINDINGS_MAX);
    expect(code(decide(s, cenv({ kind: 'critique', anchor: { kind: 'proposal', author: 'codex' }, severity: 'MED', agreement: 'partial', text: 'one more' }, 'claude', 'over', cmeta('one more'))))).toBe('findings-exhausted');
  });
});

describe('1B-c transition table (rows 1-7 + illegal combos)', () => {
  /** open finding authored by claude, addressed to codex. */
  const opened = () => file(converging(), 'claude', { kind: 'proposal', author: 'codex' }, 'f0');
  const resp = (s: SessionState, who: string, disposition: string, id: string, text = 'my response') =>
    decide(s, cenv({ kind: 'respond-critique', findingId: 'f0-f', disposition, text }, who, id, cmeta(text)));
  const conf = (s: SessionState, who: string, verdict: string, id: string, text = 'my verdict', extra: Record<string, unknown> = {}) =>
    decide(s, cenv({ kind: 'confirm-critique', findingId: 'f0-f', verdict, text, ...extra }, who, id, cmeta(text)));

  test('row 1: open + addressee + resolve -> answered', () => {
    const { state } = opened();
    const d = resp(state, 'codex', 'resolve', 'r1');
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(findingsOf(apply(state, d.value))['f0-f']!.lifecycle).toBe('answered');
  });

  test('row 2: concede -> conceded (terminal) forces agreement agreed', () => {
    const { state } = opened();
    const d = resp(state, 'codex', 'concede', 'r2');
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    const f = findingsOf(apply(state, d.value))['f0-f']!;
    expect(f.lifecycle).toBe('conceded');
    expect(f.agreement).toBe('agreed');
  });

  test('row 3: dispute -> answered; blank dispute text is reason-required', () => {
    const { state } = opened();
    expect(code(resp(state, 'codex', 'dispute', 'r3a', '   '))).toBe('reason-required');
    const d = resp(state, 'codex', 'dispute', 'r3b', 'I disagree because...');
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(findingsOf(apply(state, d.value))['f0-f']!.lifecycle).toBe('answered');
  });

  test('row 4: answered + author + accept -> resolved (terminal)', () => {
    let { state } = opened();
    state = apply(state, (resp(state, 'codex', 'resolve', 'r4a') as { value: Event[] }).value);
    const d = conf(state, 'claude', 'accept', 'r4b');
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(findingsOf(apply(state, d.value))['f0-f']!.lifecycle).toBe('resolved');
  });

  test('row 5: contest -> open; blank contest text is reason-required; setDisputed flips agreement', () => {
    let { state } = opened();
    state = apply(state, (resp(state, 'codex', 'resolve', 'r5a') as { value: Event[] }).value);
    expect(code(conf(state, 'claude', 'contest', 'r5b', '  '))).toBe('reason-required');
    const d = conf(state, 'claude', 'contest', 'r5c', 'still broken', { setDisputed: true });
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    const f = findingsOf(apply(state, d.value))['f0-f']!;
    expect(f.lifecycle).toBe('open');
    expect(f.agreement).toBe('disputed');
  });

  test('row 6: author withdraw works from BOTH open and answered -> withdrawn', () => {
    const fromOpen = opened();
    const w1 = decide(fromOpen.state, cenv({ kind: 'amend-critique', findingId: 'f0-f', action: 'withdraw' }, 'claude', 'w6a'));
    expect(w1.ok).toBeTrue();
    if (w1.ok) expect(findingsOf(apply(fromOpen.state, w1.value))['f0-f']!.lifecycle).toBe('withdrawn');

    let answered = opened().state;
    answered = apply(answered, (resp(answered, 'codex', 'resolve', 'w6b') as { value: Event[] }).value);
    const w2 = decide(answered, cenv({ kind: 'amend-critique', findingId: 'f0-f', action: 'withdraw', text: 'never mind' }, 'claude', 'w6c', cmeta('never mind')));
    expect(w2.ok).toBeTrue();
    if (w2.ok) expect(findingsOf(apply(answered, w2.value))['f0-f']!.lifecycle).toBe('withdrawn');
  });

  test('row 7: author set-agreement rewrites agreement while open; missing agreement rejected', () => {
    const { state } = opened();
    expect(code(decide(state, cenv({ kind: 'amend-critique', findingId: 'f0-f', action: 'set-agreement' }, 'claude', 's7a')))).toBe('reason-required');
    const d = decide(state, cenv({ kind: 'amend-critique', findingId: 'f0-f', action: 'set-agreement', agreement: 'disputed' }, 'claude', 's7b'));
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    const f = findingsOf(apply(state, d.value))['f0-f']!;
    expect(f.agreement).toBe('disputed');
    expect(f.lifecycle).toBe('open');
  });

  test('illegal actor/lifecycle combos are precisely typed', () => {
    const { state } = opened();
    // unknown finding.
    expect(code(decide(state, cenv({ kind: 'respond-critique', findingId: 'nope', disposition: 'resolve', text: 'x' }, 'codex', 'i1', cmeta('x'))))).toBe('unknown-finding');
    // respond by the non-addressee (author).
    expect(code(resp(state, 'claude', 'resolve', 'i2'))).toBe('not-the-addressee');
    // confirm on an OPEN finding (must be answered).
    expect(code(conf(state, 'claude', 'accept', 'i3'))).toBe('wrong-lifecycle');
    // confirm by the non-author.
    expect(code(conf(state, 'codex', 'accept', 'i4'))).toBe('not-your-finding');
    // amend by the non-author.
    expect(code(decide(state, cenv({ kind: 'amend-critique', findingId: 'f0-f', action: 'withdraw' }, 'codex', 'i5')))).toBe('not-your-finding');

    // respond on an ANSWERED finding by the addressee is wrong-lifecycle.
    const answered = apply(state, (resp(state, 'codex', 'resolve', 'i6') as { value: Event[] }).value);
    expect(code(resp(answered, 'codex', 'resolve', 'i7'))).toBe('wrong-lifecycle');

    // any transition on a TERMINAL finding is finding-terminal.
    const conceded = apply(state, (resp(state, 'codex', 'concede', 'i8') as { value: Event[] }).value);
    expect(code(resp(conceded, 'codex', 'resolve', 'i9'))).toBe('finding-terminal');
    expect(code(decide(conceded, cenv({ kind: 'amend-critique', findingId: 'f0-f', action: 'withdraw' }, 'claude', 'i10')))).toBe('finding-terminal');
  });

  test('REASONS_MAX (creation counts): fill 16 history entries then reject', () => {
    let state = opened().state; // history length 1 (filed)
    let n = 1;
    let turn: 'respond' | 'confirm' = 'respond';
    // dispute/contest cycle keeps the finding live and appends one entry each.
    while (findingsOf(state)['f0-f']!.history.length < REASONS_MAX) {
      if (turn === 'respond') {
        state = apply(state, (resp(state, 'codex', 'dispute', `cy${n}`, 'again') as { value: Event[] }).value);
        turn = 'confirm';
      } else {
        const d = conf(state, 'claude', 'contest', `cy${n}`, 'again');
        state = apply(state, (d as { value: Event[] }).value);
        turn = 'respond';
      }
      n++;
    }
    expect(findingsOf(state)['f0-f']!.history.length).toBe(REASONS_MAX);
    // 16 entries = filed + 15 transitions -> answered (even count). The next
    // VALID transition (the author's confirm) hits the history cap.
    expect(findingsOf(state)['f0-f']!.lifecycle).toBe('answered');
    expect(code(conf(state, 'claude', 'contest', 'capped', 'one too many'))).toBe('finding-history-exhausted');
  });
});

describe('1B-c yield + must-respond gate', () => {
  test('non-holder cannot yield; an open finding addressed to the holder blocks it until answered', () => {
    let s = converging();
    expect(code(decide(s, cenv({ kind: 'yield-turn' }, 'codex', 'y0')))).toBe('not-convergence-holder');
    // codex files a finding addressed to the holder (claude, draft rev-1 author).
    s = apply(s, [{ kind: 'draft-amended', revision: 1, hash: 'f'.repeat(64), author: 'claude', content: 'v1', bytes: 2, at: AT }]);
    const filed = file(s, 'codex', { kind: 'draft', revision: 1 }, 'g1');
    s = filed.state;
    expect(code(decide(s, cenv({ kind: 'yield-turn' }, 'claude', 'y1')))).toBe('unanswered-findings');
    // claude (addressee) resolves it; the gate opens.
    s = apply(s, (decide(s, cenv({ kind: 'respond-critique', findingId: filed.id, disposition: 'resolve', text: 'fixed in v2' }, 'claude', 'y2', cmeta('fixed in v2'))) as { value: Event[] }).value);
    const y = decide(s, cenv({ kind: 'yield-turn' }, 'claude', 'y3'));
    expect(y.ok).toBeTrue();
    if (!y.ok) return;
    expect(y.value[0]).toMatchObject({ kind: 'convergence-turn-passed', from: 'claude', to: 'codex', round: 0 });
    // Peer slice 2: a derived @broker nudge to the NEW holder only.
    expect(y.value).toHaveLength(2);
    expect(y.value[1]).toMatchObject({ kind: 'message-sent', from: '@broker', to: 'codex', provenance: 'broker', turn: 'keep' });
    expect((y.value[1] as { body?: string }).body).toContain('round 0');
  });
});

describe('1B-c rotation: advance across rounds', () => {
  const yield_ = (s: SessionState, who: string, id: string) => decide(s, cenv({ kind: 'yield-turn' }, who, id));

  test('three-member rotation rotates the starter each round (A,B,C -> round1 B,C,A -> round2 C,A,B)', () => {
    let s = converging(['claude', 'codex', 'agy']);
    expect(rotationOf(s)).toEqual({ electorate: ['claude', 'codex', 'agy'], starterIndex: 0, round: 0, remaining: ['codex', 'agy'], holder: 'claude' });
    // round 0: claude -> codex -> agy
    s = apply(s, (yield_(s, 'claude', 'a') as { value: Event[] }).value);
    expect(rotationOf(s).holder).toBe('codex');
    s = apply(s, (yield_(s, 'codex', 'b') as { value: Event[] }).value);
    expect(rotationOf(s)).toMatchObject({ holder: 'agy', remaining: [], round: 0 });
    // agy closes round 0 -> round 1 starts at codex (B): B,C,A
    s = apply(s, (yield_(s, 'agy', 'c') as { value: Event[] }).value);
    expect(rotationOf(s)).toEqual({ electorate: ['claude', 'codex', 'agy'], starterIndex: 1, round: 1, remaining: ['agy', 'claude'], holder: 'codex' });
    s = apply(s, (yield_(s, 'codex', 'd') as { value: Event[] }).value);
    expect(rotationOf(s).holder).toBe('agy');
    s = apply(s, (yield_(s, 'agy', 'e') as { value: Event[] }).value);
    expect(rotationOf(s).holder).toBe('claude');
    // claude closes round 1 -> round 2 starts at agy (C): C,A,B
    s = apply(s, (yield_(s, 'claude', 'f') as { value: Event[] }).value);
    expect(rotationOf(s)).toEqual({ electorate: ['claude', 'codex', 'agy'], starterIndex: 2, round: 2, remaining: ['claude', 'codex'], holder: 'agy' });
  });

  test('holder departure advances exactly like a yield (same txn)', () => {
    const s = converging(['claude', 'codex', 'agy']);
    const d = decide(s, cenv({ kind: 'leave-session' }, 'claude', 'lv'));
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(d.value.find((e) => e.kind === 'convergence-turn-passed')).toMatchObject({ from: 'claude', to: 'codex', round: 0 });
    expect(rotationOf(apply(s, d.value)).holder).toBe('codex');
  });

  test('final-slot holder departure completes the round', () => {
    let s = converging(['claude', 'codex', 'agy']);
    s = apply(s, (yield_(s, 'claude', 'a') as { value: Event[] }).value);
    s = apply(s, (yield_(s, 'codex', 'b') as { value: Event[] }).value); // holder agy, remaining []
    const d = decide(s, cenv({ kind: 'leave-session' }, 'agy', 'lv'));
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(d.value.find((e) => e.kind === 'convergence-turn-passed')).toMatchObject({ to: 'codex', round: 1 });
  });

  test('no live successor blocks, retaining the unserved slots (Ruling B)', () => {
    let s = converging(['claude', 'codex', 'agy']); // holder claude, remaining [codex, agy]
    s = apply(s, (decide(s, cenv({ kind: 'leave-session' }, 'codex', 'l1')) as { value: Event[] }).value); // non-holder: no rotation event
    s = apply(s, (decide(s, cenv({ kind: 'leave-session' }, 'agy', 'l2')) as { value: Event[] }).value);
    expect(rotationOf(s).holder).toBe('claude'); // still holds; remaining unchanged
    const d = decide(s, cenv({ kind: 'leave-session' }, 'claude', 'l3'));
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(d.value.some((e) => e.kind === 'convergence-halted')).toBeTrue();
    const after = apply(s, d.value);
    if (after.topology !== 'peer' || after.planning?.substate !== 'convergence-blocked') throw new Error('expected blocked');
    expect(after.planning.rotation).toEqual({ electorate: ['claude', 'codex', 'agy'], starterIndex: 0, round: 0, remaining: ['codex', 'agy'] });
  });

  test('all-departed rollover advances the starter one FROZEN index and blocks with the full rotated order', () => {
    let s = converging(['claude', 'codex', 'agy']);
    s = apply(s, (yield_(s, 'claude', 'a') as { value: Event[] }).value);
    s = apply(s, (yield_(s, 'codex', 'b') as { value: Event[] }).value); // holder agy, remaining [], round 0, si 0
    s = apply(s, (decide(s, cenv({ kind: 'leave-session' }, 'claude', 'l1')) as { value: Event[] }).value);
    s = apply(s, (decide(s, cenv({ kind: 'leave-session' }, 'codex', 'l2')) as { value: Event[] }).value);
    const d = decide(s, cenv({ kind: 'leave-session' }, 'agy', 'l3'));
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    expect(d.value.some((e) => e.kind === 'convergence-halted')).toBeTrue();
    const after = apply(s, d.value);
    if (after.topology !== 'peer' || after.planning?.substate !== 'convergence-blocked') throw new Error('expected blocked');
    // round completed (round 1), frozen starter advanced 0 -> 1, full order retained.
    expect(after.planning.rotation).toEqual({ electorate: ['claude', 'codex', 'agy'], starterIndex: 1, round: 1, remaining: ['codex', 'agy', 'claude'] });
  });

  test('advanceRotation is deterministic across leaving vs post-departure registry', () => {
    const s = converging(['claude', 'codex', 'agy']);
    const rot = rotationOf(s);
    const reg = s.registry;
    const decideView = advanceRotation(rot, reg, 'claude');
    // evolve view: registry marks claude left, no leaving arg.
    const regLeft: Registry = { version: reg.version + 1, agents: { ...reg.agents, claude: { ...reg.agents['claude']!, status: 'left' } } };
    const evolveView = advanceRotation(rot, regLeft);
    expect(evolveView).toEqual(decideView);
  });
});

describe('1B-c convergence-halted / resumed evolve shapes', () => {
  /** A blocked state from the no-live-successor path. */
  function blocked(): SessionState {
    let s = converging(['claude', 'codex', 'agy']);
    s = apply(s, (decide(s, cenv({ kind: 'leave-session' }, 'codex', 'l1')) as { value: Event[] }).value);
    s = apply(s, (decide(s, cenv({ kind: 'leave-session' }, 'agy', 'l2')) as { value: Event[] }).value);
    s = apply(s, (decide(s, cenv({ kind: 'leave-session' }, 'claude', 'l3')) as { value: Event[] }).value);
    if (s.topology !== 'peer' || s.planning?.substate !== 'convergence-blocked') throw new Error('expected blocked');
    return s;
  }

  test('resumeHolder + convergence-resumed evolve: rejoiner IN the stored order resumes the interrupted round', () => {
    const s = blocked(); // remaining [codex, agy], round 0, si 0
    if (s.topology !== 'peer' || s.planning?.substate !== 'convergence-blocked') throw new Error('shape');
    const holder = resumeHolder(s.planning.rotation, s.registry, 'codex');
    expect(holder).toBe('codex');
    const after = evolve(s, { kind: 'convergence-resumed', holder, at: AT })!;
    expect(rotationOf(after)).toEqual({ electorate: ['claude', 'codex', 'agy'], starterIndex: 0, round: 0, remaining: ['agy'], holder: 'codex' });
  });

  test('convergence-resumed evolve: rejoiner NOT in the stored order constructs the next round with it as starter', () => {
    const s = blocked(); // remaining [codex, agy] — claude already served + departed
    const holder = 'claude';
    const after = evolve(s, { kind: 'convergence-resumed', holder, at: AT })!;
    expect(rotationOf(after)).toEqual({ electorate: ['claude', 'codex', 'agy'], starterIndex: 0, round: 1, remaining: ['codex', 'agy'], holder: 'claude' });
  });

  test('convergence-halted evolve drops the holder and blocks the current order', () => {
    // Build converging with codex+agy already gone, then halt directly.
    let s = converging(['claude', 'codex', 'agy']);
    s = apply(s, [{ kind: 'registry-updated', version: 90, change: 'left', agent: 'codex', at: AT }, { kind: 'registry-updated', version: 91, change: 'left', agent: 'agy', at: AT }]);
    const after = evolve(s, { kind: 'convergence-halted', at: AT })!;
    if (after.topology !== 'peer' || after.planning?.substate !== 'convergence-blocked') throw new Error('expected blocked');
    expect(after.planning.rotation).toEqual({ electorate: ['claude', 'codex', 'agy'], starterIndex: 0, round: 0, remaining: ['codex', 'agy'] });
    expect('holder' in after.planning.rotation).toBeFalse();
  });
});

describe('1B-c departure attention aggregate', () => {
  test('one findings-blocked item per departed agent lists up to 5 ids + a count', () => {
    let s = converging();
    // claude files 7 findings all addressed to codex.
    for (let i = 0; i < 7; i++) s = file(s, 'claude', { kind: 'proposal', author: 'codex' }, `k${i}`).state;
    const d = decide(s, cenv({ kind: 'leave-session' }, 'codex', 'dep'));
    expect(d.ok).toBeTrue();
    if (!d.ok) return;
    const raised = d.value.filter((e) => e.kind === 'attention-raised');
    expect(raised).toHaveLength(1);
    const item = raised[0]!;
    expect(item).toMatchObject({ kind: 'attention-raised', category: 'findings-blocked' });
    if (item.kind !== 'attention-raised') return;
    expect(item.id.startsWith('fblock-codex-')).toBeTrue();
    expect(item.detail).toContain('7 findings blocked by codex');
    expect(item.detail).toContain('(+2 more)');
    // it lands durably in the attention queue.
    const after = apply(s, d.value);
    if (after.topology !== 'peer') throw new Error('shape');
    expect(after.attention.some((a) => a.category === 'findings-blocked')).toBeTrue();
  });
});
