import { hasOutput, outputProcess, readOutput } from '../records/invocation.js';
import type { RuntimeSnapshot, OperationRecord, OperationValue } from '../records.js';
import type { GenerationOutput } from '../operations/generation.js';
import type { CallSpan, ModelSettings, Trace } from '../types.js';

/** Reject inconsistent identities, ownership and boundary facts before projecting them. */
export function validateSnapshot(value: unknown): asserts value is RuntimeSnapshot {
  const fail = () => {
    throw new Error('运行记录格式无效或关联缺失。');
  };
  if (!value || typeof value !== 'object') return fail();
  const f = value as RuntimeSnapshot;
  if (!f.execution || typeof f.execution.id !== 'string' || !f.execution.id || !f.execution.value || typeof f.execution.value.startedAt !== 'string' || !Object.hasOwn(f.execution.value, 'settings') || !Array.isArray(f.operations) || !Array.isArray(f.attempts) || !Array.isArray(f.events)) return fail();
  const executionId = f.execution.id;
  const operations = new Map<string, OperationRecord>();
  const parents = new Map<string, string>();
  const statuses = new Map([[executionId, f.execution.status]]);
  const bodies = new Map<string, OperationValue>([[executionId, f.execution.value]]);
  const contextIds = new Set<string>();
  const acceptContextIdentity = (record: { id: string; contextId: string }) => {
    if (typeof record.contextId !== 'string' || !record.contextId || record.contextId === record.id || contextIds.has(record.contextId)) return fail();
    contextIds.add(record.contextId);
  };
  acceptContextIdentity(f.execution);
  const actors = ['caller', 'execution', 'operation', 'processing', 'provider'];
  for (const op of f.operations) {
    if (!op || typeof op.id !== 'string' || !op.id || bodies.has(op.id) || op.executionId !== executionId || typeof op.operationInstanceId !== 'string' || !op.operationInstanceId || typeof op.operation !== 'string' || typeof op.label !== 'string' || typeof op.source !== 'string' || !actors.includes(op.caller) || !actors.includes(op.callee) || (op.parentOperationId !== undefined && typeof op.parentOperationId !== 'string')) return fail();
    acceptContextIdentity(op);
    operations.set(op.id, op);
    parents.set(op.id, op.parentOperationId ?? executionId);
    statuses.set(op.id, op.status);
    bodies.set(op.id, op.value);
  }
  for (const attempt of f.attempts) {
    if (!attempt || typeof attempt.id !== 'string' || !attempt.id || bodies.has(attempt.id) || typeof attempt.operationId !== 'string' || !operations.has(attempt.operationId) || typeof attempt.name !== 'string' || !attempt.name.trim() || typeof attempt.label !== 'string' || !attempt.label.trim() || typeof attempt.source !== 'string' || !actors.includes(attempt.caller) || !actors.includes(attempt.callee)) return fail();
    acceptContextIdentity(attempt);
    parents.set(attempt.id, attempt.operationId);
    statuses.set(attempt.id, attempt.status);
    bodies.set(attempt.id, attempt.value);
  }
  for (const id of contextIds) if (bodies.has(id)) return fail();
  for (const status of statuses.values()) {
    if (!['running', 'succeeded', 'failed'].includes(status)) return fail();
  }
  for (const body of bodies.values()) {
    if (!body || !Array.isArray(body.processes) || typeof body !== 'object' || !Object.hasOwn(body, 'input') || (hasOutput(body) && Object.hasOwn(body, 'error')) || (Object.hasOwn(body, 'output') && Object.hasOwn(body, 'resultOf')) || (Object.hasOwn(body, 'error') && (!body.error || typeof body.error.code !== 'string' || typeof body.error.message !== 'string'))) return fail();
  }
  for (const body of bodies.values()) {
    let previousRound = 0,
      previousTime = 0;
    for (const [index, process] of body.processes.entries()) {
      if (!process || process.sequence !== index + 1 || !Number.isInteger(process.round) || process.round < previousRound || process.round > 2 || !Number.isFinite(process.offsetMs) || process.offsetMs < previousTime || typeof process.occurredAt !== 'string') return fail();
      const valid = process.stage === 'execute' ? ['start', 'return', 'throw'] : process.stage === 'receive' ? ['return', 'throw', 'continue'] : process.stage === 'control' ? ['stop'] : [];
      if (!valid.includes(process.type) || (process.round === 0 && process.stage !== 'control')) return fail();
      if ((process.type === 'start' || process.type === 'continue') && !Object.hasOwn(process, 'input')) return fail();
      if (process.type === 'return' && Object.hasOwn(process, 'output') === Object.hasOwn(process, 'resultOf')) return fail();
      if ('resultOf' in process) {
        try {
          const target = outputProcess(body, process.resultOf, process.sequence);
          if (process.stage !== 'receive' || target.stage !== 'execute' || target.round !== process.round || target.sequence !== process.sequence - 1) return fail();
        } catch {
          return fail();
        }
      }
      if ((process.type === 'throw' || process.type === 'stop') && (!process.error || typeof process.error.code !== 'string' || typeof process.error.message !== 'string')) return fail();
      if (process.type === 'continue' && (typeof process.reason !== 'string' || !process.reason.trim())) return fail();
      previousRound = process.round;
      previousTime = process.offsetMs;
    }
    if (Object.hasOwn(body, 'resultOf')) {
      try {
        readOutput(body);
      } catch {
        return fail();
      }
    }
  }
  for (const op of operations.values()) {
    if (op.parentOperationId !== undefined && !operations.has(op.parentOperationId)) return fail();
  }
  const active = new Set<string>(),
    entered = new Set<string>(),
    ended = new Set<string>();
  const eventIds = new Set<string>();
  let time = 0;
  for (const [i, event] of f.events.entries()) {
    if (!event || typeof event.id !== 'string' || !event.id || bodies.has(event.id) || contextIds.has(event.id) || eventIds.has(event.id) || event.executionId !== executionId || !event.value || !['call', 'return', 'throw'].includes(event.value.type) || typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt)) || !bodies.has(event.callId) || event.sequence !== i + 1 || !Number.isFinite(event.offsetMs) || event.offsetMs < time) return fail();
    eventIds.add(event.id);
    time = event.offsetMs;
    const parentId = parents.get(event.callId);
    if (event.value.type === 'call') {
      if (entered.has(event.callId) || (parentId !== undefined && (!active.has(executionId) || !active.has(parentId))) || (event.callId === executionId && i !== 0)) return fail();
      entered.add(event.callId);
      active.add(event.callId);
    } else {
      const body = bodies.get(event.callId)!;
      if (!['return', 'throw'].includes(event.value.type) || !active.has(event.callId) || [...active].some((id) => id !== event.callId && (event.callId === executionId || parents.get(id) === event.callId)) || !(event.value.type === 'return' ? hasOutput(body) : Object.hasOwn(body, 'error')) || statuses.get(event.callId) !== (event.value.type === 'return' ? 'succeeded' : 'failed')) return fail();
      active.delete(event.callId);
      ended.add(event.callId);
    }
  }
  if (entered.size !== bodies.size) return fail();
  for (const [id, body] of bodies) {
    if (!ended.has(id) && (statuses.get(id) !== 'running' || hasOutput(body) || Object.hasOwn(body, 'error'))) return fail();
  }
}

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
    source: 'src/server/execution/execution.ts · Execution.call',
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
