import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionState } from '@core/types.ts';
import type { LivenessDto, ObserverPush, ObserverSnapshotDto } from '@app/ports/gateway.ts';
import * as uc from '@app/usecases.ts';
import { systemClock } from '@adapters/clock/index.ts';
import { renderWatchFrame } from '@adapters/tui/watch.ts';
import type { AgentPresence, TranscriptEntry, WatchViewModel } from '@adapters/tui/viewmodel.ts';
import { bindFsDeps } from './bind.ts';
import { BrokerGateway } from './brokerGateway.ts';
import { toStored } from './watchPump.ts';

/**
 * `pair watch` orchestration (TUI-UPGRADE-NOTES slice 1).
 *
 * Broker mode (default when `.pair/journal` exists): attach a NON-CONSUMING
 * observer — snapshot, then live activity/presence pushes. The rendered view
 * is authoritative (journal head seq shown); reattach after a connection
 * loss serves a fresh snapshot, never a replay. Reattach never spawns a
 * broker: watch must not resurrect a deliberately stopped daemon — agents
 * respawn it on their next command and watch reconnects to the new epoch.
 *
 * FS-diagnostic mode (legacy sessions / CLAUDEX_PROTOCOL_MODE=fs): today's
 * mirror-polling loop, labeled honestly — mirrors may lag and there is no
 * listener-liveness signal to report.
 */

export type WatchOptions = { tail: number; refreshSec: number };

const REATTACH_DELAY_MS = 1_000;
const AGE_TICK_MS = 1_000;

export async function runWatch(root: string, options: WatchOptions): Promise<number> {
  const fsMode = process.env['CLAUDEX_PROTOCOL_MODE'] === 'fs' || !existsSync(join(root, '.pair', 'journal'));
  return fsMode ? runFsWatch(root, options) : runBrokerWatch(root, options);
}

/** Mutable broker-watch state, rebuilt wholesale from every snapshot. */
type BrokerWatchState = {
  session: SessionState;
  headSeq: number;
  liveness: LivenessDto;
  broker: { pid: number; epoch: number; endpoint: string; heartbeatAt: string };
  /** deliveryId (`<messageId>:<recipient>`) → entry, insertion-ordered. */
  entries: Map<string, TranscriptEntry>;
  connected: boolean;
};

async function runBrokerWatch(root: string, options: WatchOptions): Promise<number> {
  const gateway = BrokerGateway.forRoot(root);
  const screen = new Screen();
  let state: BrokerWatchState | undefined;
  let firstAttach = true;
  for (;;) {
    let session: Awaited<ReturnType<BrokerGateway['observe']>>;
    try {
      // Spawn-on-demand only on the FIRST attach (the authoritative view
      // needs a broker); reattach is connect-only per the module contract.
      session = await gateway.observe(firstAttach);
    } catch (error) {
      await gateway.close();
      if (isNoBrokerSession(error)) {
        // Journal dir exists but holds no session (or was cleaned): the
        // fs mirrors are the only view left — fall back, labeled.
        return runFsWatch(root, options);
      }
      if (state) screen.draw(render(brokerVm(state, ['broker unreachable — waiting for it to return (agents respawn it on their next command)']), options));
      else screen.draw(`pair watch: broker unreachable (${message(error)}) — retrying every ${REATTACH_DELAY_MS / 1000}s. Ctrl+C to exit.`);
      await systemClock.sleep(REATTACH_DELAY_MS);
      continue;
    }
    firstAttach = false;
    state = fromSnapshot(session.snapshot);
    const redraw = () => screen.draw(render(brokerVm(state!), options));
    redraw();
    if (state.session.status !== 'active') {
      // A completed session pushes nothing more — exit after the final
      // frame instead of waiting forever on the push loop (codex review);
      // this also releases the daemon to idle out.
      await session.close();
      await gateway.close();
      process.stdout.write('\nSession is no longer active — watch exiting.\n');
      return 0;
    }
    const ticker = setInterval(redraw, AGE_TICK_MS); // ages tick locally
    let gap = false;
    try {
      for await (const push of session.pushes) {
        const outcome = applyPush(state, push);
        if (outcome === 'gap') {
          // Lost frames — never skip over the hole; rebuild from a fresh
          // snapshot (stream contract in applyPush).
          gap = true;
          break;
        }
        if (outcome === 'duplicate') continue;
        redraw();
        if (state.session.status !== 'active') {
          clearInterval(ticker);
          await session.close();
          await gateway.close();
          process.stdout.write('\nSession is no longer active — watch exiting.\n');
          return 0;
        }
      }
    } catch {
      /* connection lost — reattach below */
    } finally {
      clearInterval(ticker);
      await session.close();
      await gateway.close();
    }
    state.connected = false;
    screen.draw(render(brokerVm(state, [gap ? 'observer stream gap — reattaching for a fresh snapshot…' : 'broker connection lost — reattaching…']), options));
    await systemClock.sleep(REATTACH_DELAY_MS);
  }
}

