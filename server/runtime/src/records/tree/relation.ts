import { isUndefined } from 'es-toolkit/predicate';
import type { RecordBook } from '../container/book.js';
import type { BaseRecord } from '../record.js';
import { CompositeRecord } from '../composite.js';
import { RuntimeRecord } from '../runtime/record.js';
import { InvocationRecord } from '../invocation/record.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord } from '../operation/record.js';
import { AttemptRecord } from '../attempt/record.js';
import { EventRecord } from '../event/record.js';
import { MemoryRecord } from '../memory/record.js';
import { TranscriptRecord } from '../transcript/record.js';

/** Existing record kinds' ownership rules; no storage, indexing or publication. */
export function checkRelation(record: BaseRecord<unknown>, parent: CompositeRecord<unknown> | undefined, book: RecordBook): void {
  if (record instanceof RuntimeRecord && parent) throw new Error('Runtime must be a root record');
  if (record instanceof ExecutionRecord && !(parent instanceof RuntimeRecord)) throw new Error('Execution requires a Runtime parent');
  if (record instanceof OperationRecord) {
    if (!(parent instanceof ExecutionRecord || parent instanceof OperationRecord)) throw new Error('Operation requires an execution or operation parent');
    if (record.parentId !== (record.parentOperationId ?? record.executionId)) throw new Error('Inconsistent operation parent');
  }
  if (record instanceof AttemptRecord && (!(parent instanceof OperationRecord) || record.operationId !== parent.id)) throw new Error('Attempt requires an operation parent');
  if (record instanceof EventRecord && !(parent instanceof InvocationRecord)) throw new Error('Event requires a call parent');
  const content = record instanceof MemoryRecord || record instanceof TranscriptRecord;
  if (!parent) {
    if (content && (!isUndefined(record.callId) || !isUndefined(record.contextId) || !isUndefined(record.executionId) || (record instanceof MemoryRecord && !isUndefined(record.operationId)))) throw new Error('Content source requires a call parent');
    return;
  }

  if (content && !(parent instanceof InvocationRecord)) throw new Error('Content source requires a call parent');
  const ancestors: CompositeRecord<unknown>[] = [];
  const seen = new Set([record.id]);
  for (let current: BaseRecord<unknown> | undefined = parent; current; current = isUndefined(current.parentId) ? undefined : book.get(current.parentId)) {
    if (!(current instanceof CompositeRecord) || seen.has(current.id)) throw new Error('Invalid record ancestry');
    seen.add(current.id);
    ancestors.push(current);
    if (!isUndefined(current.parentId) && !book.get(current.parentId)) throw new Error('Record ancestor does not exist');
  }
  const execution = ancestors.find((ancestor) => ancestor instanceof ExecutionRecord);
  if (record instanceof OperationRecord || record instanceof EventRecord || content) {
    if (!(execution instanceof ExecutionRecord) || record.executionId !== execution.id) throw new Error('Record belongs to another execution');
  }
  if (record instanceof EventRecord) {
    const expected = record.value.type === 'call' ? 'running' : record.value.type === 'return' ? 'succeeded' : 'failed';
    if (!(parent instanceof InvocationRecord) || record.callId !== parent.id || parent.status !== expected) throw new Error('Event does not match the invocation record state');
    // Terminal evidence is recorded after the call has ended.
    return;
  }
  if (record instanceof InvocationRecord && ancestors.some((ancestor) => ancestor instanceof InvocationRecord && ancestor.status !== 'running')) throw new Error('Record has already ended');
  if (content) {
    if (record.callId !== parent.id || record.contextId !== ('contextId' in parent ? parent.contextId : undefined)) throw new Error('Content source does not match its call');
    if (record instanceof MemoryRecord) {
      const operation = ancestors.find((ancestor) => ancestor instanceof OperationRecord);
      if (record.operationId !== operation?.id) throw new Error('Content source does not match its operation');
    }
  }
}
