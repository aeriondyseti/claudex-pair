/** Pure domain types. This module (like all of core/) imports nothing. */

export type AgentId = string;
export type GrantId = string;
export type MessageId = string;
/** 'yyyy-MM-dd HH:mm:ss' — formatted at the edges, opaque here. */
export type Timestamp = string;

export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,15}$/;

/** Item 7 round 2: safe id syntax for reply_to (and ids generally) — no
 * whitespace/newlines/header delimiters, bounded length. Fail-closed at
 * decide; the CLI casts untrusted strings into these fields. */
export const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** M1: session identity minted once at init (deferred here from item 7). */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

/** M1 per-agent config: display is free text minus control chars (it is
 * presentation-only and never enters paths or headers); cliType/role use
 * the agent-name grammar. */
export const DISPLAY_PATTERN = /^[^\u0000-\u001f\u007f]{1,64}$/;
export type AgentMeta = { readonly display?: string; readonly cliType?: string; readonly role?: string };

export type MessageType =
  | 'ask'
  | 'answer'
  | 'review'
  | 'handoff'
  | 'info'
  | 'done'
  | 'grant'
  | 'grant-done'
  | 'grant-cancel'
  | 'propose-end'
  | 'turn-revoked'
  | 'leave'
  | 'join'
  | 'kick';

/** Runtime mirror of MessageType (keep in sync) — decide validates against
 * this fail-closed because transport casts arbitrary strings to the union. */
export const MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'ask', 'answer', 'review', 'handoff', 'info', 'done', 'grant', 'grant-done',
  'grant-cancel', 'propose-end', 'turn-revoked', 'leave', 'join', 'kick',
] satisfies MessageType[]);

export type TurnMode = 'pass' | 'keep';

export type GrantScope =
  | { mode: 'worktree'; worktree: string }
  | { mode: 'files'; files: readonly string[] };

export type GrantState = 'offered' | 'active' | 'done' | 'cancelled';

export type Grant = {
  readonly id: GrantId;
  readonly issuer: AgentId;
  readonly assignee: AgentId;
  readonly task: string;
  readonly scope: GrantScope;
  readonly state: GrantState;
  readonly agreedIn: MessageId | '';
  readonly result: string;
  readonly revision: number;
  readonly created: Timestamp;
  readonly updated: Timestamp;
};

/** M1 registry: lifecycle record per participant, ids-vs-display split.
 * The id is the filesystem-safe protocol identity (AGENT_NAME_PATTERN);
 * display is presentation-only and never appears in paths or headers. */
export type AgentLifecycle = 'active' | 'left';
export type AgentRecord = {
  readonly id: AgentId;
  readonly display: string;
  /** Optional adapter hint (claude/codex/agy/...); empty in v1 unless declared. */
  readonly cliType?: string;
  readonly role?: string;
  readonly status: AgentLifecycle;
  readonly joinedAt: Timestamp;
  readonly leftAt?: Timestamp;
};

/** M1: bounded practical roster limit — registry-defined, fail-closed at
 * init AND join. Raising it is a deliberate registry change, not implied
 * unbounded scaling (ENHANCEMENTS M1). */
export const MAX_AGENTS = 8;

export type Registry = {
  /** Monotonic; bumps on every membership change. Electorate snapshots and
   * observer catch-up (PEER-MODEL prereq 3) key on this. */
  readonly version: number;
  readonly agents: Readonly<Record<AgentId, AgentRecord>>;
};

/** Statuses partition into LIVE (active, paused) and TERMINAL (completed).
 * Surfaces must branch on the partition, never on !== 'active' (U1 slice 4b,
 * design REV 6 R2). */
export type SessionStatus = 'active' | 'paused' | 'completed';
export const LIVE_STATUSES: readonly SessionStatus[] = ['active', 'paused'];

export type SessionState = {
  readonly task: string;
  readonly agents: readonly AgentId[];
  readonly driver: AgentId;
  readonly turn: AgentId;
  readonly status: SessionStatus;
  readonly started: Timestamp;
  readonly grants: Readonly<Record<GrantId, Grant>>;
  /** M1: session identity — minted at init from M1 on; absent only on
   * pre-M1 sessions. Conversational message headers carry it (`session:`). */
  readonly sessionId?: string;
  /** M1: full lifecycle registry. `agents` above remains the LIVE-member
   * projection (evolve keeps both consistent) — existing validation and
   * turn logic read the projection unchanged. */
  readonly registry: Registry;
  /** U1: sha256 of the bound user-channel token. Journal-authoritative via
   * the user-channel-registered event — a hash is safe in agent-readable
   * mirrors (auth needs the preimage); slice 3 has no reset path. */
  readonly userChannelTokenHash?: string;
};

/** U1: the reserved user identity — outside the roster, never a
 * participant, turn holder, grant assignee, or message recipient (v1). */
export const USER_IDENTITY = 'user';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T, E = never>(value: T): Result<T, E> => ({ ok: true, value });
export const err = <E, T = never>(error: E): Result<T, E> => ({ ok: false, error });
