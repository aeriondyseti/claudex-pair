import { systemClock } from '@adapters/clock/index.ts';
import { renderWatchFrame } from '@adapters/tui/watch.ts';
import { initialWatchState, type WatchReducer, type WatchTuiState } from '@adapters/tui/events.ts';
import type { ObserverSession } from '@app/ports/gateway.ts';
import { BrokerGateway } from './brokerGateway.ts';
import { openTerminal, Screen } from './term.ts';
import { attachEvent, decodePush, WatchEventQueue } from './watchPump.ts';

/**
 * Slice-2 broker watch host: one ordered event stream (transport pushes,
 * ticker, terminal keys/resize) consumed by a pure injected reducer; this
 * module executes its ordered effects and owns every real-world resource
 * (gateway connection, raw terminal, timers). Wired into `pair watch` when
 * the reducer lane (codex/watch-tui-2) merges; until then runWatch keeps
 * the slice-1 loop.
 *
 * Reattach policy is unchanged from slice 1: spawn-on-demand only on the
 * FIRST attach; a reattach never resurrects a deliberately stopped broker.
 */

export type WatchLoopOptions = { tail: number; refreshSec: number };

const REATTACH_DELAY_MS = 1_000;
const AGE_TICK_MS = 1_000;

export async function runBrokerEventLoop(root: string, options: WatchLoopOptions, reduce: WatchReducer): Promise<number> {
  const gateway = BrokerGateway.forRoot(root);
  const queue = new WatchEventQueue();
  const screen = new Screen();
  const term = openTerminal({
    onQuit: () => queue.push({ kind: 'key', key: 'quit' }),
    onResize: (width) => queue.push({ kind: 'resize', width }),
  });
  let state: WatchTuiState = initialWatchState({ width: term.width(), tail: options.tail, now: systemClock.now() });
  let session: ObserverSession | undefined;
  let firstAttach = true;
  let pumpGeneration = 0;

  const ticker = setInterval(() => queue.push({ kind: 'tick', now: systemClock.now() }), AGE_TICK_MS);

  const attach = async (): Promise<void> => {
    for (;;) {
      try {
        session = await gateway.observe(firstAttach);
        firstAttach = false;
        break;
      } catch (error) {
        firstAttach = false;
        await gateway.close();
        queue.push({ kind: 'connection', state: 'reattaching' });
        if (state.model === undefined) {
          screen.draw(`pair watch: broker unreachable (${message(error)}) — retrying every ${REATTACH_DELAY_MS / 1000}s. q to quit.`);
        }
        await systemClock.sleep(REATTACH_DELAY_MS);
      }
    }
    queue.push(attachEvent(session.snapshot, session.snapshot.broker.endpoint, systemClock.now()));
    // Pump generation guards a torn-down session's late callbacks: only the
    // CURRENT pump may signal connection loss.
    const generation = ++pumpGeneration;
    const pushes = session.pushes;
    void (async () => {
      try {
        for await (const push of pushes) queue.push(decodePush(push));
      } catch {
        if (generation === pumpGeneration) queue.push({ kind: 'connection', state: 'lost' });
      }
    })();
  };

  try {
    await attach();
    for await (const event of queue) {
      const step = reduce(state, event);
      state = step.state;
      for (const effect of step.effects) {
        if (effect === 'render') {
          if (state.model) {
            screen.draw(renderWatchFrame({ model: state.model, width: state.width, tail: state.tail }));
          }
          continue;
        }
        if (effect === 'exit') return 0;
        // 'reattach': tear down the dead session, then rebuild from a fresh
        // snapshot (stream gap or connection loss — never resume mid-hole).
        await session?.close();
        await gateway.close();
        await systemClock.sleep(REATTACH_DELAY_MS);
        await attach();
      }
    }
    return 0;
  } finally {
    clearInterval(ticker);
    term.close();
    queue.close();
    await session?.close();
    await gateway.close();
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
