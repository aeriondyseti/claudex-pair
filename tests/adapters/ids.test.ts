import { describe, expect, test } from 'bun:test';
import { makeMessageIdSource, systemIds } from '../../src/adapters/clock/index.ts';

/** Item 7 round 3 (codex): same-tick uniqueness must be STRUCTURAL — the
 * per-tick counter never wraps, so a frozen clock crossing the old 1296
 * boundary cannot collide regardless of any random value. */
describe('collision-safe message ids', () => {
  test('>1296 same-tick calls never collide under a frozen clock (structural, not probabilistic)', () => {
    const frozen = new Date('2026-07-20T13:00:00.123');
    const next = makeMessageIdSource('abcd', () => frozen);
    const ids = Array.from({ length: 2000 }, next);
    expect(new Set(ids).size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^20260720-130000-123-abcd[a-z0-9]+$/);
  });

  test('a tick change resets the counter without collision; live ids keep the sortable prefix', () => {
    let t = new Date('2026-07-20T13:00:00.123');
    const next = makeMessageIdSource('abcd', () => t);
    const first = next();
    t = new Date('2026-07-20T13:00:00.124');
    const second = next();
    expect(first).not.toBe(second);
    expect(first).toBe('20260720-130000-123-abcd0');
    expect(second).toBe('20260720-130000-124-abcd0');
    expect(systemIds.messageId()).toMatch(/^\d{8}-\d{6}-\d{3}-[a-z0-9]{5,}$/);
  });
});
