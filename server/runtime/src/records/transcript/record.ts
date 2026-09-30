import type { TranscriptChange, TranscriptRecord as RecordData } from '@capix-observer/protocol';
import type { ChangeSource } from '../source.js';
import { BaseRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

export interface TranscriptDefinition {
  transcriptId: string;
  revision: number;
  occurredAt: string;
  source?: ChangeSource;
}

export class TranscriptRecord extends BaseRecord<TranscriptChange> implements RecordData {
  override readonly kind = 'transcript' as const;
  readonly transcriptId: string;
  readonly revision: number;
  readonly occurredAt: string;
  readonly contextId?: string;
  readonly callId?: string;
  readonly executionId?: string;
  constructor(definition: TranscriptDefinition, value: TranscriptChange) {
    super(snapshotValue(value), definition.source?.callId);
    this.transcriptId = definition.transcriptId;
    this.revision = definition.revision;
    this.occurredAt = definition.occurredAt;
    this.contextId = definition.source?.contextId;
    this.callId = definition.source?.callId;
    this.executionId = definition.source?.executionId;
    Object.freeze(this);
  }
  override toJSON(): RecordData {
    return { ...super.toJSON(), transcriptId: this.transcriptId, revision: this.revision, occurredAt: this.occurredAt, ...(this.contextId ? { contextId: this.contextId, callId: this.callId, executionId: this.executionId } : {}) };
  }
}
