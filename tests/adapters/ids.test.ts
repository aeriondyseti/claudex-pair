import { describe, expect, test } from 'bun:test';
import { systemIds } from '../../src/adapters/clock/index.ts';

/** Item 7 round 2 (codex): millisecond ids collide under same-tick sends.
 * The per-process sequence makes same-process ids collision-FREE (not just
 * unlikely); the random tail covers cross-process ticks. */
describe('collision-safe message ids', () => {
  test('same-tick calls never collide and keep the sortable wall-clock prefix', () => {
    const ids = Array.from({ length: 1000 }, () => systemIds.messageId());
    expect(new Set(ids).size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^\d{8}-\d{6}-\d{3}-[a-z0-9]{6}$/);
  });
});
