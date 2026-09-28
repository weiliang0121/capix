import { readOutput, type ExecutionObservation, type GenerationOutput } from '@capix-observer/protocol';

import type { MemoryInput } from '../operations/memory/input.js';
import { type RecordBook, type Transcript, OperationRecord } from '@capix-observer/runtime';

import { observeSelection } from './selection.js';

/** Associate the answer by its actual operation, never by message adjacency or text matching. */
export function inspectExecutions(book: RecordBook, transcript: Transcript): ExecutionObservation {
  const selection = observeSelection(book, transcript);
  const executions: ExecutionObservation['executions'] = selection.executions.map((execution) => ({ ...execution }));
  const byId = new Map(executions.map((execution) => [execution.id, execution]));
  const operations = [...book.values()].filter((record): record is OperationRecord => record instanceof OperationRecord);
  for (const operation of operations) {
    const execution = byId.get(operation.executionId);
    if (!execution) continue;
    if (operation.operation === 'answer' && operation.status === 'succeeded') execution.response = { content: (readOutput(operation.value) as GenerationOutput).content };
    if (operation.operation === 'memory') execution.memoryStatus = operation.status;
  }
  for (const operation of operations) {
    if (operation.operation !== 'memory') continue;
    const execution = byId.get(operation.executionId);
    const input = operation.value.input as MemoryInput;
    // Extraction's recorded input already identifies the appended response message.
    if (execution?.response && input.currentIndexes[0] === execution.inputIndex) execution.response.index = input.currentIndexes[1];
  }
  return { messages: selection.messages, executions };
}
