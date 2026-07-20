import { randomUUID } from 'node:crypto';
import { systemClock } from '@adapters/clock/index.ts';
import { diffWatchFrame } from '@adapters/tui/frame.ts';
import { initialWatchState, type WatchEffect, type WatchReducer, type WatchTuiState } from '@adapters/tui/events.ts';
import type { AgentPresence, TranscriptEntry, WatchViewModel } from '@adapters/tui/viewmodel.ts';
import type { ObserverSession, UserObserverSession } from '@app/ports/gateway.ts';
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

export type WatchLoopOptions = {
  tail: number;
  refreshSec: number;
  /** U1: present only when the host is interactive AND the credential
   * loaded — non-TTY hosts never carry a token (frozen exclusion). */
  userToken?: string;
  /** U1: local pre-attach credential failure — rendered as loud guidance;
   * the loop still attaches read-only. */
  credentialError?: string;
};

/** Journal holds no session — the fs mirrors are the only view left. */
export class NoBrokerSessionError extends Error {}

/** Injection seams for deterministic loop tests (real defaults in prod). */
export type ObserverGatewayLike = {
  observe(spawn?: boolean): Promise<ObserverSession>;
  userAttach?(userToken: string, spawn?: boolean): Promise<UserObserverSession>;
  close(): Promise<void>;
};
export type WatchLoopHooks = {
  gateway?: ObserverGatewayLike;
  terminal?: (handlers: Parameters<typeof openTerminal>[0]) => ReturnType<typeof openTerminal>;
  reattachDelayMs?: number;
  /** fs-diagnostic mode: injected deps for deterministic poller tests. */
  fsDeps?: ReturnType<typeof bindFsDeps>;
  /** Frame/banner writer (default stdout) — tests inject a sink. */
  write?: (chunk: string) => void;
};

const REATTACH_DELAY_MS = 1_000;
const AGE_TICK_MS = 1_000;

/** diffWatchFrame is the final coalescer; this sink just writes its output. */
function frameSink(write: (chunk: string) => void): (state: WatchTuiState) => void {
  let last = '';
  return (state) => {
    const diff = diffWatchFrame(state, last);
    last = diff.current;
    if (diff.frame !== undefined) write(`\x1b[2J\x1b[H${diff.frame}`);
  };
}

const stdoutWrite = (chunk: string): void => void process.stdout.write(chunk);

type EffectHost = {
  render: (state: WatchTuiState) => void;
  /** Absent in fs mode — a reattach effect there is a reducer-contract
   * violation we tolerate as a no-op rather than crash the pane. */
  reattach?: () => Promise<void>;
  /** U1: perform the wire send for a submit effect (broker mode only). */
  submit?: (effect: Extract<WatchEffect, { kind: 'submit' }>) => void;
  /** U1 slice 4: perform the wire call for a CONFIRMED privileged action. */
  action?: (effect: Extract<WatchEffect, { kind: 'action' }>) => void;
};

async function consumeEvents(queue: WatchEventQueue, reduce: WatchReducer, initial: WatchTuiState, host: EffectHost): Promise<number> {
  let state = initial;
  for await (const event of queue) {
    const step = reduce(state, event);
    state = step.state;
    for (const effect of step.effects) {
      if (effect === 'render') host.render(state);
      else if (effect === 'exit') return 0;
      else if (effect === 'reattach') { if (host.reattach) await host.reattach(); }
      else if (effect.kind === 'submit') host.submit?.(effect);
      else host.action?.(effect);
    }
  }
  return 0;
}

