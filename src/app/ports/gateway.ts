import type { AgentId, Grant, SessionState } from '@core/types.ts';
import type { Command } from '@core/commands.ts';
import type { Event } from '@core/events.ts';
import type { StoredMessage, CommitReceipt } from './index.ts';

/**
 * ProtocolGateway — the single authority boundary for protocol mutations
 * (BROKER-SPEC "W2 gateway contract"; frozen with codex 2026-07-14 before
 * the W2a parallel branches).
 *
 * The caller submits a COMMAND with its authenticated principal. The
 * authority behind the gateway (broker daemon in broker mode; the local
 * file-mode adapter otherwise) stamps id/timestamp, runs `decide` against
 * CURRENT state, persists, and returns the authoritative outcome.
 *
 * Deliberately NOT part of this surface: client-side `decide` results.
 * Shipping client-decided events across a process boundary is a stale-state
 * TOCTOU and lets a client bypass authorization — the broker re-decides
 * everything. `ProtocolStore` (index.ts) remains the file-mode-internal
 * persistence port; it is never remoted.
 *
 * Import rule (frozen): this module imports from ./index.ts and is imported
 * DIRECTLY as `@app/ports/gateway.ts`. It is deliberately never re-exported
 * from ./index.ts — re-exporting would create a barrel cycle.
 */

/** Identity a client presents for durable idempotency (BROKER-SPEC dedup). */
export type RequestIdentity = {
  /** Stable for the lifetime of one CLI process (crypto.randomUUID at start). */
  readonly clientId: string;
  /** Unique per logical request; reused VERBATIM across reconnect retries. */
  readonly reqId: string;
};

export type ExecuteRequest = {
  /** The authenticated principal — the agent this client acts as. */
  readonly as: AgentId;
  readonly command: Command;
  readonly identity: RequestIdentity;
};

/**
 * Authoritative result of a committed execute. `session` is the post-commit
 * state — the CLI renders from THIS, never from `.pair/` mirrors, which are
 * views updated after ack and may lag (BROKER-SPEC "Mirrors").
 */
export type ExecuteOutcome = {
  /**
   * Committed journal seq — broker mode only. Absent in file mode, which has
   * no durable sequence; a fabricated counter would imply false monotonicity.
   */
  readonly seq?: number;
  readonly events: readonly Event[];
  readonly receipt: CommitReceipt;
  readonly session: SessionState;
  /** init-session only. */
  readonly gitignoreUpdated?: boolean;
};

/** Liveness facts only the broker can observe (ENHANCEMENTS item 8). */
export type LivenessDto = {
  readonly broker?: { readonly pid: number; readonly epoch: number; readonly heartbeatAt: string };
  readonly agents: Readonly<Record<AgentId, { readonly connectedSince?: string; readonly lastActivity?: string }>>;
};

/** Wire-safe status projection (no Maps — Records only). */
export type StatusDto = {
  readonly session: SessionState;
  readonly navigators: readonly AgentId[];
  readonly openGrants: readonly Grant[];
  readonly pending: Readonly<Record<AgentId, readonly StoredMessage[]>>;
  readonly recent: readonly StoredMessage[];
  /** Absent in file mode — file mode has no listener signal to report. */
  readonly liveness?: LivenessDto;
  /** Item 7 threading: asks not yet validly answered. Journal-authoritative:
   * replayed with the records and persisted in snapshots, so cap pressure
   * on the transcript ring never loses an unresolved ask (broker mode). */
  readonly awaiting?: readonly { readonly messageId: string; readonly from: AgentId; readonly to: AgentId; readonly sentAt: string }[];
};

export type Delivery = {
  /** Monotonic ledger cursor assigned at enqueue — ordering + resume. */
  readonly deliverySeq: number;
  /** `<messageId>:<recipient>` — identity for ack/dedup, not ordering. */
  readonly deliveryId: string;
  readonly message: StoredMessage;
};

/**
 * An open subscription for one agent. At-least-once: consumers dedup by
 * deliveryId; ack ONLY after the delivered message has been written to
 * stdout and flushed (BROKER-SPEC F14).
 */
export interface DeliverySubscription {
  readonly deliveries: AsyncIterable<Delivery>;
  ack(deliveryId: string): Promise<void>;
  /** Extend the delivery lease during long processing (default 90s). */
  extend(deliveryId: string): Promise<void>;
  close(): Promise<void>;
}

export interface ProtocolGateway {
  /**
   * Commit a command. Throws ProtocolError (stable `code`) on rejection —
   * rejections make no state change and re-evaluate on retry; committed
   * successes replay their recorded outcome under the same RequestIdentity.
   */
  execute(request: ExecuteRequest): Promise<ExecuteOutcome>;
  status(): Promise<StatusDto>;
  log(tail?: number): Promise<readonly StoredMessage[]>;
  /** All grants regardless of state (the CLI `grants` listing). */
  grants(): Promise<readonly Grant[]>;
  /**
   * Resume delivery from the client's last ACKED cursor — never an observed
   * or printed-but-unacked one: a crash between print and ack must lead to
   * REDELIVERY (F14). **Open/unacked beats cursor**: the broker ALWAYS first
   * redelivers every open delivery for this agent regardless of the cursor
   * (out-of-order acks can leave seq 9 open while 10 is acked; a cursor of
   * 10 must not suppress 9), then streams new deliveries after the cursor —
   * the cursor suppresses only already-closed history. A fresh process with
   * no durable cursor passes 0. Commit seq is NOT a delivery cursor.
   */
  subscribe(as: AgentId, afterDeliverySeq: number): Promise<DeliverySubscription>;
  /**
   * Release the underlying connection/resources deterministically. One-shot
   * CLI commands and tests call this in finally; without it, idle shutdown
   * (F9) cannot be exercised deterministically. File mode: no-op.
   */
  close(): Promise<void>;
}

