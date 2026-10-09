import { hasOutput, outputProcess, readOutput } from './invocation.js';
import type { RuntimeSnapshot, OperationRecord, InvocationValue, RelationChangeRecord, InvocationBoundaryRecord } from '../records.js';

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
  const runtimeCall = f.runtimeCall;
  if (!runtimeCall || typeof runtimeCall.id !== 'string' || !runtimeCall.id || runtimeCall.id === executionId || typeof runtimeCall.runtimeInstanceId !== 'string' || !runtimeCall.runtimeInstanceId || !runtimeCall.value || typeof runtimeCall.value.startedAt !== 'string' || f.execution.parentId !== runtimeCall.id || !['running', 'succeeded', 'failed'].includes(runtimeCall.status)) return fail();
  acceptContextIdentity(runtimeCall);

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
  if (bodies.has(runtimeCall.id)) return fail();
  const observedBodies = new Map(bodies);
  observedBodies.set(runtimeCall.id, runtimeCall.value);
  for (const id of contextIds) if (observedBodies.has(id)) return fail();
  for (const status of statuses.values()) {
    if (!['running', 'succeeded', 'failed'].includes(status)) return fail();
  }
  for (const body of observedBodies.values()) {
    if (!body || !Array.isArray(body.processes) || !Array.isArray(body.relationChanges) || typeof body !== 'object' || !Object.hasOwn(body, 'input') || (hasOutput(body) && Object.hasOwn(body, 'error')) || (Object.hasOwn(body, 'output') && Object.hasOwn(body, 'resultOf')) || (Object.hasOwn(body, 'error') && (!body.error || typeof body.error.code !== 'string' || typeof body.error.message !== 'string'))) return fail();
  }
  for (const body of observedBodies.values()) {
    if (body.failure && (!Object.hasOwn(body, 'error') || !validFailure(body.failure))) return fail();
    let previousRound = 0;
    let previousTime = 0;
    let previousSequence = 0;
    for (const [index, process] of body.processes.entries()) {
      if (!process || !Number.isSafeInteger(process.eventSequence) || process.eventSequence <= previousSequence || process.sequence !== index + 1 || !Number.isInteger(process.round) || process.round < previousRound || process.round > 2 || !Number.isFinite(process.offsetMs) || process.offsetMs < previousTime || typeof process.occurredAt !== 'string') return fail();
      const valid = process.stage === 'execute' ? ['start', 'return', 'throw'] : process.stage === 'receive' ? ['return', 'throw', 'continue'] : process.stage === 'handling' ? ['start', 'return', 'throw', 'continue', 'unhandled'] : process.stage === 'control' ? ['stop'] : [];
      if (!valid.includes(process.type) || (process.round === 0 && process.stage !== 'control')) return fail();
      if (((process.stage === 'execute' && process.type === 'start') || process.type === 'continue') && !Object.hasOwn(process, 'input')) return fail();
      if (process.type === 'return' && Object.hasOwn(process, 'output') === Object.hasOwn(process, 'resultOf')) return fail();
      if ('resultOf' in process) {
        try {
          const target = outputProcess(body, process.resultOf, process.sequence);
          if (process.stage !== 'receive' || target.stage !== 'execute' || target.round !== process.round || target.sequence !== process.sequence - 1) return fail();
        } catch {
          return fail();
        }
      }
      if ((process.type === 'throw' || process.type === 'stop' || (process.stage === 'handling' && (process.type === 'start' || process.type === 'unhandled'))) && (!process.error || typeof process.error.code !== 'string' || typeof process.error.message !== 'string')) return fail();
      if (process.type === 'continue' && (typeof process.reason !== 'string' || !process.reason.trim())) return fail();
      if ('failure' in process && process.failure && !validFailure(process.failure)) return fail();
      previousRound = process.round;
      previousTime = process.offsetMs;
      previousSequence = process.eventSequence;
    }
    const owner = [...observedBodies].find(([, value]) => value === body)?.[0];
    const ownerContextId = owner === runtimeCall.id ? runtimeCall.contextId : owner === f.execution.id ? f.execution.contextId : (f.operations.find((record) => record.id === owner)?.contextId ?? f.attempts.find((record) => record.id === owner)?.contextId);
    if (!validRelations(body, ownerContextId)) return fail();
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
    if (!event || typeof event.id !== 'string' || !event.id || bodies.has(event.id) || contextIds.has(event.id) || eventIds.has(event.id) || event.executionId !== executionId || event.scopeId !== executionId || !event.value || event.value.scope !== 'work' || !['call', 'return', 'throw'].includes(event.value.type) || typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt)) || !bodies.has(event.callId) || event.sequence !== i + 1 || !Number.isFinite(event.offsetMs) || event.offsetMs < time) return fail();
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
  if (!Array.isArray(f.runtimeEvents) || !validRuntimeBoundaries(f.runtimeEvents, runtimeCall.id, runtimeCall.status, runtimeCall.value)) return fail();
  for (const event of f.runtimeEvents) {
    if (eventIds.has(event.id) || observedBodies.has(event.id) || contextIds.has(event.id)) return fail();
    eventIds.add(event.id);
  }
  const resourceIds = new Set<string>();
  const resourceSequences = new Map<string, number>();
  const accesses = new Map<string, string>();
  const interactions = new Map<string, string>();
  for (const fact of f.resources) {
    if (!fact || typeof fact.id !== 'string' || !fact.id || bodies.has(fact.id) || contextIds.has(fact.id) || eventIds.has(fact.id) || resourceIds.has(fact.id) || typeof fact.parentId !== 'string' || !observedBodies.has(fact.parentId) || typeof fact.access !== 'string' || !fact.access || typeof fact.supplyId !== 'string' || !fact.supplyId || typeof fact.occurredAt !== 'string' || !Number.isFinite(Date.parse(fact.occurredAt)) || !Object.hasOwn(fact, 'value')) return fail();
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

function validFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  return (f.kind === 'exception' || f.kind === 'error') && typeof f.contextId === 'string' && f.contextId.length > 0 && ['setup', 'execute', 'receive', 'handling', 'control', 'observation'].includes(f.phase as string) && (f.contract === undefined || typeof f.contract === 'string');
}

