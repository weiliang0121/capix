import { isSafeInteger } from 'es-toolkit/compat';
import { isNonBlankString } from '../../value/string.js';
import { isUndefined } from 'es-toolkit/predicate';
import { pick, omitBy } from 'es-toolkit/object';
import type { MemoryRecord as MemoryRecordData, MemoryRecordValue } from '@capix-observer/protocol';
import type { ChangeSource } from '../source.js';
import { BaseRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

export interface MemoryDefinition {
  memoryId: string;
  memoriesId: string;
  sequence: number;
  source?: ChangeSource;
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
  constructor(definition: MemoryDefinition, value: MemoryRecordValue) {
    super(snapshotValue(value), definition.source?.callId);
    if (!isNonBlankString(definition.memoriesId) || !isSafeInteger(definition.sequence) || definition.sequence < 1) throw new Error('Memory change requires a scope and a positive sequence');
    this.memoryId = definition.memoryId;
    this.memoriesId = definition.memoriesId;
    this.sequence = definition.sequence;
    this.executionId = definition.source?.executionId;
    this.operationId = definition.source?.operationId;
    this.contextId = definition.source?.contextId;
    this.callId = definition.source?.callId;
    Object.freeze(this);
  }

  override toJSON(): MemoryRecordData {
    return { ...super.toJSON(), ...pick(this, ['memoryId', 'memoriesId', 'sequence']), ...omitBy(pick(this, ['executionId', 'operationId', 'contextId', 'callId']), isUndefined) };
  }
}
