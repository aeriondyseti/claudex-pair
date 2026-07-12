# claudex-ts architecture

Agreed 2026-07-12 by claude, codex, and agy — each produced an independent
recommendation against the same brief (see `.pair/history/`), and all three
converged on the same philosophy before synthesis. This document is the
binding layout contract for the TypeScript rewrite; change it by agreement,
not by drift.

## Philosophy

**Hexagonal (ports & adapters) around a functional core — with the functional
rule stated explicitly, because hexagonal alone is not sufficient.**

Explicitly rejected:

- **MVC** — wrong center of gravity: claudex is a protocol engine, not a UI
  application. Only the watch TUI is view-shaped, and it is one adapter, not
  an organizing principle. MVC encourages exactly the state/IO coupling the
  protocol core must never have.
- **Ceremonial Clean Architecture** (interactor/boundary/DTO proliferation) —
  too much navigation and boilerplate at 2–5k LOC; it dilutes context windows
  for the AI agents doing most of the editing and slows human comprehension.
  We keep Clean's dependency direction, not its layer count.
- **DI containers / decorators** — explicit constructor/factory wiring in the
  composition roots only.
- **Package-per-layer / monorepo project references** — one package, one
  tsconfig, until a measured need says otherwise.
- **Generic Repository abstractions** — the journal's WAL semantics
  (append, replay, checksum, recovery) are the domain contract; do not hide
  them behind CRUD verbs.
- **A `shared/` or `utils/` dumping ground** — cross-cutting primitives live
  in the lowest layer that owns them, or they don't exist.

## The functional rule (the crown jewel)

The protocol state machine is pure and event-sourced:

```ts
type CommandEnvelope<C extends Command = Command> = {
  command: C
  meta: { id: MessageId; at: Timestamp; principal: AgentId }
}

decide(state: SessionState, cmd: CommandEnvelope): Result<Event[], ProtocolError>
evolve(state: SessionState, event: Event): SessionState
```

- `decide` and `evolve` are deterministic and total. No filesystem, IPC,
  clock, process, terminal, logging, or `Date.now`/`Math.random` inside the
  core — ids, timestamps, and authenticated identity are produced at the
  edges and arrive in the envelope's `meta`.
- **Authorization is split in two, deliberately.** The edges *authenticate*:
  they establish which principal is calling and stamp it into `meta.principal`
  (the broker's IPC auth will live there). Domain capabilities — what this
  principal may do right now — are **derived from state**, not carried in the
  envelope: `decide` *authorizes* at the protocol level (turn ownership,
  driver role, grant assignment). The app layer's "authorize" step is exactly
  that call into `decide` — it holds no rules of its own.
- **Events are the WAL vocabulary** (docs/ENHANCEMENTS.md rev 7): the broker's
  journal is a log of these events, and state is replay-derived. The rewrite's
  file mailbox and the future broker share this vocabulary; only the adapters
  change.
- Every protocol invariant (one turn holder; driver ∈ agents; turn-pass only
  from holder; handoff only from driver; grant lifecycle; scope rules) lives
  in `decide` — never in an adapter, never in the CLI.

## Layout

```
src/
  core/       # PURE. types.ts commands.ts events.ts decide.ts evolve.ts
              # invariants.ts errors.ts queries.ts — imports nothing but core.
  app/        # Use-case orchestration: load → decide (authorize + transition)
              # → append → publish. OWNS the port interfaces (app/ports/):
              # Journal, Mailbox, Transport, Watcher, Clock, Identity, Renderer.
  adapters/   # Implementations, one folder per surface: fs/ (mailbox+journal,
              # today's .pair format), ipc/ (named pipes / unix sockets),
              # clock/, watcher/, tui/ (watch rendering). Outbound adapters
              # IMPLEMENT app ports; inbound/presentation adapters CALL the
              # app's public API (use-cases, query DTOs).
  apps/       # Composition roots and nothing else: cli/ (argv → use-cases →
              # exit codes) and broker/ (daemon hosting the same use-cases
              # over the ipc adapter). The ONLY place wiring happens.
tests/
  core/        # transition tables over (state, command) + property tests
  contracts/   # one reusable contract suite per port, run against every adapter
  integration/ # WAL append/replay/recovery, IPC failure modes, lock races
  e2e/         # golden scenario scripts (ported from the PowerShell smoke suites)
```

## Dependency law

```
core     → (nothing)
app      → core
adapters → app public API (use-cases, ports, query DTOs) + core types
apps     → anything (composition, argv/daemon shells — no logic)
```

Plus: **no adapter imports another adapter**; presentation code (tui) consumes
app query DTOs, not core state directly; no module cycles; no orphan modules.

## Mechanical enforcement — rules, not review comments

- **dependency-cruiser** in CI: forbidden-edge rules for every arrow above,
  cycle detection, orphan detection. A violation fails the build.
- **ESLint `no-restricted-imports`** per layer (fast feedback in-editor),
  with TS path aliases (`@core/*`, `@app/*`, `@adapters/*`) so rules bind to
  stable names.
- **Core purity check**: dependency-cruiser additionally forbids `node:*`
  imports inside `src/core/`; a lint rule bans `Date.now`, `Math.random`,
  and `process.*` there.
- CI runs: lint → depcruise → unit/property → contract → integration → e2e.

## Testing policy

- `decide`/`evolve`: table-driven transition tests + fast-check property tests
  for the invariants. This IS the P0 "spec first" artifact — the tables are
  the state machine spec.
- Every port ships a contract test suite; every adapter must pass its port's
  suite (the fs mailbox and the future broker client both pass the same
  Mailbox contract).
- WAL/recovery and IPC get dedicated failure-injection integration tests.
- The CLI stays thin enough that a handful of golden e2e scenarios (the
  PowerShell smoke suites, ported) suffice.

## Migration seam

The current CLI and the future broker are **two inbound compositions over the
same app use-cases**. Direct-file mutation is a temporary outbound adapter;
broker mode swaps the composition root to the authoritative journal + IPC
client **without moving a single protocol rule**. When the broker lands
(ENHANCEMENTS.md P0), `apps/cli` switches its wiring; `core/` and `app/` do
not change.
