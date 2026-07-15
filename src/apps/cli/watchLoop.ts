import { systemClock } from '@adapters/clock/index.ts';
import { diffWatchFrame } from '@adapters/tui/frame.ts';
import { initialWatchState, type WatchReducer, type WatchTuiState } from '@adapters/tui/events.ts';
import type { AgentPresence, TranscriptEntry, WatchViewModel } from '@adapters/tui/viewmodel.ts';
import type { ObserverSession } from '@app/ports/gateway.ts';
import type { SessionState } from '@core/types.ts';
import * as uc from '@app/usecases.ts';
import { bindFsDeps } from './bind.ts';
import { BrokerGateway, BrokerWireError } from './brokerGateway.ts';
import { openTerminal, Screen } from './term.ts';
import { attachEvent, decodePush, WatchEventQueue } from './watchPump.ts';

/**
 * Slice-2 watch hosts: one ordered event stream (transport or fs poller,
 * ticker, terminal keys/resize) consumed by the injected pure reducer;
 * these hosts execute its ordered effects and own every real-world
 * resource (gateway connection, raw terminal, timers). The reducer owns
 * meaning: stream continuity, completed-exit, banners, render eligibility.
 *
 * Reattach policy unchanged from slice 1: spawn-on-demand only on the
 * FIRST attach; a reattach never resurrects a deliberately stopped broker.
 */

export type WatchLoopOptions = { tail: number; refreshSec: number };

/** Journal holds no session — the fs mirrors are the only view left. */
export class NoBrokerSessionError extends Error {}

/** Injection seams for deterministic loop tests (real defaults in prod). */
export type ObserverGatewayLike = {
  observe(spawn?: boolean): Promise<ObserverSession>;
  close(): Promise<void>;
};
export type WatchLoopHooks = {
  gateway?: ObserverGatewayLike;
  terminal?: (handlers: Parameters<typeof openTerminal>[0]) => ReturnType<typeof openTerminal>;
  reattachDelayMs?: number;
  /** fs-diagnostic mode: injected deps for deterministic poller tests. */
  fsDeps?: ReturnType<typeof bindFsDeps>;
};

const REATTACH_DELAY_MS = 1_000;
const AGE_TICK_MS = 1_000;

/** diffWatchFrame is the final coalescer; this sink just writes its output. */
function frameSink(): (state: WatchTuiState) => void {
  let last = '';
  return (state) => {
    const diff = diffWatchFrame(state, last);
    last = diff.current;
    if (diff.frame !== undefined) process.stdout.write(`\x1b[2J\x1b[H${diff.frame}`);
  };
}

type EffectHost = {
  render: (state: WatchTuiState) => void;
  /** Absent in fs mode — a reattach effect there is a reducer-contract
   * violation we tolerate as a no-op rather than crash the pane. */
  reattach?: () => Promise<void>;
};

async function consumeEvents(queue: WatchEventQueue, reduce: WatchReducer, initial: WatchTuiState, host: EffectHost): Promise<number> {
  let state = initial;
  for await (const event of queue) {
    const step = reduce(state, event);
    state = step.state;
    for (const effect of step.effects) {
      if (effect === 'render') host.render(state);
      else if (effect === 'exit') return 0;
      else if (host.reattach) await host.reattach();
    }
  }
  return 0;
}

