import { isEqual } from 'es-toolkit/predicate';
import type { RecordEntry, RecordingRootRecord as RootData, RuntimeCallRecord as RuntimeData, ExecutionRecord as ExecutionData, OperationRecord as OperationData, AttemptRecord as AttemptData, InvocationBoundaryRecord as BoundaryData, TranscriptRecord as TranscriptData, MemoryRecord as MemoryData, ResourceRecord as ResourceData, CompositeRecord as CompositeData } from '@capix/protocol';
import { BaseRecord } from '../record.js';
import { CompositeRecord } from '../composite.js';
import { InvocationRecord } from '../invocation/record.js';
import { RecordingRootRecord } from '../root/record.js';
import { RuntimeCallRecord } from '../runtime-call/record.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord } from '../operation/record.js';
import { AttemptRecord } from '../attempt/record.js';
import { InvocationBoundaryRecord } from '../invocation-boundary/record.js';
import { TranscriptRecord } from '../transcript/record.js';
import { MemoryRecord } from '../memory/record.js';
import { ResourceRecord } from '../resource/record.js';
import { replaceChildren } from '../tree/access.js';
import { restoreContent, restoreStatus } from './access.js';
import { checkEntry } from './check.js';

class HistoricalCustomRecord extends BaseRecord<unknown> {}
class HistoricalCompositeRecord extends CompositeRecord<unknown> {}

/** Hydrates checked plain data into the existing concrete carrier, without lifecycle operations. */
export function restoreEntry(entry: RecordEntry): BaseRecord<unknown> {
  checkEntry(entry);
  const record = construct(entry);
  record[restoreContent](entry.data.id, entry.data.value);
  if (record instanceof CompositeRecord) record[replaceChildren]((entry.data as CompositeData).childIds);
  if (record instanceof InvocationRecord) record[restoreStatus]((entry.data as RuntimeData).status);
  // Reject discarded fields or a constructor-derived ownership that disagrees with storage.
  if (!isEqual(record.toJSON(), entry.data)) throw new Error('Stored record does not match its declared kind');
  return record;
}

function construct(entry: RecordEntry): BaseRecord<unknown> {
  switch (entry.kind) {
    case 'runtime': {
      const data = entry.data as RootData;
      return new RecordingRootRecord(data.value);
    }
    case 'runtime-call': {
      const data = entry.data as RuntimeData;
      return new RuntimeCallRecord(data.contextId, data.runtimeInstanceId, data.value, data.parentId!);
    }
    case 'execution': {
      const data = entry.data as ExecutionData;
      return new ExecutionRecord(data.contextId, data.value, data.parentId!);
    }
    case 'operation': {
      const data = entry.data as OperationData;
      return new OperationRecord(data, data.value.input);
    }
    case 'attempt': {
      const data = entry.data as AttemptData;
      return new AttemptRecord(data, data.value.input);
    }
    case 'invocation-boundary': {
      const data = entry.data as BoundaryData;
      return new InvocationBoundaryRecord(data, data.value);
    }
    case 'transcript': {
      const data = entry.data as TranscriptData;
      return new TranscriptRecord({ ...data, source: data.callId ? { callId: data.callId, contextId: data.contextId!, executionId: data.executionId } : undefined }, data.value);
    }
    case 'memory': {
      const data = entry.data as MemoryData;
      return new MemoryRecord({ ...data, source: data.callId ? { callId: data.callId, contextId: data.contextId!, executionId: data.executionId, operationId: data.operationId } : undefined }, data.value);
    }
    case 'resource': {
      const data = entry.data as ResourceData;
      return new ResourceRecord(data, data.value);
    }
    case 'custom':
      return Object.hasOwn(entry.data, 'childIds') ? new HistoricalCompositeRecord(entry.data.value, entry.data.parentId) : new HistoricalCustomRecord(entry.data.value, entry.data.parentId);
  }
}
