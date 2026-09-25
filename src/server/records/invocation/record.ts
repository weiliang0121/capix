import type { OperationValue, ProcessRecord } from '../../../shared/records.js';
import type { RuntimeErrorValue } from '../../../shared/errors.js';
import { RuntimeRecord } from '../record.js';
import { outputProcess, finalOutputProcess } from '../../../shared/records/invocation.js';
import { isUndefined } from 'es-toolkit/predicate';
import { snapshotValue } from '../value/snapshot.js';

/** E/O/A share result registration and an internal append-only process history. */
export class InvocationRecord<V extends OperationValue> extends RuntimeRecord<V> {
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

  complete(output: unknown, resultOf?: number): void {
    this.requireRunning();
    if (isUndefined(resultOf)) this.replaceValue(Object.freeze({ ...this.value, output: snapshotValue(output) }));
    else {
      finalOutputProcess(this.value, resultOf);
      this.replaceValue(Object.freeze({ ...this.value, resultOf }));
    }
    this.#status = 'succeeded';
  }

  fail(error: RuntimeErrorValue): void {
    this.requireRunning();
    this.replaceValue(Object.freeze({ ...this.value, error: snapshotValue(error) }));
    this.#status = 'failed';
  }
}
