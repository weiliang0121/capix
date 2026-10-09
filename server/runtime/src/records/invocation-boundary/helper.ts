import { sortBy } from 'es-toolkit/array';
import { isFinite } from 'es-toolkit/compat';
import type { InvocationBoundaryValue } from '@capix-observer/protocol';
import type { Recorder } from '../recorder.js';
import type { RecordBook } from '../container/book.js';
import { ExecutionRecord } from '../execution/record.js';
import { RuntimeCallRecord } from '../runtime-call/record.js';
import { InvocationRecord } from '../invocation/record.js';
import { InvocationBoundaryRecord } from './record.js';

/** R owns its timing range; an E subtree owns a separate range for its child calls. */
export class InvocationBoundaryRecordHelper {
  static create(recorder: Recorder, location: { start: number; scopeId?: string; executionId?: string; callId: string; occurredAt?: string; offsetMs?: number }, type: InvocationBoundaryValue['type']): InvocationBoundaryRecord {
    const scopeId = location.scopeId ?? location.executionId ?? location.callId;
    const scope = recorder.book.get(scopeId);
    if (!(scope instanceof ExecutionRecord || scope instanceof RuntimeCallRecord)) throw new Error('Invocation timing scope does not exist');
    const call = recorder.book.get(location.callId);
    if (!(call instanceof InvocationRecord) || (call !== scope && !recorder.tree.descendants(scope.id).includes(call))) throw new Error('Boundary target is outside its timing scope');
    const expectedStatus = type === 'call' ? 'running' : type === 'return' ? 'succeeded' : 'failed';
    if (call.status !== expectedStatus) throw new Error('Boundary does not match the invocation work state');
    const previous = this.last(recorder, scopeId);
    const offsetMs = location.offsetMs ?? recorder.clock.tick() - location.start;
    if (!isFinite(offsetMs) || offsetMs < (previous?.offsetMs ?? 0)) throw new Error('Invalid event time');
    const record = new InvocationBoundaryRecord({ scopeId, ...(scope instanceof ExecutionRecord ? { executionId: scope.id } : {}), callId: call.id, sequence: (previous?.sequence ?? 0) + 1, occurredAt: location.occurredAt ?? recorder.clock.now(), offsetMs }, { type });
    return recorder.add(record);
  }

  static get(book: RecordBook, id: string): InvocationBoundaryRecord {
    const record = book.get(id);
    if (!(record instanceof InvocationBoundaryRecord)) throw new Error('Event record does not exist');
    return record;
  }

  static findByExecution(recorder: Recorder, executionId: string): readonly InvocationBoundaryRecord[] {
    if (!(recorder.book.get(executionId) instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    return this.findByScope(recorder, executionId);
  }

  static findByScope(recorder: Recorder, scopeId: string): readonly InvocationBoundaryRecord[] {
    const scope = recorder.book.get(scopeId);
    if (!(scope instanceof ExecutionRecord || scope instanceof RuntimeCallRecord)) throw new Error('Invocation timing scope does not exist');
    return sortBy(
      recorder.tree.descendants(scopeId).filter((record): record is InvocationBoundaryRecord => record instanceof InvocationBoundaryRecord && record.scopeId === scopeId),
      [(event) => event.sequence],
    );
  }

  static last(recorder: Recorder, scopeId: string): InvocationBoundaryRecord | undefined {
    return this.findByScope(recorder, scopeId).at(-1);
  }
}
