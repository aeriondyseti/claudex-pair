import { describe, expect, test } from 'bun:test';
import type { Delivery, DeliverySubscription, ExecuteOutcome, StatusDto } from '@app/ports/gateway.ts';
import { runBrokerCli, type CliGateway } from '../../src/apps/cli/brokerCli.ts';

/**
 * D1 regression (root cause 2026-07-20, codex finding 20260720-101816-882):
 * `return waitBroker(...)` inside runBrokerCli's try/finally ran the
 * finally's gateway.close() CONCURRENTLY with the wait it had just armed,
 * destroying the socket under the fused (and, but for an accidental leak,
 * the standalone) wait. These tests pin CLEANUP ORDERING through the
 * injected-gateway seam: close() must happen exactly once, and only after
 * the wait settles — for both the fused send and the standalone wait.
 */

type Log = string[];

function makeFakeGateway(log: Log) {
  let pushDelivery: ((d: Delivery) => void) | undefined;
  let closeCount = 0;

  const session = {
    task: 't', status: 'active', started: 's',
    agents: ['claude', 'codex'], driver: 'claude', turn: 'codex', grants: {},
  };
  const status: StatusDto = {
    session: session as StatusDto['session'],
    navigators: ['codex'],
    pending: { claude: [], codex: [] },
    openGrants: [],
    recent: [],
  } as unknown as StatusDto;

  const outcome: ExecuteOutcome = {
    session: session as ExecuteOutcome['session'],
    receipt: { messageFiles: ['m1-claude-ask.md'] },
    events: [{ kind: 'message-sent', id: 'm1', from: 'claude', to: 'codex', type: 'ask', turn: 'pass', body: 'x', at: 'now' }],
  } as unknown as ExecuteOutcome;

  const gateway: CliGateway = {
    clientId: 'fake-client',
    execute: async () => { log.push('execute'); return outcome; },
    status: async () => { log.push('status'); return status; },
    log: async () => [],
    grants: async () => [],
    brokerStatus: async () => ({ running: true }),
    stop: async () => {},
    subscribe: async (): Promise<DeliverySubscription> => {
      log.push(`subscribe (closeCount=${closeCount})`);
      const waiters: Array<(r: IteratorResult<Delivery>) => void> = [];
      const buffered: Delivery[] = [];
      pushDelivery = (d) => { const w = waiters.shift(); if (w) w({ done: false, value: d }); else buffered.push(d); };
      return {
        deliveries: {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<Delivery>>((resolve) => {
                const b = buffered.shift();
                if (b) resolve({ done: false, value: b }); else waiters.push(resolve);
              }),
            };
          },
        },
        ack: async (id) => { log.push(`ack ${id} (closeCount=${closeCount})`); },
        extend: async () => {},
        close: async () => { log.push('subscription-close'); },
      };
    },
    close: async () => { closeCount += 1; log.push(`gateway-close #${closeCount}`); },
  };

  return {
    gateway,
    deliver: (id: string) => {
      if (!pushDelivery) throw new Error('subscribe was never called');
      pushDelivery({ deliverySeq: 1, deliveryId: id, message: { name: `${id}.md`, header: { id, from: 'codex', to: 'claude', type: 'answer', turn: 'pass', sent: 's' }, body: 'b', raw: 'raw-body' } as Delivery['message'] });
    },
    closes: () => closeCount,
  };
}

describe('runBrokerCli gateway lifecycle ordering', () => {
  test('fused send: gateway.close() runs only AFTER the fused wait settles', async () => {
    const log: Log = [];
    const { gateway, deliver, closes } = makeFakeGateway(log);
    const flags = new Map<string, string | true>([['from', 'claude'], ['to', 'codex'], ['type', 'ask'], ['message', 'x']]);

    const result = runBrokerCli('send', flags, [], 'unused-root', () => gateway);
    // Let the send commit and the fused wait arm.
    await Bun.sleep(20);
    expect(log).toContain('subscribe (closeCount=0)'); // wait armed with the gateway still open
    expect(closes()).toBe(0); // the old bug: close() had already run here

    deliver('m2:claude');
    expect(await result).toBe(0);
    expect(closes()).toBe(1);
    expect(log).toContain('ack m2:claude (closeCount=0)'); // delivery acked before any close
    expect(log.indexOf('gateway-close #1')).toBeGreaterThan(log.indexOf('ack m2:claude (closeCount=0)'));
  }, 10_000);

  test('standalone wait: same ordering — close exactly once, after the wait settles (no early close, no leak)', async () => {
    const log: Log = [];
    const { gateway, deliver, closes } = makeFakeGateway(log);
    const flags = new Map<string, string | true>([['as', 'claude'], ['timeoutsec', '30']]);

    const result = runBrokerCli('wait', flags, [], 'unused-root', () => gateway);
    await Bun.sleep(20);
    expect(log).toContain('subscribe (closeCount=0)');
    expect(closes()).toBe(0);

    deliver('m3:claude');
    expect(await result).toBe(0);
    expect(closes()).toBe(1); // pre-fix the standalone path LEAKED the gateway (close was an early no-op)
    expect(log.indexOf('gateway-close #1')).toBeGreaterThan(log.indexOf('ack m3:claude (closeCount=0)'));
  }, 10_000);

  test('ask alias (recursive runBrokerCli): factory is forwarded and ordering holds through the recursion', async () => {
    const log: Log = [];
    const { gateway, deliver, closes } = makeFakeGateway(log);
    let factoryCalls = 0;
    const flags = new Map<string, string | true>([['from', 'claude'], ['to', 'codex'], ['message', 'x']]);

    const result = runBrokerCli('ask', flags, [], 'unused-root', () => { factoryCalls += 1; return gateway; });
    await Bun.sleep(20);
    expect(factoryCalls).toBe(2); // outer dispatch + recursive 'send'
    expect(closes()).toBe(0); // NEITHER gateway closed while the wait is armed

    deliver('m4:claude');
    expect(await result).toBe(0);
    expect(closes()).toBe(2); // both levels closed, both after settle
  }, 10_000);
});
