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
 * F15–F22 (W2c: turn revocation 8a + roster/close authority 11):
 *
 * - F15 revoke-vs-reply race        → tests/broker/matrix-server.test.ts (both orders)
 * - F16 partner-active lease guard  → tests/broker/matrix-server.test.ts
 * - F17 leave returns turn same txn → tests/core/roster-revoke.test.ts
 * - F18 removal voids deliveries    → tests/broker/matrix-server.test.ts (server slice);
 *                                     client-driven rejoin flow lands with the W2c CLI lane
 * - F19 end-not-driver (end + raw done-send) → tests/core/transitions.jsonl DEC-29/30/31
 * - F20 leave-with-grant            → tests/core/transitions.jsonl DEC-36/37
 * - F21 kick cancels grants same txn → tests/core/roster-revoke.test.ts
 * - F22 init-not-driver             → tests/core/transitions.jsonl DEC-28 (+ DEC-04 ordering)
 *
 * This file is intentionally test-free: it is the index of the matrix.
 */
export {};
