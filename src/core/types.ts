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
  | 'kick'
  | 'proposal';

/** Runtime mirror of MessageType (keep in sync) — decide validates against
 * this fail-closed because transport casts arbitrary strings to the union. */
export const MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'ask', 'answer', 'review', 'handoff', 'info', 'done', 'grant', 'grant-done',
  'grant-cancel', 'propose-end', 'turn-revoked', 'leave', 'join', 'kick', 'proposal',
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
  /** Peer 1A: PUBLIC credential-binding metadata — the verifier hash is
   * broker-private (journal privateBindings), never here (codex rev 4). */
  readonly binding?: { readonly bindingId: string; readonly credentialVersion: number; readonly boundAt: Timestamp };
};

/** Peer 1A: agent credentials are agent-generated 32 random bytes, wire
 * encoding frozen as lowercase hex (same grammar as the U1 user token). */
export const AGENT_CREDENTIAL_PATTERN = /^[0-9a-f]{64}$/;

/** Peer 1A: durable human-attention item — loud TOFU, admission deadlines
 * and no-show paging must survive with no watch pane attached. 1B-c adds
 * 'findings-blocked' — one aggregate item per departed agent whose open/
 * answered findings can no longer progress. */
export type AttentionItem = {
  readonly id: string;
  /** 1C adds 'ballot-stalled' (a ballot-electorate member left/was kicked
   * while a ballot was open — unanimity cannot complete without a rejoin,
   * a vote, or a user force) and 'round-cap' (a ballot closed rejected at
   * or beyond ROUND_CAP — the convergence is livelocked; the human must
   * arbitrate, re-scope, or force the phase). Peer slice 2 adds
   * 'deadline-expired' (an admitting/collecting deadlineAt is in the past —
   * the broker's deadline watcher pages the human; it NEVER auto-acts). */
  readonly category: 'tofu-bind' | 'findings-blocked' | 'ballot-stalled' | 'round-cap' | 'deadline-expired';
  readonly detail: string;
  readonly at: Timestamp;
};

/** 1B: the broker's internal sender for protocol-authored notices —
 * STRUCTURALLY outside AGENT_NAME_PATTERN, so it can never be an agent
 * name, principal, or target; legacy agents literally named 'broker'
 * stay valid (rev 4 #1). */
export const BROKER_SENDER = '@broker';

/** 1B canonical empty draft (revision 0) hash: sha256(''). */
export const EMPTY_DRAFT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** 1B resource bounds (design rev 3/4; raw UTF-8 bytes, Buffer.byteLength). */
export const PROPOSAL_MAX_BYTES = 65_536;
export const PROPOSALS_TOTAL_MAX_BYTES = 524_288;

/** 1B-b: convergence draft bounds. DRAFT_REVISIONS_MAX bounds revisionLog
 * growth — draft-history-exhausted is a PURE rejection (commits nothing)
 * once reached, telling the human the convergence has likely livelocked. */
export const DRAFT_MAX_BYTES = 131_072;
export const DRAFT_REVISIONS_MAX = 256;

/** 1B-c: findings bounds. FINDING_TEXT_MAX bounds a single critique/response
 * body; FINDINGS_MAX bounds the count of distinct findings; REASONS_MAX bounds
 * one finding's history length (creation counts as the first entry);
 * FINDINGS_TEXT_TOTAL_MAX bounds the artifacts store's cumulative text bytes. */
export const FINDING_TEXT_MAX = 4_096;
export const FINDINGS_MAX = 128;
export const REASONS_MAX = 16;
export const FINDINGS_TEXT_TOTAL_MAX = 2_097_152;

/** 1C: the ballot livelock guard (PEER-MODEL §1c). A ballot that closes
 * rejected at or beyond this many completed rotation rounds pages the human
 * (attention category 'round-cap'); call-question itself is never blocked by
 * the cap — the cap PAGES, it never auto-acts. */
export const ROUND_CAP = 3;

