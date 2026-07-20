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

/** Item 7 round 2 (codex): millisecond-only ids collide under same-tick
 * sends (a fast loop, or two processes sharing a clock tick). Suffix =
 * 2 base36 chars of per-process sequence (same-process ids can never
 * collide) + 4 random base36 chars (cross-process safety). The sortable
 * wall-clock prefix is kept; session_id is deliberately deferred to the
 * M1 registry identity work. */
let idSeq = 0;
function idSuffix(): string {
  idSeq = (idSeq + 1) % 1296;
  const rand = Math.floor(Math.random() * 1_679_616); // 36^4
  return `${idSeq.toString(36).padStart(2, '0')}${rand.toString(36).padStart(4, '0')}`;
}

export const systemIds: Ids = {
  messageId: () => `${formatMessageId(new Date())}-${idSuffix()}`,
};
