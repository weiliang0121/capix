import { hasOutput, outputProcess, readOutput } from './invocation.js';
import type { RuntimeSnapshot, OperationRecord, InvocationValue } from '../records.js';

/** Reject inconsistent identities, ownership and boundary facts before projecting them. */
export function validateSnapshot(value: unknown): asserts value is RuntimeSnapshot {
  const fail = () => {
    throw new Error('运行记录格式无效或关联缺失。');
  };
  if (!value || typeof value !== 'object') return fail();
  const f = value as RuntimeSnapshot;
  if (!f.execution || typeof f.execution.id !== 'string' || !f.execution.id || !f.execution.value || typeof f.execution.value.startedAt !== 'string' || !Array.isArray(f.operations) || !Array.isArray(f.attempts) || !Array.isArray(f.events) || !Array.isArray(f.resources)) return fail();
  const executionId = f.execution.id;
  const operations = new Map<string, OperationRecord>();
  const parents = new Map<string, string>();
  const statuses = new Map([[executionId, f.execution.status]]);
  const bodies = new Map<string, InvocationValue>([[executionId, f.execution.value]]);
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
    let previousRound = 0;
    let previousTime = 0;
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
  const active = new Set<string>();
  const entered = new Set<string>();
  const ended = new Set<string>();
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
  const resourceIds = new Set<string>();
  const resourceSequences = new Map<string, number>();
  const accesses = new Map<string, string>();
  const interactions = new Map<string, string>();
  for (const fact of f.resources) {
    if (!fact || typeof fact.id !== 'string' || !fact.id || bodies.has(fact.id) || contextIds.has(fact.id) || eventIds.has(fact.id) || resourceIds.has(fact.id) || typeof fact.parentId !== 'string' || !bodies.has(fact.parentId) || typeof fact.access !== 'string' || !fact.access || typeof fact.supplyId !== 'string' || !fact.supplyId || typeof fact.occurredAt !== 'string' || !Number.isFinite(Date.parse(fact.occurredAt)) || !Object.hasOwn(fact, 'value')) return fail();
    if (fact.sequence !== (resourceSequences.get(fact.parentId) ?? 0) + 1) return fail();
    resourceSequences.set(fact.parentId, fact.sequence);
    resourceIds.add(fact.id);
    const accessKey = JSON.stringify([fact.parentId, fact.supplyId, fact.access]);
    if (fact.phase === 'bound') {
      if (accesses.has(accessKey) || fact.interactionId !== undefined) return fail();
      accesses.set(accessKey, 'bound');
    } else if (fact.phase === 'available' || fact.phase === 'unavailable') {
      if (accesses.get(accessKey) !== 'bound' || fact.interactionId !== undefined) return fail();
      accesses.set(accessKey, fact.phase);
    } else if (fact.phase === 'started') {
      if (accesses.get(accessKey) !== 'available' || typeof fact.interactionId !== 'string' || !fact.interactionId || interactions.has(fact.interactionId)) return fail();
      interactions.set(fact.interactionId, accessKey);
    } else if (fact.phase === 'returned' || fact.phase === 'threw') {
      if (typeof fact.interactionId !== 'string' || interactions.get(fact.interactionId) !== accessKey) return fail();
      interactions.delete(fact.interactionId);
    } else return fail();
  }
}
