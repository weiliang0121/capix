import { hasOutput, readOutput, validateSnapshot } from '@capix-observer/protocol';
import type { RuntimeSnapshot, OperationRecord, OperationValue, GenerationOutput, ModelSettings } from '@capix-observer/protocol';
import type { CallSpan, Trace } from './types.js';
export { validateSnapshot } from '@capix-observer/protocol';

/** Each view is derived from the same current-format facts. */
export function projectExecution(facts: RuntimeSnapshot): Trace {
  validateSnapshot(facts);
  const execution = facts.execution;
  const starts = new Map(facts.events.filter((e) => e.value.type === 'call').map((e) => [e.callId, e]));
  const ends = new Map(facts.events.filter((e) => e.value.type !== 'call').map((e) => [e.callId, e]));
  const result = (id: string, body: OperationValue, status: OperationRecord['status']) => {
    const start = starts.get(id)!,
      end = ends.get(id);
    return {
      status: status === 'succeeded' ? ('passed' as const) : status,
      offsetMs: start.offsetMs,
      ...(end ? { durationMs: end.offsetMs - start.offsetMs } : {}),
      input: body.input,
      processes: body.processes,
      ...(hasOutput(body) ? { output: readOutput(body) } : {}),
      ...(body.error ? { error: body.error } : {}),
    };
  };
  const root: CallSpan = {
    recordType: 'execution',
    contextId: execution.contextId,
    id: execution.id,
    executionId: execution.id,
    operation: 'execution',
    caller: 'caller',
    callee: 'execution',
    label: 'Execution.call',
    source: 'server/runtime/src/execution/execution.ts · Execution.call',
    ...result(execution.id, execution.value, execution.status),
  };
  const operations = new Map(facts.operations.map((operation) => [operation.id, operation]));
  const calls: CallSpan[] = [
    root,
    ...facts.operations.map((op) => ({
      recordType: 'operation' as const,
      contextId: op.contextId,
      id: op.id,
      executionId: op.executionId,
      operationInstanceId: op.operationInstanceId,
      operation: op.operation,
      parentId: op.parentOperationId ?? op.executionId,
      caller: op.parentOperationId ? ('operation' as const) : ('execution' as const),
      callee: 'operation' as const,
      label: op.label,
      source: op.source,
      ...result(op.id, op.value, op.status),
    })),
    ...facts.attempts.map((attempt) => {
      const owner = operations.get(attempt.operationId)!;
      return {
        recordType: 'attempt' as const,
        contextId: attempt.contextId,
        id: attempt.id,
        executionId: owner.executionId,
        operationInstanceId: owner.operationInstanceId,
        operation: `${owner.operation}.${attempt.name}`,
        parentId: owner.id,
        caller: 'operation' as const,
        callee: 'attempt' as const,
        target: attempt.callee,
        label: attempt.label,
        source: attempt.source,
        ...result(attempt.id, attempt.value, attempt.status),
      };
    }),
  ];
  calls.sort((a, b) => starts.get(a.id)!.sequence - starts.get(b.id)!.sequence);
  return {
    facts,
    id: execution.id,
    startedAt: execution.value.startedAt,
    durationMs: facts.events.at(-1)?.offsetMs ?? 0,
    status: execution.status,
    settings: execution.value.settings as ModelSettings,
    nodes: calls.map((call) => ({
      ...call,
      group: call.operation?.startsWith('selection') ? 'selection' : call.operation?.startsWith('answer') ? 'answer' : call.operation?.startsWith('memory') ? 'memory' : 'flow',
    })),
    callSequence: {
      version: 1,
      calls,
      events: facts.events,
      participants: [
        { id: 'caller', label: '调用方', description: '运行入口' },
        { id: 'execution', label: 'Execution', description: '操作的显式组合' },
        { id: 'operation', label: 'Operation', description: '具名动作的组合' },
        { id: 'attempt', label: 'Attempt', description: '具名动作的一次调用，本地处理或外部调用由动作自身实现' },
      ],
    },
    ...(root.status === 'passed' ? { result: root.output as GenerationOutput } : {}),
    ...(root.error ? { error: root.error } : {}),
  };
}