/** 1B text grammar: NUL and C0/C1 controls are rejected EXCEPT \n \t \r
 * (CR accepted verbatim, no normalization — Windows CRLF passes; rev 4 #4).
 * Under this grammar JSON escaping is at most 2x. */
export function findControlCharacter(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x0a && c !== 0x09 && c !== 0x0d) || (c >= 0x7f && c <= 0x9f)) return i;
  }
  return -1;
}

/** T2 (THROUGHPUT-SPRINT): sender-declared review scope — a single header
 * line ('base..head [-- paths]') carried on send. Bounded and control-char
 * free (INCLUDING tab/newline: it serializes as one `review_scope:` line). */
export const REVIEW_SCOPE_MAX = 256;

/** T3: batch send bounds — a batch is 2..16 items (one item is a plain
 * send; more than 16 decisions in one turn is a design smell, not a wire
 * problem). */
export const BATCH_ITEMS_MAX = 16;

/** T4 (THROUGHPUT-SPRINT): pipelined async review. An async review request
 * (`ask` + reviewAsync) keeps the driver working; unanswered past lapseAt it
 * resolves as RECORDED lapsed-consent (broker deadline watcher — never a
 * silent drop). A HIGH/MED review verdict opens a REVIEW GATE the driver
 * must answer (tagged answer) before handoff/end. */
export type ReviewRequest = { readonly from: AgentId; readonly to: AgentId; readonly at: Timestamp; readonly lapseAt: Timestamp };
export type ReviewGate = { readonly severity: 'HIGH' | 'MED'; readonly from: AgentId; readonly at: Timestamp };
export const REVIEW_LAPSE_DEFAULT_SEC = 900;
export const REVIEW_LAPSE_MIN_SEC = 1;
export const REVIEW_LAPSE_MAX_SEC = 86_400;

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

/** Peer 1A: session phases (peer topology only; slices 1-2 occupy
 * planning and provisioning — implementation arrives with slice 4). */
export type SessionPhase = 'planning' | 'provisioning' | 'implementation';
export type Topology = 'pair' | 'peer';

/** Peer 1A bootstrap: substate union — states that cannot coexist are
 * unrepresentable (codex rev-3/4 rulings). convergenceTurn exists ONLY
 * while converging. Later substates (collecting/converging/balloting)
 * gain their fields in 1B/1C; 1A ships admitting. */
export type PlanningState =
  | {
      readonly substate: 'admitting';
      /** init roster + later user/policy authorizations — NOT yet members. */
      readonly authorizedExpected: readonly AgentId[];
      /** attached-and-bound agents; only these enter agents[]. */
      readonly admitted: readonly AgentId[];
      /** Absolute deadline for admission; expiry pages the human (durable). */
      readonly deadlineAt?: Timestamp;
    }
  | {
      readonly substate: 'collecting';
      /** The atomic barrier-open fact. openedMembers is the IMMUTABLE
       * audit snapshot; the EFFECTIVE electorate at reveal is
       * openedMembers minus abstained (1B design rev 2 #1). */
      readonly barrier: BarrierFact;
      /** Submission STATUS only — bodies are protocol-sealed in the journal. */
      readonly submitted: Readonly<Record<AgentId, { readonly contentHash: string; readonly bytes: number; readonly at: Timestamp }>>;
      /** Explicit user rulings ONLY — never a silent shrink. */
      readonly abstained: readonly AgentId[];
      readonly deadlineAt?: Timestamp;
    }
  | ({ readonly substate: 'converging'; readonly rotation: Rotation; readonly ballot?: Ballot } & ConvergenceCommon)
  | ({ readonly substate: 'convergence-blocked'; readonly rotation: BlockedRotation } & ConvergenceCommon)
  | { readonly substate: 'balloting' };

export type BarrierFact = { readonly openedMembers: readonly AgentId[]; readonly registryVersion: number; readonly openedAt: Timestamp };

/** 1B ruling B: the stored round order is the FULL frozen electorate
 * rotated from starterIndex — never live-filtered away. Holder
 * selection/advance skips non-live members at advance time. */