export async function runBrokerEventLoop(root: string, options: WatchLoopOptions, reduce: WatchReducer, hooks: WatchLoopHooks = {}): Promise<number> {
  const gateway = hooks.gateway ?? BrokerGateway.forRoot(root);
  const reattachDelayMs = hooks.reattachDelayMs ?? REATTACH_DELAY_MS;
  const queue = new WatchEventQueue();
  const banner = new Screen();
  const openTerm = hooks.terminal ?? openTerminal;
  const term = openTerm({
    onQuit: () => queue.push({ kind: 'key', key: 'quit' }),
    onResize: (width) => queue.push({ kind: 'resize', width }),
  });
  const state = initialWatchState({ width: term.width(), tail: options.tail, now: systemClock.now() });
  let session: ObserverSession | undefined;
  let spawnAllowed = true; // flips only after the first SUCCESSFUL attach
  let everAttached = false; // no model yet → banner feedback during retries
  let pumpGeneration = 0;
  let attaching = false; // single-flight
  let closed = false;

  const ticker = setInterval(() => queue.push({ kind: 'tick', now: systemClock.now() }), AGE_TICK_MS);

  /**
   * Background, single-flight, cancellable attach (codex live review): the
   * queue consumer NEVER awaits this — quit/resize/tick stay responsive
   * while the broker is absent. Failed attempts post 'reattaching' events;
   * success posts the attach event and starts the pump.
   */
  const startAttach = (): void => {
    if (attaching || closed) return;
    attaching = true;
    void (async () => {
      try {
        for (;;) {
          if (closed) return;
          try {
            const next = await gateway.observe(spawnAllowed);
            if (closed) {
              await next.close();
              return;
            }
            session = next;
            spawnAllowed = false; // success — reattaches are connect-only
            everAttached = true;
            break;
          } catch (error) {
            if (closed) return;
            if (error instanceof BrokerWireError && error.code === 'session-not-active') {
              queue.fail(new NoBrokerSessionError(error.message)); // → fs fallback in runWatch
              return;
            }
            await gateway.close();
            queue.push({ kind: 'connection', state: 'reattaching' });
            if (!everAttached) banner.draw(`pair watch: broker unreachable (${message(error)}) — retrying every ${reattachDelayMs / 1000}s. q to quit.`);
            await systemClock.sleep(reattachDelayMs);
          }
        }
        queue.push(attachEvent(session!.snapshot, session!.snapshot.broker.endpoint, systemClock.now()));
        // Pump generation guards a torn-down session's late callbacks: only
        // the CURRENT pump may signal connection loss.
        const generation = pumpGeneration;
        const pushes = session!.pushes;
        void (async () => {
          try {
            for await (const push of pushes) queue.push(decodePush(push));
          } catch {
            if (generation === pumpGeneration && !closed) queue.push({ kind: 'connection', state: 'lost' });
          }
        })();
      } finally {
        attaching = false;
      }
    })();
  };

  try {
    startAttach();
    return await consumeEvents(queue, reduce, state, {
      render: frameSink(),
      reattach: async () => {
        // Invalidate BEFORE the intentional close: the dying pump's error
        // callback must never enqueue a stale 'lost' that would tear down
        // the session we are about to attach (codex live review).
        pumpGeneration++;
        await session?.close();
        session = undefined;
        await gateway.close();
        startAttach();
      },
    });
  } finally {
    closed = true;
    pumpGeneration++;
    clearInterval(ticker);
    term.close();
    queue.close();
    await session?.close();
    await gateway.close();
  }
}

export async function runFsEventLoop(root: string, options: WatchLoopOptions, reduce: WatchReducer, hooks: WatchLoopHooks = {}): Promise<number> {
  const deps = hooks.fsDeps ?? bindFsDeps(root);
  const queue = new WatchEventQueue();
  const openTerm = hooks.terminal ?? openTerminal;
  const term = openTerm({
    onQuit: () => queue.push({ kind: 'key', key: 'quit' }),
    onResize: (width) => queue.push({ kind: 'resize', width }),
  });
  const state = initialWatchState({ width: term.width(), tail: options.tail, now: deps.clock.now() });

  // Recursive-timeout poller (codex close-out review): the next poll is
  // scheduled only after the current one settles — max concurrency 1 by
  // construction, so a slow older read can never overwrite a newer model.
  // A failed read retains the last model and retries next cycle.
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const pollLoop = async (): Promise<void> => {
    try {
      const model = await buildFsViewModel(deps);
      if (model) queue.push({ kind: 'replace-model', model });
    } catch {
      /* transient mirror read failure — keep last model, retry next cycle */
    } finally {
      if (!stopped) pollTimer = setTimeout(() => void pollLoop(), options.refreshSec * 1000);
    }
  };
  void pollLoop();
  const ticker = setInterval(() => queue.push({ kind: 'tick', now: deps.clock.now() }), AGE_TICK_MS);
  try {
    return await consumeEvents(queue, reduce, state, { render: frameSink() });
  } finally {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    clearInterval(ticker);
    term.close();
    queue.close();
  }
}

async function buildFsViewModel(deps: ReturnType<typeof bindFsDeps>): Promise<WatchViewModel | undefined> {
  const session = await deps.store.load();
  if (!session) return undefined;
  const entries: TranscriptEntry[] = [];
  for (const m of await deps.mailbox.archived()) entries.push({ message: m, pending: false });
  for (const agent of session.agents) {
    for (const m of await deps.mailbox.pending(agent)) entries.push({ message: m, pending: true });
  }
  entries.sort((a, b) => a.message.name.localeCompare(b.message.name));
  const view = uc.view(session);
  return {
    source: { kind: 'fs-diagnostic', reason: 'legacy-session' },
    session,
    navigators: view.navigators,
    openGrants: view.openGrants,
    transcript: entries,
    presence: fsPresence(session, entries),
    now: deps.clock.now(),
    notices: [],
  };
}

/** fs mode has no listener signal: honest 'unknown', pending from mirrors. */
function fsPresence(session: SessionState, entries: readonly TranscriptEntry[]): AgentPresence[] {
  return session.agents.map((agent) => {
    const pending = entries.filter((e) => e.pending && !e.voided && e.message.header.to === agent);
    return {
      agent,
      listener: { state: 'unknown' },
      pendingCount: pending.length,
      ...(pending.length
        ? { oldestPendingSent: pending.reduce((min, e) => (e.message.header.sent < min ? e.message.header.sent : min), pending[0]!.message.header.sent) }
        : {}),
    };
  });
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
