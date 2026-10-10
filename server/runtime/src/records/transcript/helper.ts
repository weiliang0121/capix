import type { TranscriptChange } from '@capix/protocol';
import type { Clock } from '../../runtime/clock.js';
import { TranscriptRecord, type TranscriptRecordOptions } from './record.js';

export class TranscriptRecordHelper {
  static create(clock: Clock, options: Omit<TranscriptRecordOptions, 'occurredAt'>, value: TranscriptChange): TranscriptRecord {
    return new TranscriptRecord({ ...options, occurredAt: clock.now() }, value);
  }
}
