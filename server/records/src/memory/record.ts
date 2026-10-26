import { isSafeInteger } from 'es-toolkit/compat';
import { isString, isUndefined } from 'es-toolkit/predicate';
import { pick, omitBy } from 'es-toolkit/object';
import type { MemoryRecord as MemoryRecordData, MemoryRecordValue } from '@capix/protocol';
import type { RecordChangeSource } from '../source.js';
import { BaseRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

export interface MemoryRecordOptions {
  memoryId: string;
  memoriesId: string;
  sequence: number;
  source?: RecordChangeSource;
}

/** An applied change, with its own identity and immutable content. */
export class MemoryRecord extends BaseRecord<MemoryRecordValue> implements MemoryRecordData {
  override readonly kind = 'memory' as const;
  readonly memoryId: string;
  readonly memoriesId: string;
  readonly sequence: number;
  readonly executionId?: string;
  readonly operationId?: string;
  readonly contextId?: string;
  readonly callId?: string;
  constructor(options: MemoryRecordOptions, value: MemoryRecordValue) {
    super(snapshotValue(value), options.source?.callId);
    if (!isString(options.memoriesId) || !/\S/u.test(options.memoriesId) || !isSafeInteger(options.sequence) || options.sequence < 1) throw new Error('Memory change requires a scope and a positive sequence');
    this.memoryId = options.memoryId;
    this.memoriesId = options.memoriesId;
    this.sequence = options.sequence;
    this.executionId = options.source?.executionId;
    this.operationId = options.source?.operationId;
    this.contextId = options.source?.contextId;
    this.callId = options.source?.callId;
    Object.freeze(this);
  }

  override toJSON(): MemoryRecordData {
    return { ...super.toJSON(), ...pick(this, ['memoryId', 'memoriesId', 'sequence']), ...omitBy(pick(this, ['executionId', 'operationId', 'contextId', 'callId']), isUndefined) };
  }
}