export type Rotation = {
  readonly electorate: readonly AgentId[];
  readonly starterIndex: number;
  readonly round: number;
  readonly remaining: readonly AgentId[];
  readonly holder: AgentId;
};
export type BlockedRotation = Omit<Rotation, 'holder'>;

/** 1B-c: metadata-only finding record (Ruling C — the full texts live in the
 * artifacts store; SessionState carries only per-entry accounting so a
 * later phase can drop this without losing the self-verifying texts). Every
 * transition appends one FindingHistoryEntry; a no-text amend still records
 * an entry (bytes 0). Text-bearing entries (bytes > 0) pair one-to-one with
 * the artifacts findingTexts entries. */
export type FindingHistoryEntry = {
  readonly actor: AgentId;
  readonly at: Timestamp;
  readonly kind: 'filed' | 'responded' | 'confirmed' | 'amended';
  readonly disposition?: string;
  readonly bytes: number;
  readonly textHash: string;
};
export type Finding = {
  readonly id: string;
  readonly author: AgentId;
  readonly addressedTo: AgentId;
  readonly anchor: { readonly kind: 'draft'; readonly revision: number } | { readonly kind: 'proposal'; readonly author: AgentId };
  readonly severity: 'HIGH' | 'MED' | 'LOW';
  readonly agreement: 'agreed' | 'partial' | 'disputed';
  readonly lifecycle: 'open' | 'answered' | 'resolved' | 'conceded' | 'withdrawn';
  readonly history: readonly FindingHistoryEntry[];
};

/** 1C (§1d): the machine-readable normative task block — the SECOND coupled
 * part of the draft (the first is the prose design). The broker extracts it
 * from the draft body's first ```json fence at call-question time and pure
 * decide validates it (validatePlanTaskBlock). A production task may not set
 * `merges` (only 'assist' tasks may); deps reference existing task ids with
 * no self-reference and no cycles. */
export type PlanTask = {
  readonly id: string;
  readonly title: string;
  readonly class: 'production' | 'assist';
  readonly merges?: boolean;
  readonly description: string;
  readonly acceptance: readonly string[];
  readonly deps: readonly string[];
  readonly affinity?: readonly string[];
  readonly size?: 'S' | 'M' | 'L';
};
export type PlanTaskBlock = {
  readonly plan: {
    readonly wip_cap: number;
    readonly verification: {
      readonly fast_gate: string;
      readonly full_suite?: string;
      readonly cadence?: string;
    };
  };
  readonly tasks: readonly PlanTask[];
};

/** 1C (§1c): the open vote. Votes bind to the draft revision HASH frozen at
 * call time; the electorate is the rotation electorate snapshotted at the
 * call (post-call joins/leaves never alter it — fixed-electorate ruling).
 * A reject closes the ballot immediately (unanimity impossible); a draft
 * amendment voids it. Lives ONLY on the converging arm — entering blocked
 * voids any open ballot. */
export type Ballot = {
  readonly revisionHash: string;
  readonly revision: number;
  readonly electorate: readonly AgentId[];
  readonly votes: Readonly<Record<AgentId, { readonly vote: 'approve' } | { readonly vote: 'reject'; readonly reasons: string }>>;
  readonly calledBy: AgentId;
  readonly at: Timestamp;
  readonly taskBlock: PlanTaskBlock;
};

/** 1C: a rejected ballot's reasons become the MANDATORY agenda of the next
 * round — call-question is refused ('agenda-unaddressed') until every item
 * is addressed (address-agenda). Deterministic, auditable. Lives on
 * ConvergenceCommon so it survives a halt/resume (blocked -> converging). */
export type AgendaItem = {
  readonly id: string;
  readonly reason: string;
  readonly from: AgentId;
  readonly at: Timestamp;
  readonly addressed: boolean;
};

/** 1C: the frozen plan retained on the peer session after a passing ballot
 * (the paired phase-transition drops the planning substate; this persists as
 * a top-level PeerSession field). */
