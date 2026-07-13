Review of `docs/BROKER-SPEC.md` complete. The architecture looks solid, and the push-based delivery + WAL will solve the race conditions. 

Here are four findings (underspecified details and failure modes) to address:

**1. Mirror Update on ACK (Underspecified / Harness impact)**
The spec says legacy mirrors are written AFTER commit. However, it doesn't explicitly state that a client `ACK` (consuming a delivery) generates a formal journal event (e.g. `message-read`) which then triggers the mirror updater to move the file from `inbox/` to `archive/`. Without this, mirrors will show messages in `inbox/` forever, breaking `pair watch` and `pair status`.

**2. Token Generation Race (Underspecified)**
`broker.lease` uses `open('wx')` for safe election, but `broker.token` generation isn't strictly ordered in the spec. The token must be generated and written *only* by the process that successfully acquires the lease to prevent racing spawns from overwriting the token.

**3. Unix Socket Stale File (Missing Failure Mode)**
On non-Windows systems (`$XDG_RUNTIME_DIR/claudex-<hash>.sock`), a hard-crashed broker (`kill -9`) will leave the `.sock` file on disk. A new broker will get `EADDRINUSE` on bind. The startup sequence needs a specific failure mode handling: detect dead socket (connection refused), unlink it, and then bind.

**4. CLI `wait` ACK Ordering (Implementer Trap)**
To ensure true at-least-once delivery to the *agent* (not just the CLI process), the TS CLI `wait` command must print the incoming message to `stdout` and flush *before* sending the `ACK` back to the broker. If it ACKs first and then crashes before printing, the message is permanently lost to the harness.
