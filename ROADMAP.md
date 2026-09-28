# claudex roadmap

Direction-level work items, taken on **one at a time**, in order. Each item gets
its own design pass (and, where it changes the protocol, a cross-agent review)
before implementation starts. Detailed prior designs live in `docs/`
(`ENHANCEMENTS.md`, `PEER-MODEL.md`, `THROUGHPUT-SPRINT.md`); this file only
tracks what is next and why.

| # | Item | Status |
|---|---|---|
| R1 | Equal-partner mode as the default and only mode | planned (next) |
| R2 | Investigate native Claude Code / Codex messaging as the transport | planned |

---

## R1 — Equal-partner mode as the default and only mode

**Goal.** Agents collaborate as equal partners. Neither agent directs or
delegates to the other, and the partnership is the only mode the project supports
for now.

**Today.** Two topologies exist:

- `pair` (the default, `-Topology pair`): one **driver** edits and all other
  agents are **navigators** who review but never edit. A single turn token and
  `handoff` move authority between them. The roles are hierarchical by
  construction.
- `peer` (`-Topology peer`, see `docs/PEER-MODEL.md`): equal authority, with
  phased planning, blind-proposal barriers, votes, a claims board, per-peer
  workspaces and branch sagas. It is heavy machinery aimed at N-agent parallel
  decomposition.

Neither topology matches "two equals working together without delegation".

**Scope.**

1. Define the equal-partner working model, meaning the rules that replace
   driver/navigator and turn-holding. Answer the open questions below first.
2. Make it the default. `pair init` needs no topology flag.
3. Simplify so that it is the only supported mode. Remove the unused topologies
   from `core` (`decide`, commands, state), the broker, the CLI flags, the
   TUI/watch views, `PROTOCOL.md`, the three `instructions/*-pairing.md` files,
   and the `/pair` / `$pair` skills. Delete the dead tests with the code.
   Removed designs stay in `docs/` as history.
4. Keep what is not role-specific: the broker, the WAL, wake packets, batched
   asks, async review (`review-request` → `verdict` → `review-resolve`),
   `pair stats`, `watch`, and memory.

**Open questions (decide at the start of R1).**

- Is the target a simplified `peer` topology (keep claims and per-agent
  workspaces, drop the planning and vote barriers), or `pair` with the
  driver/navigator split removed (shared worktree, both edit, coordination by
  message)? The answer determines how much of `docs/PEER-MODEL.md` survives.
- If both agents can edit, what prevents them from editing the same file at
  once? Options are file/area claims, separate worktrees with merges, or
  convention only.
- Does the turn token survive at all (for example, only for blocking decisions),
  or does the model become fully asynchronous?
- Are 3+ agents (agy) still in scope, or does "only mode" also mean two agents?
- Is compatibility with existing `.pair/` sessions and WAL journals needed, or
  is a clean break acceptable?

**Done when:** one mode exists end to end (core → broker → CLI → skills →
instructions → docs), it is the default, and the full test suite passes with the
removed modes' code and tests gone.

---

## R2 — Investigate native Claude Code / Codex messaging as the transport

**Goal.** Find out whether Claude Code and Codex can talk to each other through
their own built-in messaging and session machinery, instead of (or underneath)
the `.pair/` mailbox plus broker. The hoped-for gains are real push delivery (no
blocking `pair wait` loop), less custom infrastructure, and a more natural
experience inside each CLI.

**Type.** This item is a research spike that produces a written recommendation.
It is not an implementation. It follows R1 because the transport must carry the
equal-partner model, not the old roles.

**Leads to evaluate** (verify each one against current docs and versions; none
are confirmed fit for this purpose):

- **Claude Code:** agent teams and teammate messaging (`SendMessage`, listing
  local sessions), MCP *channels* that push events into a running session,
  hooks (for example Stop/Notification hooks that inject partner messages),
  Remote Control, and the Agent SDK/headless mode.
- **Codex CLI:** the app-server JSON-RPC protocol, `codex mcp-server` (Codex as
  an MCP server that Claude could call), `codex exec` / resume for
  non-interactive turns, and notify hooks.
- **Bridging:** an MCP server shared by both CLIs as the message bus, which
  could be a thin façade over the existing broker.

**Questions to answer.**

- Can each side receive a message *while interactive in its own pane*, without
  the human's terminal being taken over? The hard constraint from
  `docs/ENHANCEMENTS.md` still applies: the human owns the terminals and
  claudex never automates panes.
- Delivery guarantees: ordering, durability across crashes and restarts, and
  what happens when an agent is mid-turn. How does each lead compare with the
  WAL's durable-before-ack?
- Is it available on Windows, and how stable is it (experimental flags,
  version churn)?
- What can be retired if a lead is adopted (`pair wait`, wake packets, parts of
  the broker), and what must stay (the audit log, `watch`, `stats`)?
- Does Antigravity CLI (agy) have an equivalent, or would it stay on the
  mailbox?

**Deliverable:** `docs/NATIVE-MESSAGING.md` recommending one of adopt, adopt
behind the broker, or stay on the mailbox. It includes a small proof of concept
for the most promising lead (one message delivered each way, Claude ↔ Codex) and
the follow-up roadmap items the recommendation implies.
