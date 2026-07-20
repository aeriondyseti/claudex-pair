import type { AwaitingEntry } from '@core/awaiting.ts';
import type { Event } from '@core/events.ts';
import type { SessionState } from '@core/types.ts';
import type { StoredMessage } from '@app/ports/index.ts';
import type { OpenDelivery } from './journal.ts';

/**
 * Broker-owned ports (depcruise: src/broker never imports adapters — the
 * composition root injects implementations, BROKER-SPEC layer placement).
 */

export type { OpenDelivery };

/** The on-disk message shape mirrors serialize (fs adapter's PairMessage). */
export type MirrorMessage = {
  id: string;
  from: string;
  to: string;
  type: string;
  turn: string;
  sent: string;
  /** Item 7: serialized as `reply_to:` (optional, backward compatible). */
  replyTo?: string;
  body: string;
};

/** Filename + raw-markdown derivation, kept in lockstep with the fs adapter. */
export interface MessageCodec {
  filename(message: MirrorMessage): string;
  raw(message: MirrorMessage): string;
}

export class MirrorConflictError extends Error {
  constructor(details: string) {
    super(`Mirror divergence at journal parity (external mutation?): ${details}. Broker is read-only; run pair doctor.`);
  }
}

/**
 * Broker-written `.pair/` mirror views + manifest (BROKER-SPEC "Storage").
 * reconcile throws MirrorConflictError on divergence AT journal parity;
 * behind-head is lag and rebuilds unconditionally.
 */
export interface MirrorStore {
  applyInit(state: SessionState): Promise<{ gitignoreUpdated: boolean }>;
  applyEvents(state: SessionState, events: readonly Event[], seq: number): Promise<void>;
  applyAck(delivery: OpenDelivery, seq: number): Promise<void>;
  reconcile(state: SessionState | undefined, openDeliveries: readonly OpenDelivery[], headSeq: number): Promise<'clean' | 'rebuilt'>;
  archived(last?: number): Promise<readonly StoredMessage[]>;
}

export type DeliveryPush = {
  kind: 'delivery';
  deliverySeq: number;
  deliveryId: string;
  message: StoredMessage;
};

/** A live subscriber connection, as the broker core sees it. */
export type DeliverySink = {
  readonly id: string;
  sendDelivery(push: DeliveryPush): Promise<void>;
  sendError(code: string, message: string): Promise<void>;
};

export type ObserverPushWire =
  | {
      kind: 'activity';
      seq: number;
      at: string;
      principal: string;
      events: readonly Event[];
      session: SessionState;
      ackedDeliveryIds: readonly string[];
      voidedDeliveryIds: readonly string[];
      /** Item 7: the post-commit journal-authoritative awaiting-set. */
      awaiting: readonly AwaitingEntry[];
    }
  | { kind: 'presence'; liveness: unknown };

/**
 * A live watch connection. Observers are NOT subscribers: no delivery
 * leases, no acks, no agent identity — a failed push just drops the
 * observer (it reattaches with a fresh snapshot; nothing is owed to it).
 */
export type ObserverSink = {
  readonly id: string;
  sendObserver(push: ObserverPushWire): Promise<void>;
};
