import type { TranscriptChange, TranscriptRecord as RecordData } from '@capix-observer/protocol';
import { BaseRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

export class TranscriptRecord extends BaseRecord<TranscriptChange> implements RecordData {
  constructor(
    readonly transcriptId: string,
    readonly occurredAt: string,
    value: TranscriptChange,
    readonly contextId?: string,
    readonly callId?: string,
    readonly executionId?: string,
  ) {
    super(snapshotValue(value), callId);
    Object.freeze(this);
  }
  override toJSON(): RecordData {
    return { ...super.toJSON(), transcriptId: this.transcriptId, occurredAt: this.occurredAt, ...(this.contextId ? { contextId: this.contextId, callId: this.callId, executionId: this.executionId } : {}) };
  }
}
