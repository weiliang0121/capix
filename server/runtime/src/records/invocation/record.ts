import type { RuntimeCallRecord } from '../runtime-call/record.js';
import type { ExecutionRecord } from '../execution/record.js';
import type { OperationRecord } from '../operation/record.js';
import type { AttemptRecord } from '../attempt/record.js';
import { type InvocationValue, type ProcessRecord, type RelationChangeRecord, type RuntimeErrorValue, type InvocationFailureFact, outputProcess, finalOutputProcess } from '@capix/protocol';

import { CompositeRecord } from '../composite.js';

import { isUndefined } from 'es-toolkit/predicate';
import { snapshotValue } from '../value/snapshot.js';

export type ConcreteInvocationRecord = RuntimeCallRecord | ExecutionRecord | OperationRecord | AttemptRecord;

/** R/E/O/A share result registration and an internal append-only process history. */
export class InvocationRecord<Value extends InvocationValue> extends CompositeRecord<Value> {
  #status: 'running' | 'succeeded' | 'failed' = 'running';
  get status() {
    return this.#status;
  }

  protected requireRunning(): void {
    if (this.#status !== 'running') throw new Error('Record has already ended');
  }

  append(process: ProcessRecord): void {
    this.requireRunning();
    if (process.sequence !== this.value.processes.length + 1) throw new Error('Process sequence must advance in order');
    if ('resultOf' in process) {
      if (Object.hasOwn(process, 'output')) throw new Error('Output and local result reference are mutually exclusive');
      const target = outputProcess(this.value, process.resultOf, process.sequence);
      if (process.stage !== 'receive' || target.stage !== 'execute' || target.round !== process.round || target.sequence !== process.sequence - 1) throw new Error('Receive may only reuse its own execution result');
    }
    const captured = snapshotValue(process);
    this.replaceValue(Object.freeze({ ...this.value, processes: Object.freeze([...this.value.processes, captured]) }));
  }

  appendRelation(relation: RelationChangeRecord): void {
    this.requireRunning();
    if (!Number.isSafeInteger(relation.eventSequence) || relation.eventSequence < 1) throw new Error('Relation fact requires an event sequence');
    const last = this.value.relationChanges.at(-1);
    if (last && relation.eventSequence <= last.eventSequence) throw new Error('Relation fact sequence must advance');
    const captured = snapshotValue(relation);
    this.replaceValue(Object.freeze({ ...this.value, relationChanges: Object.freeze([...this.value.relationChanges, captured]) }));
  }

  complete(output: unknown, resultOf?: number): void {
    this.requireRunning();
    if (isUndefined(resultOf)) this.replaceValue(Object.freeze({ ...this.value, output: snapshotValue(output) }));
    else {
      finalOutputProcess(this.value, resultOf);
      this.replaceValue(Object.freeze({ ...this.value, resultOf }));
    }
    this.#status = 'succeeded';
  }

  fail(error: RuntimeErrorValue, failure?: InvocationFailureFact): void {
    this.requireRunning();
    this.replaceValue(Object.freeze({ ...this.value, error: snapshotValue(error), ...(failure ? { failure: snapshotValue(failure) } : {}) }));
    this.#status = 'failed';
  }
}
