import { sortBy } from 'es-toolkit/array';
import { isFinite } from 'es-toolkit/compat';
import type { InvocationBoundaryValue } from '@capix/protocol';
import type { Recorder } from '../../recorder.js';
import type { RecordBook } from '../../book.js';
import { ExecutionRecord } from '../../execution/record.js';
import { RuntimeCallRecord } from '../../runtime/record.js';
import { InvocationRecord } from '../record.js';
import { InvocationBoundaryRecord } from './record.js';

/** An R invocation record owns its timing range; an E record subtree shares a separate range. */
export class InvocationBoundaryRecordHelper {
  static create(recorder: Recorder, location: { start: number; scopeId?: string; executionId?: string; callId: string; occurredAt?: string; offsetMs?: number }, type: InvocationBoundaryValue['type']): InvocationBoundaryRecord {
    const scopeId = location.scopeId ?? location.executionId ?? location.callId;
    const timingRecord = recorder.book.get(scopeId);
    if (!(timingRecord instanceof ExecutionRecord || timingRecord instanceof RuntimeCallRecord)) throw new Error('Invocation timing scope does not exist');
    const invocationRecord = recorder.book.get(location.callId);
    if (!(invocationRecord instanceof InvocationRecord) || (invocationRecord !== timingRecord && !recorder.tree.descendants(timingRecord.id).includes(invocationRecord))) throw new Error('Boundary target is outside its timing scope');
    const expectedStatus = type === 'call' ? 'running' : type === 'return' ? 'succeeded' : 'failed';
    if (invocationRecord.status !== expectedStatus) throw new Error('Boundary does not match the invocation work state');
    const previous = this.last(recorder, scopeId);
    const offsetMs = location.offsetMs ?? recorder.clock.tick() - location.start;
    if (!isFinite(offsetMs) || offsetMs < (previous?.offsetMs ?? 0)) throw new Error('Invalid invocation boundary time');
    const record = new InvocationBoundaryRecord({ scopeId, ...(timingRecord instanceof ExecutionRecord ? { executionId: timingRecord.id } : {}), callId: invocationRecord.id, sequence: (previous?.sequence ?? 0) + 1, occurredAt: location.occurredAt ?? recorder.clock.now(), offsetMs }, { type });
    return recorder.add(record);
  }

  static get(book: RecordBook, id: string): InvocationBoundaryRecord {
    const record = book.get(id);
    if (!(record instanceof InvocationBoundaryRecord)) throw new Error('Invocation boundary record does not exist');
    return record;
  }

  static findByExecution(recorder: Recorder, executionId: string): readonly InvocationBoundaryRecord[] {
    if (!(recorder.book.get(executionId) instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    return this.findByScope(recorder, executionId);
  }

  static findByScope(recorder: Recorder, scopeId: string): readonly InvocationBoundaryRecord[] {
    const timingRecord = recorder.book.get(scopeId);
    if (!(timingRecord instanceof ExecutionRecord || timingRecord instanceof RuntimeCallRecord)) throw new Error('Invocation timing scope does not exist');
    return sortBy(
      recorder.tree.descendants(scopeId).filter((record): record is InvocationBoundaryRecord => record instanceof InvocationBoundaryRecord && record.scopeId === scopeId),
      [(boundary) => boundary.sequence],
    );
  }

  static last(recorder: Recorder, scopeId: string): InvocationBoundaryRecord | undefined {
    return this.findByScope(recorder, scopeId).at(-1);
  }
}