export async function runBrokerEventLoop(root: string, options: WatchLoopOptions, reduce: WatchReducer, hooks: WatchLoopHooks = {}): Promise<number> {
  const gateway = hooks.gateway ?? BrokerGateway.forRoot(root);
  const reattachDelayMs = hooks.reattachDelayMs ?? REATTACH_DELAY_MS;
  const queue = new WatchEventQueue();
  const write = hooks.write ?? stdoutWrite;
  const banner = new Screen(write);
  const openTerm = hooks.terminal ?? openTerminal;
  const term = openTerm({
    onQuit: () => queue.push({ kind: 'key', key: 'quit' }),
    onResize: (width) => queue.push({ kind: 'resize', width }),
    // U1 composer input: the host allocates the submit reqId HERE (the
    // pure reducer cannot mint ids; retry reuses pending.reqId instead).
    onText: (text) => queue.push({ kind: 'text', text }),
    onKey: (key) => queue.push(key === 'submit' ? { kind: 'key', key, reqId: randomUUID() } : { kind: 'key', key }),
  });
  const state = initialWatchState({ width: term.width(), tail: options.tail, now: systemClock.now() });
  let session: ObserverSession | UserObserverSession | undefined;
  let spawnAllowed = true; // flips only after the first SUCCESSFUL attach
  let everAttached = false; // no model yet → banner feedback during retries
  let pumpGeneration = 0;
  let attaching = false; // single-flight
  let recovering = false; // submit-recovery owns attachment while true
  let closed = false;

  const ticker = setInterval(() => queue.push({ kind: 'tick', now: systemClock.now() }), AGE_TICK_MS);

  /**
   * Background, single-flight, cancellable attach (codex live review): the
   * queue consumer NEVER awaits this — quit/resize/tick stay responsive
   * while the broker is absent. Failed attempts post 'reattaching' events;
   * success posts the attach event and starts the pump.
   */
  /** Session adoption shared by the attach loop and submit recovery: emits
   * the attach + channel events and arms the push pump for THIS session. */
  const adoptSession = (next: ObserverSession | UserObserverSession, degraded: boolean): void => {
    session = next;
    spawnAllowed = false; // success — background reattaches are connect-only
    everAttached = true;
    queue.push(attachEvent(next.snapshot, next.snapshot.broker.endpoint, systemClock.now()));
    if (degraded || options.credentialError) {
      // A credential-error event is already queued (auth-degrade, or the
      // local bootstrap error pushed before the first attach) and the
      // reducer applies it as deferred state at attach — pushing
      // registered/unregistered here would overwrite that loud guidance
      // (close-out #2).
    } else if (options.userToken && next.snapshot.userChannel) {
      queue.push({ kind: 'user-channel', state: next.snapshot.userChannel.registered ? 'registered' : 'unregistered' });
    } else {
      // No token on this host (non-TTY exclusion, or no credential): the
      // channel is unavailable HERE regardless of any broker-side binding —
      // a composer affordance on a host that cannot input or send would be
      // a lie (close-out #7 proof surface).
      queue.push({ kind: 'user-channel', state: 'unavailable' });
    }
    // Pump generation guards a torn-down session's late callbacks: only the
    // CURRENT pump may signal connection loss.
    const generation = ++pumpGeneration;
    const pushes = next.pushes;
    void (async () => {
      try {
        for await (const push of pushes) queue.push(decodePush(push));
      } catch {
        if (generation === pumpGeneration && !closed) queue.push({ kind: 'connection', state: 'lost' });
      }
    })();
  };

  /** Authenticated attach with loud degrade on foreign binding. */
  const attachOnce = async (spawn: boolean): Promise<{ next: ObserverSession | UserObserverSession; degraded: boolean }> => {
    if (options.userToken && gateway.userAttach) {
      try {
        return { next: await gateway.userAttach(options.userToken, spawn), degraded: false };
      } catch (error) {
        if (error instanceof BrokerWireError && error.code === 'user-auth-failed') {
          queue.push({ kind: 'user-channel', state: 'credential-error', detail: `${error.message} This pane is read-only.` });
          return { next: await gateway.observe(spawn), degraded: true };
        }
        throw error;
      }
    }
    return { next: await gateway.observe(spawn), degraded: false };
  };

  let attachTask: Promise<void> | undefined; // recovery awaits settlement before touching the gateway
  const startAttach = (): void => {
    if (attaching || closed) return;
    attaching = true;
    attachTask = (async () => {
      try {
        for (;;) {
          if (closed || recovering || session) return; // recovery/success owns attachment
          try {
            const { next, degraded } = await attachOnce(spawnAllowed);
            if (closed || recovering || session) {
              await next.close(); // a competing path won while we handshook
              return;
            }
            adoptSession(next, degraded);
            return;
          } catch (error) {
            if (closed) return;
            if (error instanceof BrokerWireError && error.code === 'session-not-active') {
              queue.fail(new NoBrokerSessionError(error.message)); // → fs fallback in runWatch
              return;
            }
            if (!recovering) await gateway.close(); // never yank recovery's fresh client
            queue.push({ kind: 'connection', state: 'reattaching' });
            if (!everAttached) banner.draw(`pair watch: broker unreachable (${message(error)}) — retrying every ${reattachDelayMs / 1000}s. Ctrl+C to quit.`);
            await systemClock.sleep(reattachDelayMs);
          }
        }
      } finally {
        attaching = false;
        attachTask = undefined;
      }
    })();
  };

  try {
    // Local pre-attach credential failure: loud guidance before anything
    // else renders (frozen contract — never observable broker-side).
    if (options.credentialError) queue.push({ kind: 'user-channel', state: 'credential-error', detail: options.credentialError });
    startAttach();
    /**
     * Submit with the design §5 idle-contract recovery: observers never pin
     * or spawn the broker, so an idle-exit predictably strands the channel —
     * but a user SUBMIT is active user work and MAY respawn (the one
     * exception). On a dead/unattached session: authenticated reattach with
     * spawn allowed, then retry the IMMUTABLE {reqId,target,body} exactly
     * once — reqId reuse keeps it dedup-safe if the first attempt actually
     * committed (codex re-read blocker 20260720-105928-798).
     */
    const opViaSession = async (op: (s: UserObserverSession) => Promise<void>): Promise<void> => {
      const current = session;
      if (!current || !('send' in current)) throw new Error('user channel not attached');
      await op(current);
    };
    /**
     * Shared recovery for sends AND privileged actions (both are active
     * user work — the one spawn-allowed observer path, design §5): on a
     * dead/unattached session, await any in-flight background attach, ride
     * a FRESH session if one won, else authenticated reattach with spawn
     * allowed, then retry the immutable op exactly once (reqId dedup-safe).
     */
    const withUserRecovery = async (reqId: string, op: (s: UserObserverSession) => Promise<void>): Promise<void> => {
      try {
        await opViaSession(op);
        queue.push({ kind: 'submit-result', reqId, ok: true });
        return;
      } catch (first) {
        if (!options.userToken || !gateway.userAttach || closed || recovering) {
          queue.push({ kind: 'submit-result', reqId, ok: false, error: message(first) });
          return;
        }
        const failedSession = session; // the session the op just failed on
        recovering = true; // background loop yields; its catch won't close our client
        try {
          // Never race the in-flight background attach on the SHARED gateway
          // (`getClient` ??=-assigns one client): await its settlement — the
          // loop exits promptly once `recovering` is up (codex combined
          // audit). If it adopted a FRESH session meanwhile, ride it; the
          // one the op failed on is never retried in place.
          await attachTask?.catch(() => undefined);
          if (session && session !== failedSession) {
            await opViaSession(op);
            queue.push({ kind: 'submit-result', reqId, ok: true });
            return;
          }
          pumpGeneration++; // silence the dying session's pump
          await session?.close();
          session = undefined;
          await gateway.close();
          const next = await gateway.userAttach(options.userToken, true); // spawn: active user work
          if (closed) { await next.close(); return; }
          adoptSession(next, false);
          await opViaSession(op); // the single retry, payload immutable
          queue.push({ kind: 'submit-result', reqId, ok: true });
        } catch (second) {
          queue.push({ kind: 'submit-result', reqId, ok: false, error: message(second) });
        } finally {
          recovering = false;
          if (!session && !closed) startAttach(); // recovery failed — resume the background loop
        }
      }
    };
    return await consumeEvents(queue, reduce, state, {
      render: frameSink(write),
      submit: (effect) => void withUserRecovery(effect.reqId, (s) => s.send(effect.reqId, effect.target, effect.body)),
      action: (effect) => void withUserRecovery(effect.reqId, (s) => s.action(effect.reqId, effect.action)),
      reattach: async () => {
        if (recovering) return; // recovery owns attachment; it re-arms on failure
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
    return await consumeEvents(queue, reduce, state, { render: frameSink(hooks.write ?? stdoutWrite) });
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
