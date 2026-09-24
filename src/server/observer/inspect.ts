import type { ExecutionObservation } from '../../shared/observation/execution.js';
import type { GenerationOutput } from '../../shared/operations/generation.js';
import type { MemoryInput } from '../operations/memory/input.js';
import type { ObserverExecution } from './execution.js';
import type { RecordBook } from '../records/container/book.js';
import type { Transcript } from '../transcript/transcript.js';
import { OperationRecord } from '../records/operation/record.js';
import { observeSelection } from './selection.js';

/** Associate the answer by its actual operation, never by message adjacency or text matching. */
export function inspectExecutions(book: RecordBook, transcript: Transcript, instance: ObserverExecution): ExecutionObservation {
  const selection = observeSelection(book, transcript, instance.selection.id);
  const executions: ExecutionObservation['executions'] = selection.executions.map((execution) => ({ ...execution }));
  const byId = new Map(executions.map((execution) => [execution.id, execution]));
  const operations = [...book.values()].filter((record): record is OperationRecord => record instanceof OperationRecord);
  for (const operation of operations) {
    const execution = byId.get(operation.executionId);
    if (!execution) continue;
    if (operation.operationInstanceId === instance.generation.id && operation.status === 'succeeded') execution.response = { content: (operation.value.output as GenerationOutput).content };
    if (operation.operationInstanceId === instance.extraction.id) execution.memoryStatus = operation.status;
  }
  for (const operation of operations) {
    if (operation.operationInstanceId !== instance.extraction.id) continue;
    const execution = byId.get(operation.executionId);
    const input = operation.value.input as MemoryInput;
    // Extraction's recorded input already identifies the appended response message.
    if (execution?.response && input.currentIndexes[0] === execution.inputIndex) execution.response.index = input.currentIndexes[1];
  }
  return { messages: selection.messages, executions };
}
