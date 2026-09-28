import type { TranscriptChange, TranscriptRecord as RecordData } from '@capix-observer/protocol';
import { RuntimeRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

export class TranscriptRecord extends RuntimeRecord<TranscriptChange> implements RecordData {
  constructor(
    readonly transcriptId: string,
    readonly occurredAt: string,
    value: TranscriptChange,
    readonly contextId?: string,
    readonly callId?: string,
    readonly executionId?: string,
  ) {
    super(snapshotValue(value));
    Object.freeze(this);
  }
  override toJSON(): RecordData {
    return { ...super.toJSON(), transcriptId: this.transcriptId, occurredAt: this.occurredAt, ...(this.contextId ? { contextId: this.contextId, callId: this.callId, executionId: this.executionId } : {}) };
  }
}
