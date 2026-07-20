import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { reduceWatch } from '@adapters/tui/reducer.ts';
import { NoBrokerSessionError, runBrokerEventLoop, runFsEventLoop, type WatchLoopHooks, type WatchLoopOptions } from './watchLoop.ts';
import type { CredentialResult } from './credentialStore.ts';

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

/** Test seams (close-out #7): the non-TTY/fs exclusion proof needs to pin
 * that a non-interactive host performs ZERO credential activity — so the
 * interactivity probe and the credential loader are injectable, and the
 * event-loop hooks pass through. Prod call sites pass nothing. */
export type WatchHooks = WatchLoopHooks & {
  interactive?: boolean;
  loadCredential?: (root: string, options: { createIfMissing: boolean }) => Promise<CredentialResult>;
};

export async function runWatch(root: string, options: WatchOptions, hooks: WatchHooks = {}): Promise<number> {
  const fsMode = process.env['CLAUDEX_PROTOCOL_MODE'] === 'fs' || !existsSync(join(root, '.pair', 'journal'));
  if (!fsMode) {
    // U1 frozen exclusion: only an interactive TTY host may load or create
    // the user credential — piped/scripted stdin never touches the store,
    // never user-attaches, and exposes no send path.
    const interactive = hooks.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    let userToken: string | undefined;
    let credentialError: string | undefined;
    if (interactive) {
      // Discover the AUTHORITATIVE registration state BEFORE touching the
      // store (codex slice review #3): a missing credential with an
      // existing binding is a loud error, never a regenerated token — and
      // an empty journal falls to fs mode having touched nothing.
      const { BrokerGateway } = await import('./brokerGateway.ts');
      const probe = BrokerGateway.forRoot(root);
      let registered: boolean | undefined;
      try {
        registered = Boolean((await probe.status()).session.userChannelTokenHash);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'session-not-active') {
          await probe.close();
          return runFsEventLoop(root, options, reduceWatch);
        }
        registered = undefined; // unreachable: undetermined — never create
      } finally {
        await probe.close().catch(() => undefined);
      }
      const loadCredential = hooks.loadCredential ?? (await import('./credentialStore.ts')).loadOrCreateUserToken;
      const credential = await loadCredential(root, { createIfMissing: registered === false });
      if (credential.kind === 'error') credentialError = credential.detail;
      else userToken = credential.token;
    }
    try {
      return await runBrokerEventLoop(root, { ...options, ...(userToken ? { userToken } : {}), ...(credentialError ? { credentialError } : {}) }, reduceWatch, hooks);
    } catch (error) {
      if (!(error instanceof NoBrokerSessionError)) throw error;
      // Journal dir exists but holds no session — fall through, labeled.
    }
  }
  return runFsEventLoop(root, options, reduceWatch, hooks);
}
