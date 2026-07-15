export type WireBase = { token: string; epoch: number; clientId: string };
export type ExecuteFrame = WireBase & { kind: 'execute'; reqId: string; as: string; envelope: unknown };
export type QueryFrame = WireBase & { kind: 'query'; reqId: string; what: string; args?: unknown };
export type SubscribeFrame = WireBase & { kind: 'subscribe'; reqId: string; as: string; afterDeliverySeq: number };
export type AckFrame = WireBase & { kind: 'ack'; reqId: string; deliveryId: string };
export type ExtendFrame = WireBase & { kind: 'extend'; reqId: string; deliveryId: string };
/**
 * Non-consuming observer attach (watch). Deliberately carries NO `as`: an
 * observer is not a participant — it never holds delivery leases, never
 * acks, and never appears in agent liveness (TUI-UPGRADE-NOTES constraint 2).
 */
export type ObserveFrame = WireBase & { kind: 'observe'; reqId: string };
export type ClientFrame = ExecuteFrame | QueryFrame | SubscribeFrame | AckFrame | ExtendFrame | ObserveFrame;

export type ErrorFrame = { reqId?: string; ok: false; error: { code: string; message: string } };
export type ResponseFrame = { reqId: string; ok: true; seq?: number; events?: unknown[]; data?: unknown } | ErrorFrame;
export type DeliveryFrame = { kind: 'delivery'; deliverySeq: number; deliveryId: string; message: unknown };
/**
 * Observer pushes. `activity` mirrors one committed journal txn (seq is the
 * commit seq — a DIFFERENT sequence space from deliverySeq); `presence` is
 * non-journaled listener liveness, pushed on subscribe/close/delivery.
 */
export type ObserverPushFrame =
  | { kind: 'activity'; seq: number; at: string; principal: string; events: unknown[]; session: unknown; ackedDeliveryIds: string[]; voidedDeliveryIds: string[] }
  | { kind: 'presence'; liveness: unknown };
export type ServerFrame = ResponseFrame | DeliveryFrame | ObserverPushFrame;

export type FrameHandler = (frame: ClientFrame, connection: ServerConnection) => Promise<ServerFrame | void> | ServerFrame | void;
export type ServerConnection = { readonly id: string; send(frame: ServerFrame): Promise<void> };