export type FrozenPlan = { readonly revision: number; readonly hash: string; readonly taskBlock: PlanTaskBlock; readonly at: Timestamp };

export type ConvergenceCommon = {
  readonly barrier: BarrierFact;
  readonly draft: { readonly revision: number; readonly hash: string; readonly author: AgentId | null; readonly at: Timestamp };
  readonly revisionLog: readonly { readonly revision: number; readonly hash: string; readonly author: AgentId | null; readonly at: Timestamp }[];
  readonly findings: Readonly<Record<string, Finding>>;
  /** 1C: the next-round mandatory agenda (empty until a ballot closes
   * rejected). Carried through convergence-halted/resumed. */
  readonly agenda: readonly AgendaItem[];
};

type SessionBase = {
  readonly task: string;
  readonly agents: readonly AgentId[];
  readonly status: SessionStatus;
  readonly started: Timestamp;
  readonly grants: Readonly<Record<GrantId, Grant>>;
  /** M1: session identity — an init INVARIANT from M1 on (every ingress
   * mints or supplies one); absent only on legacy pre-M1 state. EVERY
   * message-sent of a new session carries it (`session_id:` header). */
  readonly sessionId?: string;
  /** M1: full lifecycle registry. `agents` above remains the LIVE-member
   * projection (evolve keeps both consistent) — existing validation and
   * turn logic read the projection unchanged. */
  readonly registry: Registry;
  /** U1: sha256 of the bound user-channel token. Journal-authoritative via
   * the user-channel-registered event — a hash is safe in agent-readable
   * mirrors (auth needs the preimage); slice 3 has no reset path. */
  readonly userChannelTokenHash?: string;
  /** T4: open async review requests (keyed by the ask's message id).
   * Absent on pre-T4 state. */
  readonly reviewRequests?: Readonly<Record<MessageId, ReviewRequest>>;
  /** T4: unresolved HIGH/MED review verdicts (keyed by the review's message
   * id) — decide refuses handoff/end while any exist. */
  readonly reviewGates?: Readonly<Record<MessageId, ReviewGate>>;
};

/** The classic driver/navigator session — byte-identical to pre-peer. */
export type PairSession = SessionBase & {
  readonly topology: 'pair';
  readonly driver: AgentId;
  readonly turn: AgentId;
  readonly initiator?: never;
  readonly phase?: never;
  readonly planning?: never;
};

/** Peer 1A: no driver, no standing turn — authority is phase + substate.
 * driver/turn are `never` so impossible states are unrepresentable while
 * pair-path reads (`state.turn`) stay type-checkable via narrowing. */
export type PeerSession = SessionBase & {
  readonly topology: 'peer';
  readonly initiator: AgentId;
  readonly phase: SessionPhase;
  /** Round 2 #3: DURABLE authorization — survives substates and barrier
   * transitions. The admitting `authorizedExpected` is the CURRENT
   * barrier's completion set; this is who may ever attach. An abstained
   * invitee stays here (authorized pending observer). */
  readonly authorized: readonly AgentId[];
  readonly planning?: PlanningState;
  /** 1C: the plan frozen by a passing ballot — set by evolve on ballot-passed
   * and retained after the paired phase-transition drops `planning`. Absent
   * until a ballot passes (or forever if the phase is forced). */
  readonly plan?: FrozenPlan;
  /** Durable human-attention queue (peer 1A; codex guardrail: never
   * depend on a live watch connection for visibility). */
  readonly attention: readonly AttentionItem[];
  readonly driver?: never;
  readonly turn?: never;
};

export type SessionState = PairSession | PeerSession;

/** U1: the reserved user identity — outside the roster, never a
 * participant, turn holder, grant assignee, or message recipient (v1). */
export const USER_IDENTITY = 'user';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T, E = never>(value: T): Result<T, E> => ({ ok: true, value });
export const err = <E, T = never>(error: E): Result<T, E> => ({ ok: false, error });
