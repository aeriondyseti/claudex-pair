import type { StoredMessage } from '@app/ports/index.ts';
import type { SessionView } from '@app/usecases.ts';

/** Pure frame rendering for the human's `pair watch` pane (ANSI). */

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
// Stable palette assigned by agent order: yellow, cyan, green, magenta, blue, red.
const PALETTE = [33, 36, 32, 35, 34, 31].map((n) => `${ESC}[${n}m`);

export type WatchInput = {
  view: SessionView;
  entries: readonly { message: StoredMessage; pending: boolean }[];
  width: number;
  tail: number;
  refreshSec: number;
};

export function renderWatchFrame({ view, entries, width, tail, refreshSec }: WatchInput): string {
  const { session } = view;
  const color = new Map(session.agents.map((a, i) => [a, PALETTE[i % PALETTE.length]!]));
  const paint = (agent: string) => `${color.get(agent) ?? ''}${agent}${RESET}`;
  const lines: string[] = [];

  lines.push(`${BOLD} claudex pair — ${session.task}${RESET}`);
  const statusColor = session.status === 'active' ? `${ESC}[32m` : `${ESC}[31m`;
  const navs = view.navigators.map(paint).join(', ');
  lines.push(
    ` status: ${statusColor}${session.status}${RESET}   driver: ${paint(session.driver)}   navigators: ${navs}   turn: ${color.get(session.turn) ?? ''}${BOLD}${session.turn}${RESET}`,
  );
  if (view.openGrants.length) {
    const grants = view.openGrants
      .map((g) => `${paint(g.assignee)}${DIM} [${g.state}] ${g.id}${RESET}`)
      .join('   ');
    lines.push(` grants: ${grants}`);
  }
  lines.push(DIM + '─'.repeat(width) + RESET);

  const shown = entries.slice(-tail);
  if (!shown.length) lines.push(`${DIM} (no messages yet)${RESET}`);
  for (const { message, pending } of shown) {
    const h = message.header;
    const flag = pending ? ` ${ESC}[35m[undelivered]${RESET}` : '';
    lines.push('');
    lines.push(`${color.get(h.from) ?? ''}${BOLD}${h.from}${RESET} ${DIM}-> ${h.to} | ${h.type} | turn:${h.turn} | ${h.sent}${RESET}${flag}`);
    for (let line of message.body.split(/\r?\n/)) {
      while (line.length > width - 3) {
        lines.push(`   ${line.slice(0, width - 3)}`);
        line = line.slice(width - 3);
      }
      lines.push(`   ${line}`);
    }
  }
  lines.push('');
  lines.push(DIM + '─'.repeat(width) + RESET);
  lines.push(`${DIM} refresh ${refreshSec}s | last ${tail} messages | Ctrl+C to exit${RESET}`);
  return lines.join('\n');
}
