import type { AgentId, MessageId, SessionState, Timestamp } from '@core/types.ts';
import type { CommandEnvelope } from '@core/commands.ts';
import type { Event } from '@core/events.ts';

/**
 * Port interfaces — owned by the app layer (ARCHITECTURE.md). Outbound
 * adapters implement these; the app never touches IO directly.
 */

/** A delivered or pending mailbox message, as stored on disk. */
export type StoredMessage = {
  readonly name: string;
  readonly header: {
    readonly id: MessageId;
    readonly from: AgentId;
    readonly to: AgentId;
    readonly type: string;
    readonly turn: string;
    readonly sent: Timestamp;
    /** U1: present on user-channel messages only — one logical send
     * (groupId === reqId) fanned to recipients; reducers aggregate ack
     * badges by it. Broker-projected; fs archive round-trip is diagnostic
     * mode and deliberately drops them (no user channel there). */
    readonly groupId?: string;
    readonly provenance?: 'trusted_user_client';
    /** U1 slice 4: durable discriminator on ACTION notices — the renderer's
     * lightning marker keys on this, never on provenance (design REV 6). */
    readonly actionKind?: import('@core/events.ts').UserActionKind;
  };
  readonly body: string;
  readonly raw: string;
};

export type CommitReceipt = {
  /** Mailbox file names written by this commit, in event order. */
  readonly messageFiles: readonly string[];
};

/**
 * Durable protocol state. The fs adapter persists snapshot files (.pair
 * format); the future broker client sends the envelope over IPC and the
 * broker journals JournalRecords — same port, same core.
 */
export interface ProtocolStore {
  load(): Promise<SessionState | undefined>;
  /** Apply decided events durably. Must be atomic per ENHANCEMENTS.md limits. */
  commit(envelope: CommandEnvelope, events: readonly Event[]): Promise<CommitReceipt>;
  /** Initialize storage for a brand-new session (dirs, memory template, gitignore). */
  initialize(envelope: CommandEnvelope, events: readonly Event[]): Promise<{ gitignoreUpdated: boolean }>;
}

export interface Mailbox {
  pending(agent: AgentId): Promise<readonly StoredMessage[]>;
  /** Deliver: move pending messages to the archive and return them. */
  claim(agent: AgentId): Promise<readonly StoredMessage[]>;
  archived(last?: number): Promise<readonly StoredMessage[]>;
}

export interface Clock {
  now(): Timestamp;
  epochMs(): number;
  sleep(ms: number): Promise<void>;
}

export interface Ids {
  /** 'yyyyMMdd-HHmmss-fff' in the current format — the mailbox file id. */
  messageId(): MessageId;
}

export type Deps = {
  store: ProtocolStore;
  mailbox: Mailbox;
  clock: Clock;
  ids: Ids;
};
