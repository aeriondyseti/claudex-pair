import type { LivenessDto, ObserverSnapshotDto } from '@app/ports/gateway.ts';
import type { StoredMessage } from '@app/ports/index.ts';
import type { AgentId, SessionState } from '@core/types.ts';
import type { TranscriptEntry, WatchViewModel } from './viewmodel.ts';

/**
 * Frozen event/action seam for the slice-2 watch event loop (agreed
 * claude+codex 2026-07-14, amendments 1-5 of the slice-1 approval message).
 *
 * The HOST (src/apps/cli) owns terminal IO, resize/key decoding, Ctrl+C and
 * cleanup, and the transport pump; it decodes wire pushes into the shapes
 * here (the message codec lives outside this layer). The REDUCER
 * (src/adapters/tui) is pure: reduce(state, event) → {state, effects} — it
 * owns stream continuity (duplicate/gap), completed-session exit, connection
 * banners, and semantic render eligibility. Contract changes only by
 * agreement between the lanes.
 */

/** Broker activity, pre-decoded by the host: message-sent events arrive
 * already rendered to stored form, keyed by deliveryId. */
export type WatchActivity = {
  readonly seq: number;
  readonly session: SessionState;
  readonly entries: readonly { readonly deliveryId: string; readonly message: StoredMessage }[];
  readonly ackedDeliveryIds: readonly string[];
  /** Item 7: broker-authoritative awaiting-set (absent from a pre-item-7
   * broker — the reducer keeps its previous view). */
  readonly awaiting?: readonly import('@core/awaiting.ts').AwaitingEntry[];
  readonly voidedDeliveryIds: readonly string[];
};

export type WatchEvent =
  /** Broker attach or reattach: full state rebuild from an authoritative
   * snapshot. Covers reconnect — nothing before it survives. */
  | { kind: 'attach'; snapshot: ObserverSnapshotDto; endpoint: string; now: string }
  /** fs-diagnostic poll result: a prebuilt model replaces the view wholesale
   * (amendment 2 — the loop is source-neutral). */
  | { kind: 'replace-model'; model: WatchViewModel }
  | { kind: 'activity'; activity: WatchActivity }
  | { kind: 'presence'; liveness: LivenessDto }
  | { kind: 'resize'; width: number }
  | { kind: 'tick'; now: string }
  /** Connection semantics (amendment 5): the reducer maps these to explicit
   * notices AND model.source.connected — never implied by silence. */
  | { kind: 'connection'; state: 'lost' | 'reattaching' }
  /** U1 slice 3 (U1-SLICE3-DESIGN.md, approved): printable input is ALWAYS
   * text (the input line is always focused — `q` types `q`); commands are
   * non-printable chords only, decoded by the host. */
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: 'quit' | 'escape' | 'backspace' | 'tab' | 'page-up' | 'page-down' | 'end' | 'filter' }
  /** The host allocates reqId when decoding Enter; the pure reducer cannot
   * mint IDs. On retry, the reducer intentionally reuses pending.reqId and
   * ignores this fresh candidate. */
  | { kind: 'key'; key: 'submit'; reqId: string }
  /** Host result of a submit effect's wire call; reqId === groupId. */
  | { kind: 'submit-result'; reqId: string; ok: boolean; error?: string }
  /** User-channel bootstrap/handshake state. `credential-error` is LOCAL
   * pre-attach state (broker cannot see client DPAPI failures) — rendered
   * as loud guidance, never silent regeneration. */
  | { kind: 'user-channel'; state: 'unavailable' | 'unregistered' | 'registered' | 'credential-error'; detail?: string };

/**
 * Effects execute in ARRAY ORDER (amendment 3): a completed-session
 * activity yields ['render','exit'] — final frame first; a stream gap
 * yields ['render','reattach']. `submit` carries the IMMUTABLE payload the
 * host must send (reqId reused verbatim across reconnect retries;
 * groupId === reqId by frozen contract).
 */