/** Relation states are parent facts, not inferred from child work status. */
function validRelations(body: InvocationValue, ownerContextId: string | undefined): boolean {
  const relations = new Map<string, { identity: RelationChangeRecord['identity']; phase: string; status?: string }>();
  const eventSequences = new Set(body.processes.map((process) => process.eventSequence));
  let previous = 0;
  for (const entry of body.relationChanges) {
    if (!entry || !Number.isSafeInteger(entry.eventSequence) || entry.eventSequence <= previous || eventSequences.has(entry.eventSequence) || !Number.isFinite(entry.offsetMs) || entry.offsetMs < 0 || typeof entry.occurredAt !== 'string' || !Number.isFinite(Date.parse(entry.occurredAt)) || !entry.identity || !entry.change) return false;
    const identity = entry.identity;
    if (identity.parentContextId !== ownerContextId || typeof identity.childContextId !== 'string' || !identity.childContextId || identity.childContextId === ownerContextId || !Number.isSafeInteger(identity.parentRound) || identity.parentRound < 0 || identity.parentRound > 2 || (identity.key !== undefined && typeof identity.key !== 'string') || (entry.childId !== undefined && (typeof entry.childId !== 'string' || !entry.childId))) return false;
    const old = relations.get(identity.childContextId);
    if (old && (old.identity.parentRound !== identity.parentRound || old.identity.key !== identity.key)) return false;
    const change = entry.change;
    if (change.kind === 'attached') {
      if (old) return false;
      relations.set(identity.childContextId, { identity, phase: 'attached' });
    } else if (change.kind === 'returned') {
      if (old?.phase !== 'attached' || !change.result || !['succeeded', 'failed'].includes(change.result.status)) return false;
      if (change.result.status === 'succeeded' ? !Object.hasOwn(change.result, 'output') : !validError(change.result.error) || (change.result.failure !== undefined && !validFailure(change.result.failure))) return false;
      relations.set(identity.childContextId, { identity, phase: 'returned', status: change.result.status });
    } else if (change.kind === 'receiving') {
      if (old?.phase !== 'returned' || old.status !== 'succeeded') return false;
      relations.set(identity.childContextId, { ...old, phase: 'receiving' });
    } else if (change.kind === 'accepted') {
      if (old?.phase !== 'receiving' || !Object.hasOwn(change, 'output')) return false;
      relations.set(identity.childContextId, { ...old, phase: 'accepted' });
    } else if (change.kind === 'failed') {
      if (old?.phase !== 'receiving' || !validError(change.error) || !['work', 'observation'].includes(change.source) || (change.failure !== undefined && !validFailure(change.failure))) return false;
      relations.set(identity.childContextId, { ...old, phase: 'failed' });
    } else return false;
    eventSequences.add(entry.eventSequence);
    previous = entry.eventSequence;
  }
  const times = [...body.processes, ...body.relationChanges].sort((a, b) => a.eventSequence - b.eventSequence);
  return times.every((entry, index) => index === 0 || entry.offsetMs >= times[index - 1]!.offsetMs);
}
function validError(value: unknown): boolean {
  return !!value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string' && typeof (value as { message?: unknown }).message === 'string';
}
function validRuntimeBoundaries(events: readonly InvocationBoundaryRecord[], id: string, status: string, value: InvocationValue): boolean {
  if (events.length < 1 || events.length > 2) return false;
  for (const [index, event] of events.entries()) {
    if (!event || !event.id || event.scopeId !== id || event.executionId !== undefined || event.callId !== id || event.parentId !== id || event.sequence !== index + 1 || !Number.isFinite(event.offsetMs) || event.offsetMs < (events[index - 1]?.offsetMs ?? 0) || !Number.isFinite(Date.parse(event.occurredAt)) || event.value?.scope !== 'work' || event.value.type !== (index === 0 ? 'call' : status === 'succeeded' ? 'return' : 'throw')) return false;
  }
  return status === 'running' ? events.length === 1 : events.length === 2 && (status === 'succeeded' ? hasOutput(value) : Object.hasOwn(value, 'error'));
}