/** One transcript entry as the observer snapshot serves it. */
export type ObserverTranscriptEntry = {
  readonly message: StoredMessage;
  /** Enqueued and not yet acked (open delivery). */
  readonly pending: boolean;
  /** Closed without consumption — recipient was removed (F18/F21). */
  readonly voided?: boolean;
};

/**
 * Authoritative watch snapshot, served by the broker at observe-attach time
 * (TUI-UPGRADE-NOTES "broker-native read-only watch"). `seq` is the journal
 * head the snapshot was assembled at. The transcript is journal-derived
 * (bounded recent-history ring) — never a mirror read, so no parity/tamper
 * validation is owed here. A freshly restarted broker serves only the
 * post-snapshot history it actually holds.
 */
export type ObserverSnapshotDto = {
  readonly seq: number;
  readonly session: SessionState;
  readonly transcript: readonly ObserverTranscriptEntry[];
  /** Item 7: journal-authoritative awaiting-set (absent only from a
   * pre-item-7 broker). */
  readonly awaiting?: readonly { readonly messageId: string; readonly from: AgentId; readonly to: AgentId; readonly sentAt: string }[];
  readonly liveness: LivenessDto;
  readonly broker: { readonly pid: number; readonly epoch: number; readonly endpoint: string; readonly heartbeatAt: string };
  /** U1: present only on a SUCCESSFUL user-attach snapshot — plain observe
   * never carries it. Client-local credential errors are pre-attach host
   * state, never observable here (approved design, editorial fix 3). */
  readonly userChannel?: { readonly registered: boolean; readonly authenticated: boolean };
};

/**
 * Observer stream elements. `activity` mirrors one committed txn: post-commit
 * session state rides along so consumers never evolve state client-side;
 * ack txns arrive with empty events and the acked delivery ids. `presence`
 * is non-journaled listener liveness (item 8), pushed when it changes.
 */
export type ObserverPush =
  | {
      readonly kind: 'activity';
      /** Journal commit seq — NOT a delivery cursor (different sequence space). */
      readonly seq: number;
      readonly at: string;
      readonly principal: string;
      readonly events: readonly Event[];
      readonly session: SessionState;
      readonly ackedDeliveryIds: readonly string[];
      readonly voidedDeliveryIds: readonly string[];
      /** Item 7: post-commit awaiting-set (absent from a pre-item-7 broker
       * — consumers keep their previous view). */
      readonly awaiting?: readonly { readonly messageId: string; readonly from: AgentId; readonly to: AgentId; readonly sentAt: string }[];
    }
  | { readonly kind: 'presence'; readonly liveness: LivenessDto };

/**
 * A live read-only observation of the session. NON-CONSUMING by contract:
 * attaching never creates a delivery lease, never acks or voids mail, never
 * moves an agent cursor, and never blocks revoke-turn as partner-active.
 * There is no history replay: a reconnecting observer attaches fresh and
 * rebuilds its view from the new snapshot (compaction-safe by construction).
 */
export interface ObserverSession {
  readonly snapshot: ObserverSnapshotDto;
  readonly pushes: AsyncIterable<ObserverPush>;
  close(): Promise<void>;
}

/**
 * U1: the authenticated user channel — ONE object owning snapshot, pushes,
 * and send over the SAME connection (connection-bound auth; separate
 * observer and sender connections would violate the frozen contract).
 * send() is a single wire attempt with an IMMUTABLE identity: retries are
 * composer-visible (pending-error → Enter re-submits the SAME reqId after
 * the host reattached/reauthenticated), and journal dedup makes them safe.
 */
export interface UserObserverSession extends ObserverSession {
  send(reqId: string, target: AgentId | '*', body: string): Promise<void>;
  /** U1 slice 4: privileged action on the SAME authenticated connection.
   * reqId is minted at CONFIRM time (freeze-then-mint) and reused verbatim
   * on retries — the broker dedups by it. */
  action(reqId: string, action: unknown): Promise<void>;
}

/** Broker daemon status — meaningful before/without any session. */
export type BrokerStatusDto = {
  readonly running: boolean;
  readonly pid?: number;
  readonly epoch?: number;
  readonly endpoint?: string;
  readonly heartbeatAt?: string;
  readonly connections?: number;
  readonly journalHeadSeq?: number;
  readonly openDeliveries?: number;
};

/**
 * Daemon lifecycle control (`pair broker status|stop`) — a separate surface
 * from ProtocolGateway because it exists pre-session and must not be
 * conflated with protocol queries. stop() drains: refuse new execute/
 * subscribe, finish the in-flight txn, respond to the stop requester, close
 * connections, release the lease, exit. Open unacked deliveries are durable
 * and redeliver on next start (F11) — never a stop blocker.
 */
export interface BrokerControl {
  brokerStatus(): Promise<BrokerStatusDto>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
