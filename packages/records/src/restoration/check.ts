import { hasOutput, validateInvocationRecordValue, validateMemoryRecordValue, type RecordEntry } from '../data/index.js';
import { isPlainObject } from 'es-toolkit/predicate';

type Fields = Record<string, unknown>;

function fail(): never {
  throw new Error('Invalid stored record');
}
function object(value: unknown): Fields {
  if (!isPlainObject(value)) return fail();
  return value;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) fail();
}
function optionalText(value: unknown): void {
  if (value !== undefined) text(value);
}
function integer(value: unknown, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail();
}
function time(value: unknown): void {
  text(value);
  if (!Number.isFinite(Date.parse(value))) fail();
}
function children(value: unknown): void {
  if (!Array.isArray(value) || new Set(value).size !== value.length) fail();
  for (const id of value) text(id);
}

/** Kind-specific saved data, independent from live registration timing. */
export function checkEntry(entry: RecordEntry): void {
  const outer = object(entry);
  if (Object.keys(outer).length !== 2 || !Object.hasOwn(outer, 'kind') || !Object.hasOwn(outer, 'data')) fail();
  const data = object(outer.data);
  text(data.id);
  optionalText(data.parentId);
  if (!Object.hasOwn(data, 'value')) fail();
  if (['invocation', 'runtime', 'runtime-call', 'execution', 'operation', 'attempt'].includes(entry.kind)) children(data.childIds);
  if (['invocation', 'runtime-call', 'execution', 'operation', 'attempt'].includes(entry.kind)) {
    text(data.parentId);
    text(data.contextId);
    if (data.contextId === data.id) fail();
    validateInvocationRecordValue(data.value, data.contextId);
    const output = hasOutput(data.value);
    const error = Object.hasOwn(data.value, 'error');
    if (data.status === 'running' ? output || error : data.status === 'succeeded' ? !output || error : data.status === 'failed' ? !error || output : true) fail();
  }

  switch (entry.kind) {
    case 'invocation':
      if (!['scene', 'group', 'node'].includes(data.structureKind as string)) fail();
      for (const name of ['structureId', 'name', 'label', 'callee', 'role']) optionalText(data[name]);
      if (data.source !== undefined && typeof data.source !== 'string') fail();
      time(object(data.value).startedAt);
      break;
    case 'runtime':
      time(object(data.value).createdAt);
      break;
    case 'runtime-call':
      text(data.runtimeInstanceId);
      time(object(data.value).startedAt);
      break;
    case 'execution':
      time(object(data.value).startedAt);
      break;
    case 'operation':
      for (const name of ['executionId', 'operationInstanceId', 'operation', 'label', 'caller', 'callee']) text(data[name]);
      if (typeof data.source !== 'string') fail();
      optionalText(data.parentOperationId);
      break;
    case 'attempt':
      for (const name of ['operationId', 'name', 'label', 'caller', 'callee']) text(data[name]);
      if (typeof data.source !== 'string') fail();
      break;
    case 'invocation-boundary': {
      text(data.scopeId);
      text(data.callId);
      optionalText(data.executionId);
      integer(data.sequence, 1);
      time(data.occurredAt);
      if (typeof data.offsetMs !== 'number' || !Number.isFinite(data.offsetMs) || data.offsetMs < 0) fail();
      const value = object(data.value);
      if (value.scope !== 'work' || !['call', 'return', 'throw'].includes(value.type as string)) fail();
      break;
    }
    case 'resource':
      for (const name of ['parentId', 'access', 'supplyId']) text(data[name]);
      integer(data.sequence, 1);
      time(data.occurredAt);
      if (!['bound', 'available', 'unavailable', 'started', 'returned', 'threw'].includes(data.phase as string)) fail();
      if (['started', 'returned', 'threw'].includes(data.phase as string)) text(data.interactionId);
      else if (data.interactionId !== undefined) fail();
      break;
    case 'transcript': {
      text(data.transcriptId);
      integer(data.revision, 1);
      time(data.occurredAt);
      const value = object(data.value);
      integer(value.start);
      integer(value.end);
      if (value.action === 'append') {
        if (value.end <= value.start) fail();
      } else if (value.action === 'segment') {
        integer(value.previousStart);
        if (value.previousStart >= value.start || value.start >= value.end) fail();
      } else fail();
      checkContentSource(data);
      break;
    }
    case 'memory': {
      text(data.memoryId);
      text(data.memoriesId);
      integer(data.sequence, 1);
      optionalText(data.operationId);
      checkContentSource(data);
      validateMemoryRecordValue(data.value);
      break;
    }
    case 'custom':
      if (Object.hasOwn(data, 'childIds')) children(data.childIds);
      break;
    default:
      fail();
  }
}

function checkContentSource(data: Fields): void {
  optionalText(data.callId);
  optionalText(data.contextId);
  optionalText(data.executionId);
  if ((data.callId === undefined) !== (data.contextId === undefined)) fail();
}
