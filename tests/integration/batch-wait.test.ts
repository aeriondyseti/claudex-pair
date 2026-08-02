import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Delivery, DeliverySubscription, StatusDto } from '@app/ports/gateway.ts';
import { runBrokerCli, type CliGateway } from '../../src/apps/cli/brokerCli.ts';
import { splitBatchItems } from '../../src/apps/cli/batch.ts';

/** T3: the batch-file parser, and the wait drain — one wake consumes every
 * already-enqueued delivery (ack count proves consumption) instead of one
 * re-arm cycle per message. Fake gateway via the codex regression seam. */

describe('T3 splitBatchItems', () => {
  test('splits on ## headings, keeps headings in bodies, rejects preamble and single items', () => {
    expect(splitBatchItems('## q1\nfirst\n\n## q2\nsecond\n')).toEqual(['## q1\nfirst', '## q2\nsecond']);
    expect(() => splitBatchItems('stray preamble\n## q1\nx\n## q2\ny')).toThrow('before the first');
    expect(() => splitBatchItems('## only\none item')).toThrow('at least two');
  });
});

const message = (id: string, body: string): Delivery => ({
  deliverySeq: Number(id.slice(-1)),
  deliveryId: `${id}:claude`,
  message: {
    name: `${id}-codex-info.md`,
    header: { id, from: 'codex', to: 'claude', type: 'info', turn: 'keep', sent: '2026-08-02 10:00:00' },
    body, raw: `---\nid: ${id}\n---\n\n${body}\n`,
  },
});

function fakeGateway(queued: Delivery[], acked: string[]): CliGateway {
  const status: StatusDto = {
    session: {
      topology: 'pair', task: 't', agents: ['claude', 'codex'], driver: 'codex', turn: 'claude',
      status: 'active', started: '2026-08-02 09:00:00', grants: {},
      registry: { version: 0, agents: {} },
    } as StatusDto['session'],
    navigators: ['claude'], openGrants: [], pending: {}, recent: [], awaiting: [],
  };
  const subscription: DeliverySubscription = {
    deliveries: (async function* () {
      for (const d of queued) yield d;
      await new Promise(() => undefined); // then hang like a live socket
    })(),
    ack: async (deliveryId) => void acked.push(deliveryId),
    extend: async () => undefined,
    close: async () => undefined,
  };
  return {
    clientId: 'fake-client',
    execute: () => { throw new Error('not under test'); },
    status: async () => status,
    log: async () => [],
    grants: async () => [],
    subscribe: async () => subscription,
    brokerStatus: async () => ({ running: true }),
    stop: async () => undefined,
    close: async () => undefined,
  };
}

describe('T3 wait drain', () => {
  test('one wake consumes all queued deliveries (3 acks, exit 0)', async () => {
    const acked: string[] = [];
    const gateway = fakeGateway([message('m1', '## q1'), message('m2', '## q2'), message('m3', '## q3')], acked);
    const flags = new Map<string, string | true>([['as', 'claude'], ['timeoutsec', '5']]);
    const exit = await runBrokerCli('wait', flags, [], join(tmpdir(), 'claudex-batch-wait'), () => gateway);
    expect(exit).toBe(0);
    expect(acked).toEqual(['m1:claude', 'm2:claude', 'm3:claude']);
  });
});
