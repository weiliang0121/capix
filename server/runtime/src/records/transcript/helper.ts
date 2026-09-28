import type { TranscriptChange } from '@capix-observer/protocol';
import type { ChangeSource } from '../source.js';
import type { Clock } from '../../runtime/clock.js';
import { TranscriptRecord } from './record.js';

export class TranscriptRecordHelper {
  static create(transcriptId: string, value: TranscriptChange, clock: Clock, source?: ChangeSource): TranscriptRecord {
    return new TranscriptRecord(transcriptId, clock.now(), value, source?.contextId, source?.callId, source?.executionId);
  }
}
