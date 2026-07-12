# Filesystem adapter surface

The app ports should keep protocol decisions outside this adapter and request
only persistence mechanics:

- session: `initialize`, `load`, `save`
- mailbox: `publish`, `claimAll`
- grants: `create`, `read`, `transition`

`transition` owns the legacy per-grant filesystem lock and compare-state/write
transaction. The app should supply an active-session guard callback (or perform
the session-status recheck under a broader journal transaction) when ports are
bound; the standalone adapter cannot atomically lock two independent stores.
