import { describe, test } from 'bun:test';

/**
 * BROKER-SPEC failure-matrix COVERAGE MAP. The W1 skeleton's F1–F14 todos
 * are all implemented as concrete tests; this file records where, so the
 * matrix has one canonical index and `bun test` no longer reports
 * implemented behavior as TODO:
 *
 * - F1  torn tail                    → tests/broker/journal.test.ts
 * - F2  crash-before-ack dedup       → tests/broker/journal.test.ts
 *                                      + live wire replay in tests/integration/broker-client.test.ts
 * - F3  double spawn race            → tests/integration/broker-client.test.ts (spawn readiness);
 *                                      real-daemon variant in tests/e2e/broker-real.test.ts (non-Windows)
 * - F4  unacked delivery → lease expiry → redelivery
 *                                    → tests/integration/broker-client.test.ts; real-daemon (non-Windows)
 * - F5  duplicate wait, exactly-once ack (+ open/unacked beats cursor on
 *       out-of-order-ack resubscribe) → tests/integration/broker-client.test.ts
 * - F6  crc corruption mid-history   → tests/broker/journal.test.ts
 * - F7  hung broker fencing / PID-reuse refusal / unverifiable identity
 *                                    → tests/broker/matrix-server.test.ts
 * - F8  mirror lag rebuild vs tamper-at-parity conflict
 *                                    → tests/broker/matrix-server.test.ts
 * - F9  idle shutdown vs racing connection
 *                                    → tests/e2e/broker-real.test.ts (non-Windows; Windows covered by
 *                                      manual daemon smoke — Bun test jobs kill detached grandchildren)
 * - F10 end-vs-grant-accept race     → tests/broker/matrix-server.test.ts
 * - F11 restart redelivery from durable ledger
 *                                    → tests/broker/journal.test.ts + real-daemon (non-Windows)
 * - F12 snapshot/rotation boundaries → tests/broker/journal.test.ts
 * - F13 stale unix socket probe/unlink
 *                                    → src/adapters/ipc/ipc.test.ts (platform-skipped on Windows,
 *                                      where pipe names cannot go stale)
 * - F14 print+flush-before-ack, both crash boundaries + open-beats-cursor resume
 *                                    → tests/integration/broker-client.test.ts (loopback), unit in brokerWait
 *
 * F15–F22 (turn revocation 8a + roster/close authority 11) are W2c scope —
 * real todos below, quoting the spec so implementers convert without
 * re-reading it.
 */

describe('F15', () => {
  test.todo('revoke-vs-reply race → broker-serialized: whichever envelope commits first wins; the late reply is archived advisory (stale-turn), never a turn mutation — at no point do two agents hold the turn', () => {});
});

describe('F16', () => {
  test.todo('revoke attempt while the navigator holds a live delivery lease (heartbeating) → rejected partner-active; after lease expiry with no ack, the same revoke commits', () => {});
});

describe('F17', () => {
  test.todo('navigator leaves while holding the turn → turn returns to the driver in the same committed txn; a post-rejoin reply bearing the old turn is stale (per F15)', () => {});
});

describe('F18', () => {
  test.todo('leave/kick with enqueued undelivered deliveries → voided to the archive in the same committed txn; nothing is ever delivered to a removed agent; a later rejoin starts from a fresh delivery cursor (no stale redelivery)', () => {});
});

describe('F19', () => {
  test.todo('navigator end-session or done-send → rejected end-not-driver; the rejection makes no state change and is not journaled (retried rejections re-evaluate per the retry contract)', () => {});
});

describe('F20', () => {
  test.todo('voluntary leave while holding an offered/active grant → rejected leave-with-grant; after grant-done or a driver cancel, the same leave commits', () => {});
});

describe('F21', () => {
  test.todo('kick of a grant-holding navigator → open grants cancelled in the same committed txn (the stop-notice to the kicked agent is voided with its other deliveries); grant scope/worktree ownership released; driver reissues to reassign', () => {});
});

describe('F22', () => {
  test.todo('init issued by a principal other than the declared driver → rejected init-not-driver (roster authority is uniform from session creation onward)', () => {});
});
