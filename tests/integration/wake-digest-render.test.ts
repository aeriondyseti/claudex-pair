import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Delivery } from '@app/ports/gateway.ts';
import { renderWakeDigest } from '../../src/apps/cli/brokerWait.ts';

/** T2: the client-side wake-packet block — digest facts, review scope, and
 * the local memory.md pointer, rendered under INCOMING. */

const delivery = (extra: Partial<Delivery> = {}, header: Record<string, string> = {}): Delivery => ({
  deliverySeq: 1,
  deliveryId: 'm1:claude',
  message: {
    name: 'm1-codex-review.md',
    header: { id: 'm1', from: 'codex', to: 'claude', type: 'review', turn: 'pass', sent: '2026-08-02 10:00:00', ...header },
    body: 'looks good',
    raw: 'raw',
  },
  ...extra,
});

describe('T2 renderWakeDigest', () => {
  test('renders orientation, awaiting split by direction, findings, scope, and memory pointer', () => {
    const root = mkdtempSync(join(tmpdir(), 'claudex-render-'));
    mkdirSync(join(root, '.pair'), { recursive: true });
    writeFileSync(join(root, '.pair', 'memory.md'), '# session memory\n');
    const now = new Date(2026, 7, 2, 10, 5, 0).getTime();
    let text = '';
    renderWakeDigest(
      delivery({
        digest: {
          status: 'active', turn: 'claude', driver: 'claude',
          awaiting: [
            { messageId: 'a1', from: 'codex', to: 'claude', sentAt: '2026-08-02 10:01:00' },
            { messageId: 'a2', from: 'claude', to: 'codex', sentAt: '2026-08-02 09:55:00' },
          ],
        },
      }, { reviewScope: 'main..HEAD -- src/x.ts' }),
      'claude', root, (t) => { text += t; }, now,
    );
    expect(text).toContain('review scope: main..HEAD -- src/x.ts');
    expect(text).toContain('turn YOURS (claude) · driver claude');
    expect(text).toContain('you owe codex a reply to a1 (4m ago)');
    expect(text).toContain('codex owes you a reply to a2 (10m ago)');
    expect(text).toContain('memory.md: ');
  });

  test('peer digest renders phase/substate and unsettled findings', () => {
    let text = '';
    renderWakeDigest(
      delivery({ digest: { status: 'active', phase: 'planning', substate: 'converging', awaiting: [], findingsOpen: { high: 1, med: 2, low: 0 } } }),
      'claude', join(tmpdir(), 'claudex-none'), (t) => { text += t; }, Date.now(),
    );
    expect(text).toContain('phase planning (converging)');
    expect(text).toContain('unsettled findings: 1 HIGH, 2 MED, 0 LOW');
  });

  test('no digest and no scope renders nothing (pre-T2 broker)', () => {
    let text = '';
    renderWakeDigest(delivery(), 'claude', join(tmpdir(), 'claudex-none'), (t) => { text += t; }, Date.now());
    expect(text).toBe('');
  });
});
