import { readOutput, type ObserverOverview, type RuntimeSnapshot } from '@capix-observer/protocol';
import { isNumber, isPlainObject, isString } from 'es-toolkit/predicate';
import { isArray } from 'es-toolkit/compat';
import { projectExecution } from './project.js';

function object(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}
/** Live snapshots are projected locally; list loading never fetches all detail records. */
export function updateOverview(previous: ObserverOverview, snapshot: RuntimeSnapshot): ObserverOverview {
  const trace = projectExecution(snapshot);
  const existing = previous.executions.find((item) => item.id === trace.id);
  const observedOffsetMs = Math.max(trace.durationMs, ...[snapshot.execution, ...snapshot.operations, ...snapshot.attempts].map((record) => record.value.processes.at(-1)?.offsetMs ?? 0));
  const durationMs = trace.callSequence.calls.find((call) => call.recordType === 'execution')?.durationMs;
  const range = object(snapshot.execution.value.transcriptRange);
  const input = object(snapshot.execution.value.input);
  const inputIndex = isNumber(range.end) ? range.end - 1 : previous.messages.length;
  const selections = snapshot.operations.filter((operation) => operation.operation === 'selection');
  const response = snapshot.operations.find((operation) => operation.operation === 'answer' && operation.status === 'succeeded');
  const responseValue = response ? object(readOutput(response.value)) : {};
  const memoryInput = object(selections[0]?.value.input).memories;
  const item: ObserverOverview['executions'][number] = {
    id: trace.id,
    startedAt: trace.startedAt,
    status: trace.status,
    observedOffsetMs,
    ...(durationMs === undefined ? {} : { durationMs }),
    inputIndex,
    calls: trace.callSequence.calls.map((call) => ({ id: call.id, contextId: call.contextId, recordType: call.recordType, parentId: call.parentId, name: snapshot.attempts.find((attempt) => attempt.id === call.id)?.name ?? call.operation ?? 'execution', label: call.label, source: call.source, status: call.status === 'passed' ? 'succeeded' : call.status, offsetMs: call.offsetMs, ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }) })),
    selections: selections.map((operation) => {
      const indexes = operation.status === 'succeeded' ? object(readOutput(operation.value)).historyIndexes : undefined;
      return { operationId: operation.id, status: operation.status, ...(isArray(indexes) && indexes.every(isNumber) ? { indexes } : {}) };
    }),
    availableMemoryIds: isArray(memoryInput) ? memoryInput.map((memory) => object(memory).id).filter(isString) : [],
    memoryChanges: existing?.memoryChanges ?? [],
    ...(isNumber(range.start) && isNumber(range.end) ? { transcriptRange: { start: range.start, end: range.end } } : {}),
    ...(isString(responseValue.content) ? { response: { content: responseValue.content, ...(existing?.response?.index === undefined ? {} : { index: existing.response.index }) } } : {}),
    ...(snapshot.operations.find((operation) => operation.operation === 'memory') ? { memoryStatus: snapshot.operations.find((operation) => operation.operation === 'memory')!.status } : {}),
  };
  const executions = existing ? previous.executions.map((value) => (value.id === item.id ? item : value)) : [...previous.executions, item];
  const messages = [...previous.messages];
  if (!messages.some((message) => message.index === inputIndex) && isString(input.content) && (input.role === 'user' || input.role === 'assistant')) messages.push({ index: inputIndex, message: { role: input.role, content: input.content }, count: 0 });
  return { executions, messages: messages.map((message) => ({ ...message, count: executions.reduce((count, execution) => count + execution.selections.filter((selection) => selection.indexes?.includes(message.index)).length, 0) })) };
}
