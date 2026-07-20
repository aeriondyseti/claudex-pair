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

/** Bounded poll — slow scheduling must delay, never flake (codex review #3). */
async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await Bun.sleep(5);
  expect(cond()).toBeTrue();
}

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
    deliver: (id: string, replyTo?: string, headerExtra?: Record<string, unknown>) => {
      if (!pushDelivery) throw new Error('subscribe was never called');
      pushDelivery({ deliverySeq: 1, deliveryId: id, message: { name: `${id}.md`, header: { id, from: 'codex', to: 'claude', type: 'answer', turn: 'pass', sent: 's', ...(replyTo ? { replyTo } : {}), ...(headerExtra ?? {}) }, body: 'b', raw: 'raw-body' } as Delivery['message'] });
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
    // Wait (bounded) for the send to commit and the fused wait to arm.
    await until(() => log.includes('subscribe (closeCount=0)')); // wait armed with the gateway still open
    expect(closes()).toBe(0); // the old bug: close() had already run here

    deliver('m2:claude', 'm1'); // item 7: a fused ask exits only on ITS reply
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
    await until(() => log.includes('subscribe (closeCount=0)'));
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
    await until(() => factoryCalls === 2 && log.includes('subscribe (closeCount=0)')); // outer dispatch + recursive 'send', wait armed
    expect(closes()).toBe(0); // NEITHER gateway closed while the wait is armed

    deliver('m4:claude', 'm1'); // item 7: the fused ask is thread-scoped
    expect(await result).toBe(0);
    expect(closes()).toBe(2); // both levels closed, both after settle
  }, 10_000);
});


describe('item 7: thread-scoped wait (fake gateway)', () => {
  test('wait -Thread prints and acks unrelated deliveries but exits only on the reply to the named message', async () => {
    const log: Log = [];
    const { gateway, deliver, closes } = makeFakeGateway(log);
    const flags = new Map<string, string | true>([['as', 'claude'], ['timeoutsec', '30'], ['thread', 'ask-7']]);
    const result = runBrokerCli('wait', flags, [], 'unused-root', () => gateway);
    await until(() => log.includes('subscribe (closeCount=0)'));

    deliver('m-unrelated:claude'); // no replyTo — printed + acked, wait continues
    await until(() => log.includes('ack m-unrelated:claude (closeCount=0)'));
    expect(closes()).toBe(0); // still waiting on the thread

    deliver('m-answer:claude', 'ask-7');
    expect(await result).toBe(0);
    expect(log).toContain('ack m-answer:claude (closeCount=0)');
    expect(closes()).toBe(1);
  });
});


/** Captures stdout for hint assertions; preserves write-callback semantics
 * (printDeliveryThenAck awaits the flush callback). */
function captureOut(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    const cb = rest.find((r) => typeof r === 'function') as ((e?: unknown) => void) | undefined;
    if (cb) cb();
    return true;
  };
  return { text: () => chunks.join(''), restore: () => { (process.stdout as unknown as { write: unknown }).write = original; } };
}

describe('item 7: fused ask threading and control wakes (codex blockers 1+5)', () => {
  test('fused ask ignores unrelated deliveries and exits only on its own reply', async () => {
    const log: Log = [];
    const { gateway, deliver, closes } = makeFakeGateway(log);
    const flags = new Map<string, string | true>([['from', 'claude'], ['to', 'codex'], ['type', 'ask'], ['message', 'x']]);
    const result = runBrokerCli('send', flags, [], 'unused-root', () => gateway);
    await until(() => log.includes('subscribe (closeCount=0)'));

    deliver('m-noise:claude'); // no replyTo — printed + acked, fused ask keeps waiting
    await until(() => log.includes('ack m-noise:claude (closeCount=0)'));
    expect(closes()).toBe(0);

    deliver('m-reply:claude', 'm1');
    expect(await result).toBe(0);
    expect(closes()).toBe(1);
  }, 10_000);

  test('user-channel traffic wakes a thread wait distinctly, without resolving the thread', async () => {
    const log: Log = [];
    const { gateway, deliver } = makeFakeGateway(log);
    const flags = new Map<string, string | true>([['as', 'claude'], ['timeoutsec', '30'], ['thread', 'ask-7']]);
    const capture = captureOut();
    try {
      const result = runBrokerCli('wait', flags, [], 'unused-root', () => gateway);
      await until(() => log.includes('subscribe (closeCount=0)'));
      deliver('u1:claude', undefined, { from: 'user', type: 'info', provenance: 'trusted_user_client' });
      expect(await result).toBe(0); // exits — the harness must act on the user NOW
    } finally { capture.restore(); }
    expect(capture.text()).toContain('Thread ask-7 is NOT resolved');
    expect(capture.text()).toContain('-Thread ask-7');
  }, 10_000);

  test('a thread wait timeout re-arm hint preserves -Thread', async () => {
    const log: Log = [];
    const { gateway } = makeFakeGateway(log);
    const flags = new Map<string, string | true>([['as', 'claude'], ['timeoutsec', '1'], ['thread', 'ask-7']]);
    const capture = captureOut();
    try {
      const result = runBrokerCli('wait', flags, [], 'unused-root', () => gateway);
      expect(await result).toBe(2);
    } finally { capture.restore(); }
    expect(capture.text()).toContain('-Thread ask-7');
  }, 10_000);
});

describe('item 7: pair log -Thread (codex blocker 6)', () => {
  test('prints the root and its transitive reply chain only', async () => {
    const log: Log = [];
    const { gateway } = makeFakeGateway(log);
    const stored = (id: string, replyTo?: string) => ({ name: `${id}.md`, header: { id, from: 'claude', to: 'codex', type: 'info', turn: 'keep', sent: 's', ...(replyTo ? { replyTo } : {}) }, body: 'b', raw: `raw-${id}` });
    const fixture = [stored('ask-1'), stored('u1'), stored('r1', 'ask-1'), stored('u2', 'u1'), stored('r2', 'r1')];
    const threaded = { ...gateway, log: async () => fixture as unknown as Awaited<ReturnType<CliGateway['log']>> };
    const capture = captureOut();
    try {
      const flags = new Map<string, string | true>([['thread', 'ask-1']]);
      expect(await runBrokerCli('log', flags, [], 'unused-root', () => threaded)).toBe(0);
    } finally { capture.restore(); }
    const text = capture.text();
    expect(text).toContain('raw-ask-1');
    expect(text).toContain('raw-r1');
    expect(text).toContain('raw-r2'); // transitive: r2 -> r1 -> ask-1
    expect(text).not.toContain('raw-u1');
    expect(text).not.toContain('raw-u2');
  });

  test('an unknown thread reports emptiness explicitly', async () => {
    const log: Log = [];
    const { gateway } = makeFakeGateway(log);
    const capture = captureOut();
    try {
      const flags = new Map<string, string | true>([['thread', 'nope']]);
      expect(await runBrokerCli('log', flags, [], 'unused-root', () => gateway)).toBe(0);
    } finally { capture.restore(); }
    expect(capture.text()).toContain('No archived messages in thread nope.');
  });
});
