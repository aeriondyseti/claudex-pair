export type WireBase = { token: string; epoch: number; clientId: string };
export type ExecuteFrame = WireBase & { kind: 'execute'; reqId: string; as: string; envelope: unknown };
export type QueryFrame = WireBase & { kind: 'query'; reqId: string; what: string };
export type SubscribeFrame = WireBase & { kind: 'subscribe'; as: string; afterDeliverySeq: number };
export type AckFrame = WireBase & { kind: 'ack'; deliveryId: string };
export type ExtendFrame = WireBase & { kind: 'extend'; deliveryId: string };
export type ClientFrame = ExecuteFrame | QueryFrame | SubscribeFrame | AckFrame | ExtendFrame;

export type ErrorFrame = { reqId?: string; ok: false; error: { code: string; message: string } };
export type ResponseFrame = { reqId: string; ok: true; seq?: number; events?: unknown[]; data?: unknown } | ErrorFrame;
export type DeliveryFrame = { kind: 'delivery'; deliverySeq: number; deliveryId: string; message: unknown };
export type ServerFrame = ResponseFrame | DeliveryFrame;

export type FrameHandler = (frame: ClientFrame, connection: ServerConnection) => Promise<ServerFrame | void> | ServerFrame | void;
export type ServerConnection = { readonly id: string; send(frame: ServerFrame): Promise<void> };
