# IPC transport surface

The broker composition root supplies a frame handler to `IpcServer`; transport
authenticates the repository token and epoch before dispatch. `ServerConnection`
lets the broker push delivery frames without exposing sockets.

The CLI composition root uses `IpcClient.execute/query/subscribe/ack/extend`.
Execute/query retain the same request ID across reconnect retries. Protocol
decisions, durable idempotency, delivery leases, and acknowledgment ordering stay
above this adapter in the broker and CLI application layers.
