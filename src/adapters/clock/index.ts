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

export const systemIds: Ids = {
  messageId: () => formatMessageId(new Date()),
};