export type WatchEffect =
  | 'render'
  | 'exit'
  | 'reattach'
  | { readonly kind: 'submit'; readonly reqId: string; readonly target: AgentId | '*'; readonly body: string }
  /** U1 slice 4 (SEAM ADDITION, flagged for lane ratification): a CONFIRMED
   * privileged action. Emitted only by the second Enter on a confirming
   * draft; reqId minted then (freeze-then-mint), reused verbatim on retry. */
  | { readonly kind: 'action'; readonly reqId: string; readonly action: UserActionDraft; readonly display: string };

/** Frozen normalized action (first Enter pins it; buffer edits after the
 * freeze cannot mutate what executes — design REV 6). 4b verbs parse but
 * the broker rejects them bad-command until 4b lands. */
export type UserActionDraft =
  | { readonly verb: 'end'; readonly summary: string }
  | { readonly verb: 'cancel-grant'; readonly grantId: string; readonly reason: string }
  | { readonly verb: 'kick'; readonly agent: string; readonly reason: string }
  | { readonly verb: 'pause'; readonly reason: string }
  | { readonly verb: 'resume' };

/**
 * Reducer-owned state (amendment 1). `model` is the renderable view;
 * entries/liveness/headSeq are the broker projections it is rebuilt from.
 * The reducer emits 'render' on semantic eligibility only; the host's
 * frame-equality gate stays the final coalescer (amendment 4).
 */
export type WatchTuiState = {
  /** Renderable view; undefined until the first attach/replace-model. */
  readonly model: WatchViewModel | undefined;
  readonly width: number;
  readonly tail: number;
  readonly now: string;
  readonly connection: 'connected' | 'lost' | 'reattaching';
  /** Broker stream continuity cursor (strict seq === head+1; 0 in fs mode). */
  readonly headSeq: number;
  /** deliveryId → entry, commit-ordered (broker mode; empty in fs mode). */
  readonly entries: ReadonlyMap<string, TranscriptEntry>;
  readonly liveness: LivenessDto | undefined;
  /** U1 slice 3 — composer state (reducer-owned; undefined until the user
   * channel is available on this host: broker mode + TTY only). */
  readonly composer: ComposerState | undefined;
  /** U1 slice-3 close-out #2 (SEAM ADDITION, flagged for lane ratification):
   * a user-channel event arriving BEFORE the first broker attach is deferred
   * here — never dropped, never applied to a non-broker projection — and the
   * next attach applies the latest deferred state. `unavailable` clears it. */
  readonly pendingChannel: { readonly channel: 'unregistered' | 'registered' | 'credential-error'; readonly detail?: string } | undefined;
};

/** Composer/interaction state per U1-SLICE3-DESIGN.md (approved). */
export type ComposerState = {
  readonly channel: 'unregistered' | 'registered' | 'credential-error';
  readonly channelDetail?: string;
  readonly buffer: string;
  /** '*' = broadcast, else an AgentId; Tab cycles. */
  readonly target: AgentId | '*';
  /** Scrollback offset in entries from the tail; 0 = following. */
  readonly scrollOffset: number;
  readonly filter: 'all' | 'dialogue' | 'user' | 'protocol';
  /** In-flight submit (no optimistic transcript insertion): cleared when
   * the committed activity with groupId === reqId arrives. `action: true`
   * marks a privileged action pending (slice 4) — same clear machinery,
   * distinct rendering. Actions and sends share this single slot. */
  readonly pending?: { readonly reqId: string; readonly target: AgentId | '*'; readonly body: string; readonly state: 'sending' | 'error'; readonly error?: string; readonly action?: true };
  /** Slice 4: the frozen action awaiting its second Enter (CONFIRM state). */
  readonly confirming?: UserActionDraft & { readonly display: string };
  /** Slice 4: transient unknown-/malformed-action hint (cleared on edit). */
  readonly actionHint?: string;
};

export type WatchStep = { readonly state: WatchTuiState; readonly effects: readonly WatchEffect[] };

export type WatchReducer = (state: WatchTuiState, event: WatchEvent) => WatchStep;

export function initialWatchState(options: { width: number; tail: number; now: string }): WatchTuiState {
  return {
    model: undefined,
    width: options.width,
    tail: options.tail,
    now: options.now,
    connection: 'connected',
    headSeq: 0,
    entries: new Map(),
    liveness: undefined,
    composer: undefined,
    pendingChannel: undefined,
  };
}
