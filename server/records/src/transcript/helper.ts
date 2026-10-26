import type { TranscriptChange } from '@capix/protocol';
import type { RecordClock } from '../recorder.js';
import { TranscriptRecord, type TranscriptRecordOptions } from './record.js';

export class TranscriptRecordHelper {
  static create(clock: Pick<RecordClock, 'now'>, options: Omit<TranscriptRecordOptions, 'occurredAt'>, value: TranscriptChange): TranscriptRecord {
    return new TranscriptRecord({ ...options, occurredAt: clock.now() }, value);
  }
}
