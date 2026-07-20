import { derivePresence, formatAge } from './derive.ts';
import type { ComposerState } from './events.ts';
import type { TranscriptEntry } from './viewmodel.ts';
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
  readonly composer?: ComposerState;
  readonly stalledAfterSec?: number;
};

type LogicalTranscriptEntry = {
  readonly entries: readonly TranscriptEntry[];
  readonly userGroup: boolean;
};

function sourceLabel(source: WatchViewModel['source']): string {
  if (source.kind === 'fs-diagnostic') {
    const reason = source.reason === 'legacy-session' ? 'legacy session' : 'broker unreachable';
    return `${WARN}fs diagnostic (may lag)${RESET} | ${reason}`;
  }
  const connection = source.connected ? 'connected' : `${WARN}reconnecting${RESET}`;
  return `${ESC}[32mbroker authoritative${RESET} | epoch ${source.epoch} | head ${source.headSeq} | pid ${source.pid} | ${connection}`;
}

export function renderWatchFrame({ model, width, tail, composer, stalledAfterSec = 90 }: WatchInput): string {
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

  const logical = logicalTranscript(model.transcript).filter((entry) => matchesFilter(entry, composer?.filter ?? 'all'));
  const tailCount = Math.max(0, tail);
  const scrollOffset = Math.min(composer?.scrollOffset ?? 0, Math.max(0, logical.length - tailCount));
  const end = Math.max(0, logical.length - scrollOffset);
  const shown = tailCount === 0 ? [] : logical.slice(Math.max(0, end - tailCount), end);
  if (!shown.length) lines.push(`${DIM} (no messages yet)${RESET}`);
  for (const logicalEntry of shown) {
    const first = logicalEntry.entries[0];
    if (!first) continue;
    const { message } = first;
    const header = message.header;
    const pendingFlag = !logicalEntry.userGroup && logicalEntry.entries[0]!.pending ? ` ${ESC}[35m[pending]${RESET}` : '';
    const voidedFlag = !logicalEntry.userGroup && logicalEntry.entries[0]!.voided ? ` ${ERROR}[voided]${RESET}` : '';
    const deliveryBadges = logicalEntry.userGroup
      ? ` ${logicalEntry.entries.map((entry) => `${entry.message.header.to} ${entry.voided ? '×' : entry.pending ? '○' : '✓'}`).join(' ')}`
      : '';
    lines.push('');
    const to = logicalEntry.userGroup ? logicalEntry.entries.map((entry) => entry.message.header.to).join(',') : header.to;
    const actionKind = (header as typeof header & { actionKind?: string }).actionKind;
    const actionMarker = actionKind ? ` ${WARN}⚡ user action: ${actionKind}${RESET}` : '';
    lines.push(`${color.get(header.from) ?? ''}${BOLD}${header.from}${RESET} ${DIM}-> ${to} | ${header.type} | turn:${header.turn} | ${header.sent}${RESET}${actionMarker}${pendingFlag}${voidedFlag}${deliveryBadges}`);
    for (let line of message.body.split(/\r?\n/)) {
      while (line.length > bodyWidth) {
        lines.push(`   ${line.slice(0, bodyWidth)}`);
        line = line.slice(bodyWidth);
      }
      lines.push(`   ${line}`);
    }
  }
  if (composer?.pending) {
    const kind = composer.pending.action ? 'action' : 'send';
    const status = composer.pending.state === 'sending'
      ? `${WARN}${kind === 'action' ? '⚡ executing…' : 'sending…'}${RESET}`
      : `${ERROR}${kind} failed: ${composer.pending.error ?? 'unknown error'} (Enter retries; Esc discards)${RESET}`;
    const detail = composer.pending.action ? composer.pending.body : `to:${composer.pending.target} | ${composer.pending.body}`;
    lines.push('', ` ${status} ${DIM}${detail}${RESET}`);
  }
  lines.push('');
  lines.push(DIM + '─'.repeat(frameWidth) + RESET);
  if (composer?.channel === 'registered') {
    if (composer.confirming && composer.pending?.state !== 'sending') {
      // Freeze-then-mint (design REV 6): the SECOND Enter executes exactly
      // the frozen action — never the buffer.
      lines.push(` ${WARN}${BOLD}CONFIRM ${composer.confirming.display} — Enter to execute, Esc to abort${RESET}`);
    }
    if (composer.actionHint) lines.push(` ${WARN}${composer.actionHint}${RESET}`);
    lines.push(` ${BOLD}to:${composer.target}${RESET} ${composer.buffer}`);
  } else if (composer?.channel === 'unregistered') {
    lines.push(` ${WARN}! user channel is not registered; waiting for secure registration${RESET}`);
  } else if (composer?.channel === 'credential-error') {
    lines.push(` ${ERROR}! USER CREDENTIAL ERROR: ${composer.channelDetail ?? 'the local credential is missing or unreadable'}${RESET}`);
    lines.push(` ${ERROR}  This channel cannot silently regenerate; an explicit reset ceremony is required.${RESET}`);
  }
  const scroll = scrollOffset > 0 ? ' | [scrollback] End to follow' : '';
  const filter = composer ? ` | filter:${composer.filter}` : '';
  lines.push(`${DIM} last ${tail} messages${scroll}${filter} | Ctrl+C/Ctrl+Q to exit${RESET}`);
  return lines.join('\n');
}

/** Group a user broadcast into one logical transcript item while preserving
 * the commit order of all other entries. */
export function logicalTranscript(entries: readonly TranscriptEntry[]): readonly LogicalTranscriptEntry[] {
  const result: LogicalTranscriptEntry[] = [];
  const groups = new Map<string, number>();
  for (const entry of entries) {
    const metadata = userMetadata(entry);
    if (!metadata) {
      result.push({ entries: [entry], userGroup: false });
      continue;
    }
    const existing = groups.get(metadata.groupId);
    if (existing === undefined) {
      groups.set(metadata.groupId, result.length);
      result.push({ entries: [entry], userGroup: true });
    } else {
      const previous = result[existing]!;
      result[existing] = { ...previous, entries: [...previous.entries, entry] };
    }
  }
  return result;
}

export function visibleTranscriptCount(entries: readonly TranscriptEntry[], filter: ComposerState['filter']): number {
  return logicalTranscript(entries).filter((entry) => matchesFilter(entry, filter)).length;
}

function matchesFilter(entry: LogicalTranscriptEntry, filter: ComposerState['filter']): boolean {
  if (filter === 'all') return true;
  if (filter === 'user') return entry.userGroup;
  if (entry.userGroup) return false;
  const type = entry.entries[0]?.message.header.type;
  const dialogue = type === 'ask' || type === 'answer' || type === 'review';
  return filter === 'dialogue' ? dialogue : !dialogue;
}

function userMetadata(entry: TranscriptEntry): { groupId: string } | undefined {
  const header = entry.message.header as typeof entry.message.header & {
    readonly groupId?: string;
    readonly provenance?: string;
  };
  return header.provenance === 'trusted_user_client' && header.groupId
    ? { groupId: header.groupId }
    : undefined;
}
