import type { AgentId, Grant, SessionState } from '@core/types.ts';
import type { StoredMessage } from '@app/ports/index.ts';

/**
 * WatchViewModel — the frozen seam between watch data sources and the pure
 * renderer (TUI-UPGRADE-NOTES "Adapt the pure renderer to a view model
 * shared by broker and fs diagnostic modes").
 *
 * Producers: the broker observer mapping and the fs-diagnostic polling loop
 * (src/apps/cli). Consumer: renderWatchFrame and its derive helpers
 * (src/adapters/tui). The renderer never reads state; everything it shows
 * arrives through this type, with `now` supplied for age derivation so
 * rendering stays deterministic and testable.
 */

/** Where the data came from — rendered honestly (BROKER-SPEC diagnostics rule). */
export type WatchSource =
  | {
      readonly kind: 'broker';
      readonly pid: number;
      readonly epoch: number;
      readonly endpoint: string;
      /** Journal head seq of the rendered view — authoritative. */
      readonly headSeq: number;
      readonly heartbeatAt: string;
      /** False while reconnecting after a broker stop/restart. */
      readonly connected: boolean;
    }
  | {
      /** Mirror-derived view: may lag the journal; never authoritative. */
      readonly kind: 'fs-diagnostic';
      readonly reason: 'legacy-session' | 'broker-unreachable';
    };

export type TranscriptEntry = {
  readonly message: StoredMessage;
  /** Enqueued but not yet acked by the recipient (broker) / still in inbox (fs). */
  readonly pending: boolean;
  /** Closed without consumption — recipient was removed (F18/F21). */
  readonly voided?: boolean;
};

/**
 * ENHANCEMENTS item 8 — the three signals, kept distinct. `listener` is
 * 'unknown' in fs-diagnostic mode (there is no listener signal to report;
 * an honest UI says so instead of implying absence).
 */
export type AgentPresence = {
  readonly agent: AgentId;
  readonly listener:
    | { readonly state: 'live'; readonly connectedSince: string; readonly lastActivity: string }
    | { readonly state: 'none' }
    | { readonly state: 'unknown' };
  readonly pendingCount: number;
  /** Sent-time of the oldest pending message, if any. */
  readonly oldestPendingSent?: string;
};

export type WatchViewModel = {
  readonly source: WatchSource;
  readonly session: SessionState;
  readonly navigators: readonly AgentId[];
  readonly openGrants: readonly Grant[];
  readonly transcript: readonly TranscriptEntry[];
  readonly presence: readonly AgentPresence[];
  /** Render-time clock ('YYYY-MM-DD HH:mm:ss', same format as message sent). */
  readonly now: string;
  /** Producer-supplied banners (e.g. 'broker stopped — reconnecting…'). */
  readonly notices: readonly string[];
};
