import type { BaseRecord } from './types.js';

/** Deliberately narrow recorded content; not the complete Memory value or recovery material. */
export interface MemoryRecordContent {
  readonly content: string;
}

/** Current projected content and available changes for one collection, without implied sources. */
export interface MemoryRecordObservation {
  readonly items: readonly {
    readonly id: string;
    readonly value: MemoryRecordContent;
    readonly records: readonly MemoryRecord[];
  }[];
}

export interface MemoryRecordValue {
  readonly action: 'create' | 'update';
  readonly reason?: string;
  readonly result: MemoryRecordContent;
}

export interface MemoryRecord extends BaseRecord<MemoryRecordValue> {
  readonly memoryId: string;
  /** Formal changes are ordered within one Memories instance. */
  readonly memoriesId: string;
  readonly sequence: number;
  readonly contextId?: string;
  readonly callId?: string;
  readonly executionId?: string;
  readonly operationId?: string;
}

/** Accept only the declared display projection, never a complete domain value or the old DTO. */
export function validateMemoryRecordValue(value: unknown): asserts value is MemoryRecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid memory record value');
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, 'action') || !Object.hasOwn(record, 'result') || (record.action !== 'create' && record.action !== 'update') || Object.keys(record).some((key) => !['action', 'reason', 'result'].includes(key)) || (Object.hasOwn(record, 'reason') && typeof record.reason !== 'string')) throw new Error('Invalid memory record value');
  const result = record.result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 || !Object.hasOwn(result, 'content') || typeof (result as Record<string, unknown>).content !== 'string') throw new Error('Invalid memory display value');
}