function fromSnapshot(snapshot: ObserverSnapshotDto): BrokerWatchState {
  const entries = new Map<string, TranscriptEntry>();
  for (const entry of snapshot.transcript) {
    entries.set(`${entry.message.header.id}:${entry.message.header.to}`, {
      message: entry.message,
      pending: entry.pending,
      ...(entry.voided ? { voided: true } : {}),
    });
  }
  return {
    session: snapshot.session,
    headSeq: snapshot.seq,
    liveness: snapshot.liveness,
    broker: snapshot.broker,
    entries,
    connected: true,
  };
}

/**
 * Stream continuity contract (codex review, afterSeq-omission rider): every
 * journal txn is exactly one activity push, so a healthy stream is strictly
 * seq === head+1. `duplicate` (seq <= head) is dropped; `gap` (seq > head+1)
 * means frames were lost — the caller must reattach for a fresh snapshot,
 * never skip over the hole.
 */
function applyPush(state: BrokerWatchState, push: ObserverPush): 'applied' | 'duplicate' | 'gap' {
  if (push.kind === 'presence') {
    state.liveness = push.liveness;
    // Presence carries the real broker heartbeat; activity's `at` is txn
    // time and must never be relabeled as a heartbeat (codex review).
    if (push.liveness.broker) state.broker = { ...state.broker, heartbeatAt: push.liveness.broker.heartbeatAt };
    return 'applied';
  }
  if (push.seq <= state.headSeq) return 'duplicate';
  if (push.seq > state.headSeq + 1) return 'gap';
  state.session = push.session;
  state.headSeq = push.seq;
  for (const event of push.events) {
    if (event.kind !== 'message-sent') continue;
    state.entries.set(`${event.id}:${event.to}`, { message: toStored(event), pending: true });
  }
  for (const id of push.ackedDeliveryIds) {
    const entry = state.entries.get(id);
    if (entry) state.entries.set(id, { ...entry, pending: false });
  }
  for (const id of push.voidedDeliveryIds) {
    const entry = state.entries.get(id);
    if (entry) state.entries.set(id, { ...entry, pending: false, voided: true });
  }
  return 'applied';
}

function brokerVm(state: BrokerWatchState, notices: string[] = []): WatchViewModel {
  const view = uc.view(state.session);
  const transcript = [...state.entries.values()].sort((a, b) => a.message.name.localeCompare(b.message.name));
  return {
    source: { kind: 'broker', ...state.broker, headSeq: state.headSeq, connected: state.connected },
    session: state.session,
    navigators: view.navigators,
    openGrants: view.openGrants,
    transcript,
    presence: presenceFrom(state.session, state.liveness, transcript),
    now: systemClock.now(),
    notices,
  };
}

function presenceFrom(session: SessionState, liveness: LivenessDto | undefined, transcript: readonly TranscriptEntry[]): AgentPresence[] {
  return session.agents.map((agent) => {
    const pending = transcript.filter((e) => e.pending && !e.voided && e.message.header.to === agent);
    const listener = liveness
      ? liveness.agents[agent]?.connectedSince
        ? ({ state: 'live', connectedSince: liveness.agents[agent]!.connectedSince!, lastActivity: liveness.agents[agent]!.lastActivity ?? liveness.agents[agent]!.connectedSince! } as const)
        : ({ state: 'none' } as const)
      : ({ state: 'unknown' } as const);
    return {
      agent,
      listener,
      pendingCount: pending.length,
      ...(pending.length ? { oldestPendingSent: pending.reduce((min, e) => (e.message.header.sent < min ? e.message.header.sent : min), pending[0]!.message.header.sent) } : {}),
    };
  });
}

async function runFsWatch(root: string, options: WatchOptions): Promise<number> {
  const deps = bindFsDeps(root);
  const screen = new Screen();
  for (;;) {
    const state = await deps.store.load();
    if (state) {
      const entries: TranscriptEntry[] = [];
      for (const m of await deps.mailbox.archived()) entries.push({ message: m, pending: false });
      for (const agent of state.agents) {
        for (const m of await deps.mailbox.pending(agent)) entries.push({ message: m, pending: true });
      }
      entries.sort((a, b) => a.message.name.localeCompare(b.message.name));
      const view = uc.view(state);
      const vm: WatchViewModel = {
        source: { kind: 'fs-diagnostic', reason: 'legacy-session' },
        session: state,
        navigators: view.navigators,
        openGrants: view.openGrants,
        transcript: entries,
        presence: presenceFrom(state, undefined, entries),
        now: deps.clock.now(),
        notices: [],
      };
      screen.draw(render(vm, options));
    }
    await deps.clock.sleep(options.refreshSec * 1000);
  }
}

/** Clear-and-redraw with a change gate; slice 2 replaces this with a real
 * event loop (coalesced redraw, resize handling, cursor cleanup). */
class Screen {
  #last = '';
  draw(frame: string): void {
    if (frame === this.#last) return;
    process.stdout.write(`\x1b[2J\x1b[H${frame}`);
    this.#last = frame;
  }
}

function render(vm: WatchViewModel, options: WatchOptions): string {
  const width = Math.max(60, (process.stdout.columns ?? 100) - 1);
  return renderWatchFrame({ model: vm, width, tail: options.tail });
}

const isNoBrokerSession = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error as { code: string }).code === 'session-not-active';
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
