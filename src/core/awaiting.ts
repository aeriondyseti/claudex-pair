import type { AgentId, MessageId, MessageType, Timestamp } from './types.ts';

/**
 * ENHANCEMENTS item 7 — the ONE resolution rule for the awaiting-set,
 * shared by the journal (authoritative, replayed with the records) and
 * every projection built from pushes. An ask registers; it resolves only
 * when a valid reply type arrives on the reverse endpoints carrying
 * replyTo === the ask's id. Anything else — wrong type, wrong sender,
 * wrong recipient, unknown id — leaves the set untouched; the header
 * still records the advisory replyTo.
 */
export type AwaitingEntry = {
  readonly messageId: MessageId;
  readonly from: AgentId;
  readonly to: AgentId;
  readonly sentAt: Timestamp;
};

export type ThreadedHeader = {
  readonly id: MessageId;
  readonly from: AgentId;
  readonly to: AgentId;
  readonly type: MessageType;
  readonly sent: Timestamp;
  readonly replyTo?: MessageId;
};

/** reply_to resolves on answer/review only (ENHANCEMENTS item 7). */
const RESOLVING_TYPES: ReadonlySet<string> = new Set(['answer', 'review']);

export function applyMessageToAwaiting(awaiting: Map<string, AwaitingEntry>, message: ThreadedHeader): void {
  if (RESOLVING_TYPES.has(message.type)) {
    if (message.replyTo !== undefined) {
      const entry = awaiting.get(message.replyTo);
      if (entry && message.from === entry.to && message.to === entry.from) {
        awaiting.delete(message.replyTo);
      }
    } else {
      // Compatibility rule (round 2): an UNTAGGED answer/review settles the
      // OLDEST open debt on the reverse endpoints — otherwise a partner not
      // yet sending -ReplyTo leaves phantom debts forever. Anything with
      // more than one ask in flight must tag (PROTOCOL "Threading").
      for (const [id, entry] of awaiting) {
        if (entry.to === message.from && entry.from === message.to) {
          awaiting.delete(id);
          break;
        }
      }
    }
  }
  if (message.type === 'ask') {
    awaiting.set(message.id, { messageId: message.id, from: message.from, to: message.to, sentAt: message.sent });
  }
}

/** Membership cleanup: a removed/left agent can neither answer nor be
 * answered — drop every entry it appears on (either side). */
export function removeAgentFromAwaiting(awaiting: Map<string, AwaitingEntry>, agent: AgentId): void {
  for (const [id, entry] of awaiting) {
    if (entry.from === agent || entry.to === agent) awaiting.delete(id);
  }
}
