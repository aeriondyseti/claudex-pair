import type { LivenessDto, ObserverSnapshotDto } from '@app/ports/gateway.ts';
import type { StoredMessage } from '@app/ports/index.ts';
import type { SessionState } from '@core/types.ts';
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
  | { kind: 'key'; key: 'quit' };

/**
 * Effects execute in ARRAY ORDER (amendment 3): a completed-session
 * activity yields ['render','exit'] — final frame first; a stream gap
 * yields ['render','reattach'].
 */
export type WatchEffect = 'render' | 'exit' | 'reattach';

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
  };
}
