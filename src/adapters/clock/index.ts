import type { Clock, Ids } from '@app/ports/index.ts';

/** System clock + id source. The only place wall time is read. */

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

export function formatTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 'yyyyMMdd-HHmmss-fff' — matches pair.ps1 message ids. */
export function formatMessageId(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

export const systemClock: Clock = {
  now: () => formatTimestamp(new Date()),
  epochMs: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Item 7 round 3 (codex): same-tick uniqueness must be STRUCTURAL, never
 * a random coincidence — a per-tick counter that never wraps guarantees
 * same-process uniqueness at any rate; the per-process nonce separates
 * processes sharing a tick. Factory form so tests can freeze the clock
 * and cross the old wrap boundary. session_id is a separate identity
 * minted at pair init (M1) - not derived from message ids. */
export function makeMessageIdSource(nonce: string, now: () => Date): () => string {
  let lastPrefix = '';
  let seq = 0;
  return () => {
    const prefix = formatMessageId(now());
    if (prefix === lastPrefix) seq += 1;
    else { lastPrefix = prefix; seq = 0; }
    return `${prefix}-${nonce}${seq.toString(36)}`;
  };
}

const processNonce = Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0'); // 36^4

export const systemIds: Ids = {
  messageId: makeMessageIdSource(processNonce, () => new Date()),
};
