import type { TranscriptChange, TranscriptRecord as RecordData } from '../data/index.js';
import type { RecordChangeSource } from '../source.js';
import { BaseRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

export interface TranscriptRecordOptions {
  transcriptId: string;
  revision: number;
  occurredAt: string;
  source?: RecordChangeSource;
}

export class TranscriptRecord extends BaseRecord<TranscriptChange> implements RecordData {
  override readonly kind = 'transcript' as const;
  readonly transcriptId: string;
  readonly revision: number;
  readonly occurredAt: string;
  readonly contextId?: string;
  readonly callId?: string;
  readonly executionId?: string;
  constructor(options: TranscriptRecordOptions, value: TranscriptChange) {
    super(snapshotValue(value), options.source?.callId);
    this.transcriptId = options.transcriptId;
    this.revision = options.revision;
    this.occurredAt = options.occurredAt;
    this.contextId = options.source?.contextId;
    this.callId = options.source?.callId;
    this.executionId = options.source?.executionId;
    Object.freeze(this);
  }
  override toJSON(): RecordData {
    return { ...super.toJSON(), transcriptId: this.transcriptId, revision: this.revision, occurredAt: this.occurredAt, ...(this.contextId ? { contextId: this.contextId, callId: this.callId } : {}), ...(this.executionId ? { executionId: this.executionId } : {}) };
  }
}
