import { isSafeInteger } from 'es-toolkit/compat';
import { isNonBlankString } from '../../value/string.js';
import { pick } from 'es-toolkit/object';
import type { MemoryRecord as MemoryRecordData, MemoryRecordValue } from '@capix-observer/protocol';
import { BaseRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

/** An applied change, with its own identity and immutable content. */
export class MemoryRecord extends BaseRecord<MemoryRecordValue> implements MemoryRecordData {
  constructor(
    readonly memoryId: string,
    readonly memoriesId: string,
    readonly sequence: number,
    readonly executionId: string | undefined,
    readonly operationId: string | undefined,
    value: MemoryRecordValue,
    readonly contextId?: string,
    readonly callId?: string,
  ) {
    super(snapshotValue(value), callId);
    if (!isNonBlankString(memoriesId) || !isSafeInteger(sequence) || sequence < 1) throw new Error('Memory change requires a scope and a positive sequence');
    Object.freeze(this);
  }

  override toJSON(): MemoryRecordData {
    return { ...super.toJSON(), ...pick(this, ['memoryId', 'memoriesId', 'sequence', 'executionId', 'operationId', 'contextId', 'callId']) };
  }
}
