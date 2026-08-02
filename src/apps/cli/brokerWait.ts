import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Delivery, DeliverySubscription } from '@app/ports/gateway.ts';
import { parseTimestamp } from '@core/stats.ts';
import { dur } from './stats.ts';

export async function nextDelivery(subscription: DeliverySubscription, timeoutSec: number): Promise<Delivery | undefined> {
  const next = subscription.deliveries[Symbol.asyncIterator]().next();
  if (timeoutSec === Infinity) return (await next).value;
  return new Promise<Delivery | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutSec * 1000));
    void next.then((result) => { clearTimeout(timer); resolve(result.value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** F14 boundary: stdout write callback (flush to OS) completes before durable ack. */
export async function printDeliveryThenAck(
  delivery: Delivery,
  subscription: DeliverySubscription,
  write: (text: string) => Promise<void> = writeStdout,
): Promise<void> {
  await write(`${'='.repeat(66)}\nINCOMING ${delivery.message.name}\n${'-'.repeat(66)}\n${delivery.message.raw}\n`);
  await subscription.ack(delivery.deliveryId);
}

const writeStdout = (text: string) => new Promise<void>((resolve, reject) => {
  process.stdout.write(text, (error) => error ? reject(error) : resolve());
});

/**
 * T2 wake packet rendering — the orientation block under an INCOMING
 * message, so the waking agent acts without re-running status/log:
 * protocol facts from the broker digest, the sender's declared review
 * scope from the header, and a local memory.md pointer. Printed AFTER the
 * ack (it is derived guidance, not the consumed message — F14 covers the
 * message only).
 */
export function renderWakeDigest(
  delivery: Delivery,
  as: string,
  root: string,
  write: (text: string) => void = (t) => process.stdout.write(t),
  nowMs: number = Date.now(),
): void {
  const digest = delivery.digest;
  const scope = delivery.message.header.reviewScope;
  if (!digest && scope === undefined) return;
  const lines: string[] = ['-'.repeat(66)];
  if (scope !== undefined) lines.push(`review scope: ${scope}   (review exactly this — no need to rediscover the diff)`);
  if (digest) {
    const who = digest.turn !== undefined
      ? `turn ${digest.turn === as ? `YOURS (${as})` : digest.turn} · driver ${digest.driver}`
      : `phase ${digest.phase}${digest.substate ? ` (${digest.substate})` : ''}`;
    lines.push(`orientation: status ${digest.status} · ${who}`);
    const age = (sentAt: string): string => {
      const t = parseTimestamp(sentAt);
      return t === null ? '' : ` (${dur(Math.max(0, Math.round((nowMs - t) / 1000)))} ago)`;
    };
    for (const a of digest.awaiting) {
      lines.push(a.to === as
        ? `  you owe ${a.from} a reply to ${a.messageId}${age(a.sentAt)}`
        : `  ${a.to} owes you a reply to ${a.messageId}${age(a.sentAt)}`);
    }
    const f = digest.findingsOpen;
    if (f && (f.high || f.med || f.low)) lines.push(`  unsettled findings: ${f.high} HIGH, ${f.med} MED, ${f.low} LOW`);
    const g = digest.reviewGates;
    if (g && (g.high || g.med)) lines.push(`  REVIEW GATES open: ${g.high} HIGH, ${g.med} MED — handoff/end are blocked until each is answered (-ReplyTo the review id)`);
  }
  try {
    const memory = statSync(join(root, '.pair', 'memory.md'));
    const d = new Date(memory.mtimeMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const mtime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    lines.push(`  memory.md: ${memory.size} bytes, updated ${mtime} — re-read only if that is newer than your last look`);
  } catch { /* no memory file — nothing to point at */ }
  write(`${lines.join('\n')}\n`);
}
