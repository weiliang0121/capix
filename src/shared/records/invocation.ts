import type { OperationValue, ProcessRecord } from '../records.js';

type OutputProcess = Extract<ProcessRecord, { type: 'return'; output: unknown }>;

/** Resolve only a direct, local reference to an already captured output. No reference chains. */
export function outputProcess(value: Pick<OperationValue, 'processes'>, sequence: number, before = value.processes.length + 1): OutputProcess {
  const process = value.processes[sequence - 1];
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= before || !process || process.sequence !== sequence || process.type !== 'return' || !Object.hasOwn(process, 'output') || Object.hasOwn(process, 'resultOf')) throw new Error('Invalid local result reference');
  return process as OutputProcess;
}

export function hasOutput(value: OperationValue): boolean {
  return Object.hasOwn(value, 'output') || Object.hasOwn(value, 'resultOf');
}

/** The terminal result must be the last accepted result, never an earlier round. */
export function finalOutputProcess(value: Pick<OperationValue, 'processes'>, sequence: number): OutputProcess {
  const last = value.processes.at(-1);
  if (!last || last.stage !== 'receive' || last.type !== 'return' || sequence !== ('resultOf' in last ? last.resultOf : last.sequence)) throw new Error('Final result must reference the last accepted output');
  return outputProcess(value, sequence);
}

/** A projection reads the frozen payload on demand; serialized records remain compact. */
export function readOutput<I, O>(value: OperationValue<I, O>): O | undefined {
  if (Object.hasOwn(value, 'resultOf')) {
    if (Object.hasOwn(value, 'output')) throw new Error('Output and local result reference are mutually exclusive');
    return finalOutputProcess(value, value.resultOf!).output as O;
  }
  return value.output;
}
