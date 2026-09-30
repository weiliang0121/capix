import type { TranscriptChange } from '@capix-observer/protocol';
import type { Clock } from '../../runtime/clock.js';
import { TranscriptRecord, type TranscriptDefinition } from './record.js';

export class TranscriptRecordHelper {
  static create(clock: Clock, definition: Omit<TranscriptDefinition, 'occurredAt'>, value: TranscriptChange): TranscriptRecord {
    return new TranscriptRecord({ ...definition, occurredAt: clock.now() }, value);
  }
}
