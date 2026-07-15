import { derivePresence, formatAge } from './derive.ts';
import type { WatchViewModel } from './viewmodel.ts';

/** Pure frame rendering for the human's `pair watch` pane (ANSI). */

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const WARN = `${ESC}[33m`;
const ERROR = `${ESC}[31m`;
// Stable palette assigned by agent order: yellow, cyan, green, magenta, blue, red.
const PALETTE = [33, 36, 32, 35, 34, 31].map((n) => `${ESC}[${n}m`);

export type WatchInput = {
  readonly model: WatchViewModel;
  readonly width: number;
  readonly tail: number;
  readonly stalledAfterSec?: number;
};

function sourceLabel(source: WatchViewModel['source']): string {
  if (source.kind === 'fs-diagnostic') {
    const reason = source.reason === 'legacy-session' ? 'legacy session' : 'broker unreachable';
    return `${WARN}fs diagnostic (may lag)${RESET} | ${reason}`;
  }
  const connection = source.connected ? 'connected' : `${WARN}reconnecting${RESET}`;
  return `${ESC}[32mbroker authoritative${RESET} | epoch ${source.epoch} | head ${source.headSeq} | pid ${source.pid} | ${connection}`;
}

export function renderWatchFrame({ model, width, tail, stalledAfterSec = 90 }: WatchInput): string {
  const { session } = model;
  const frameWidth = Math.max(20, width);
  const bodyWidth = Math.max(1, frameWidth - 3);
  const color = new Map(session.agents.map((agent, index) => [agent, PALETTE[index % PALETTE.length]!]));
  const paint = (agent: string) => `${color.get(agent) ?? ''}${agent}${RESET}`;
  const lines: string[] = [];

  lines.push(`${BOLD} claudex pair — ${session.task}${RESET}`);
  lines.push(` source: ${sourceLabel(model.source)}`);
  if (model.source.kind === 'broker') {
    lines.push(`${DIM} endpoint: ${model.source.endpoint} | heartbeat: ${model.source.heartbeatAt}${RESET}`);
  }
  const statusColor = session.status === 'active' ? `${ESC}[32m` : ERROR;
  const navs = model.navigators.length ? model.navigators.map(paint).join(', ') : `${DIM}(none)${RESET}`;
  lines.push(
    ` status: ${statusColor}${session.status}${RESET}   driver: ${paint(session.driver)}   navigators: ${navs}   turn: ${color.get(session.turn) ?? ''}${BOLD}${session.turn}${RESET}`,
  );

  for (const notice of model.notices) lines.push(` ${WARN}! ${notice}${RESET}`);

  lines.push(` ${BOLD}presence${RESET}`);
  if (!model.presence.length) lines.push(`   ${DIM}(no presence data)${RESET}`);
  for (const item of model.presence.map((value) => derivePresence(value, model.now, stalledAfterSec))) {
    let listener: string;
    let activity: string;
    if (item.listener.state === 'live') {
      listener = `live for ${formatAge(item.listenerAgeSec)}`;
      activity = `${formatAge(item.activityAgeSec)} ago`;
    } else if (item.listener.state === 'none') {
      listener = 'none';
      activity = 'unknown (no listener)';
    } else {
      listener = 'unknown (fs diagnostic)';
      activity = 'unknown (fs diagnostic)';
    }
    const pending = item.pendingCount === 0
      ? '0'
      : `${item.pendingCount}, oldest ${formatAge(item.pendingAgeSec)} ago`;
    const warning = item.stalled ? ` ${ERROR}[stalled: pending mail, no listener]${RESET}` : '';
    lines.push(`   ${paint(item.agent)} listener: ${listener} | last activity: ${activity} | pending: ${pending}${warning}`);
  }

  if (model.openGrants.length) {
    const grants = model.openGrants
      .map((grant) => `${paint(grant.assignee)}${DIM} [${grant.state}] ${grant.id}: ${grant.task}${RESET}`)
      .join('   ');
    lines.push(` grants: ${grants}`);
  }
  lines.push(DIM + '─'.repeat(frameWidth) + RESET);

  const tailCount = Math.max(0, tail);
  const shown = tailCount === 0 ? [] : model.transcript.slice(-tailCount);
  if (!shown.length) lines.push(`${DIM} (no messages yet)${RESET}`);
  for (const { message, pending, voided } of shown) {
    const header = message.header;
    const pendingFlag = pending ? ` ${ESC}[35m[pending]${RESET}` : '';
    const voidedFlag = voided ? ` ${ERROR}[voided]${RESET}` : '';
    lines.push('');
    lines.push(`${color.get(header.from) ?? ''}${BOLD}${header.from}${RESET} ${DIM}-> ${header.to} | ${header.type} | turn:${header.turn} | ${header.sent}${RESET}${pendingFlag}${voidedFlag}`);
    for (let line of message.body.split(/\r?\n/)) {
      while (line.length > bodyWidth) {
        lines.push(`   ${line.slice(0, bodyWidth)}`);
        line = line.slice(bodyWidth);
      }
      lines.push(`   ${line}`);
    }
  }
  lines.push('');
  lines.push(DIM + '─'.repeat(frameWidth) + RESET);
  lines.push(`${DIM} last ${tail} messages | Ctrl+C to exit${RESET}`);
  return lines.join('\n');
}
