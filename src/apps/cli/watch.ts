import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { reduceWatch } from '@adapters/tui/reducer.ts';
import { NoBrokerSessionError, runBrokerEventLoop, runFsEventLoop, type WatchLoopOptions } from './watchLoop.ts';

/**
 * `pair watch` routing (TUI-UPGRADE-NOTES slices 1+2).
 *
 * Broker mode (default when `.pair/journal` exists): non-consuming observer
 * — authoritative snapshot plus live pushes, reattach-on-gap, exit on
 * completed sessions. FS-diagnostic mode (legacy sessions or
 * CLAUDEX_PROTOCOL_MODE=fs, or a journal with no session): mirror polling,
 * labeled honestly — mirrors may lag, no listener-liveness signal.
 * Both feed the same pure reducer through the same event loop.
 */

export type WatchOptions = WatchLoopOptions;

export async function runWatch(root: string, options: WatchOptions): Promise<number> {
  const fsMode = process.env['CLAUDEX_PROTOCOL_MODE'] === 'fs' || !existsSync(join(root, '.pair', 'journal'));
  if (!fsMode) {
    try {
      return await runBrokerEventLoop(root, options, reduceWatch);
    } catch (error) {
      if (!(error instanceof NoBrokerSessionError)) throw error;
      // Journal dir exists but holds no session — fall through, labeled.
    }
  }
  return runFsEventLoop(root, options, reduceWatch);
}
