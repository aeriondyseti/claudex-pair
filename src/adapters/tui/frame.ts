import type { WatchTuiState } from './events.ts';
import { renderWatchFrame } from './watch.ts';

export type WatchFrameDiff = {
  /** Present only when the terminal should be written. */
  readonly frame?: string;
  /** Feed back into the next call. */
  readonly current: string;
};

/** Pure final coalescer: semantic render effects may still produce the same frame. */
export function diffWatchFrame(state: WatchTuiState, previous = ''): WatchFrameDiff {
  if (!state.model) return { current: previous };
  const current = renderWatchFrame({ model: state.model, width: state.width, tail: state.tail });
  return current === previous ? { current } : { frame: current, current };
}
