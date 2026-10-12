import { validateRecordingArchiveOrigin } from '../observer/archive.js';
import { hasOutput, outputProcess, readOutput } from './invocation.js';
import type { ExecutionRecordSnapshot, OperationRecord, InvocationValue, RelationChangeRecord, InvocationBoundaryRecord } from './types.js';

/** Reject inconsistent identities, ownership and boundary facts before projecting them. */
export function validateExecutionRecordSnapshot(value: unknown): asserts value is ExecutionRecordSnapshot {
  const fail = () => {
    throw new Error('运行记录格式无效或关联缺失。');
  };
  if (!value || typeof value !== 'object') return fail();
  const snapshot = value as ExecutionRecordSnapshot;
  if (snapshot.archive !== undefined) validateRecordingArchiveOrigin(snapshot.archive);
  const historical = snapshot.archive !== undefined;
  if (!snapshot.execution || typeof snapshot.execution.id !== 'string' || !snapshot.execution.id || !snapshot.execution.value || typeof snapshot.execution.value.startedAt !== 'string' || !Array.isArray(snapshot.operations) || !Array.isArray(snapshot.attempts) || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.resources)) return fail();
  const executionId = snapshot.execution.id;
  const operations = new Map<string, OperationRecord>();
  const parents = new Map<string, string>();
  const statuses = new Map([[executionId, snapshot.execution.status]]);
  const bodies = new Map<string, InvocationValue>([[executionId, snapshot.execution.value]]);
  const contextIds = new Set<string>();
  const acceptContextIdentity = (record: { id: string; contextId: string }) => {
    if (typeof record.contextId !== 'string' || !record.contextId || record.contextId === record.id || contextIds.has(record.contextId)) return fail();
    contextIds.add(record.contextId);
  };
  acceptContextIdentity(snapshot.execution);
  const runtimeCall = snapshot.runtimeCall;
  if (!runtimeCall || typeof runtimeCall.id !== 'string' || !runtimeCall.id || runtimeCall.id === executionId || typeof runtimeCall.runtimeInstanceId !== 'string' || !runtimeCall.runtimeInstanceId || !runtimeCall.value || typeof runtimeCall.value.startedAt !== 'string' || snapshot.execution.parentId !== runtimeCall.id || !['running', 'succeeded', 'failed'].includes(runtimeCall.status)) return fail();
  acceptContextIdentity(runtimeCall);

  // Participants describe declared capabilities; record identities establish ownership below.
  const validParticipant = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  for (const operationRecord of snapshot.operations) {
    if (!operationRecord || typeof operationRecord.id !== 'string' || !operationRecord.id || bodies.has(operationRecord.id) || operationRecord.executionId !== executionId || typeof operationRecord.operationInstanceId !== 'string' || !operationRecord.operationInstanceId || typeof operationRecord.operation !== 'string' || typeof operationRecord.label !== 'string' || typeof operationRecord.source !== 'string' || !validParticipant(operationRecord.caller) || !validParticipant(operationRecord.callee) || (operationRecord.parentOperationId !== undefined && typeof operationRecord.parentOperationId !== 'string')) return fail();
    acceptContextIdentity(operationRecord);
    operations.set(operationRecord.id, operationRecord);
    parents.set(operationRecord.id, operationRecord.parentOperationId ?? executionId);
    statuses.set(operationRecord.id, operationRecord.status);
    bodies.set(operationRecord.id, operationRecord.value);
  }
  for (const attemptRecord of snapshot.attempts) {
    if (!attemptRecord || typeof attemptRecord.id !== 'string' || !attemptRecord.id || bodies.has(attemptRecord.id) || typeof attemptRecord.operationId !== 'string' || !operations.has(attemptRecord.operationId) || typeof attemptRecord.name !== 'string' || !attemptRecord.name.trim() || typeof attemptRecord.label !== 'string' || !attemptRecord.label.trim() || typeof attemptRecord.source !== 'string' || !validParticipant(attemptRecord.caller) || !validParticipant(attemptRecord.callee)) return fail();
    acceptContextIdentity(attemptRecord);
    parents.set(attemptRecord.id, attemptRecord.operationId);
    statuses.set(attemptRecord.id, attemptRecord.status);
    bodies.set(attemptRecord.id, attemptRecord.value);
  }
  if (bodies.has(runtimeCall.id)) return fail();
  const observedBodies = new Map(bodies);
  observedBodies.set(runtimeCall.id, runtimeCall.value);
  for (const id of contextIds) if (observedBodies.has(id)) return fail();
  for (const status of statuses.values()) {
    if (!['running', 'succeeded', 'failed'].includes(status)) return fail();
  }
  for (const [owner, body] of observedBodies) {
    const ownerContextId = owner === runtimeCall.id ? runtimeCall.contextId : owner === snapshot.execution.id ? snapshot.execution.contextId : (snapshot.operations.find((record) => record.id === owner)?.contextId ?? snapshot.attempts.find((record) => record.id === owner)?.contextId);
    validateInvocationRecordValue(body, ownerContextId!);
  }
  for (const operationRecord of operations.values()) {
    if (operationRecord.parentOperationId !== undefined && !operations.has(operationRecord.parentOperationId)) return fail();
  }
  for (const id of parents.keys()) {
    const visited = new Set<string>([id]);
    let ancestor = parents.get(id);
    while (ancestor && ancestor !== executionId) {
      if (visited.has(ancestor)) return fail();
      visited.add(ancestor);
      ancestor = parents.get(ancestor);
    }
  }
  const active = new Set<string>();
  const entered = new Set<string>();
  const ended = new Set<string>();
  const boundaryIds = new Set<string>();
  let time = 0;
  for (const [i, boundary] of snapshot.events.entries()) {
    if (!boundary || typeof boundary.id !== 'string' || !boundary.id || bodies.has(boundary.id) || contextIds.has(boundary.id) || boundaryIds.has(boundary.id) || boundary.executionId !== executionId || boundary.scopeId !== executionId || !boundary.value || boundary.value.scope !== 'work' || !['call', 'return', 'throw'].includes(boundary.value.type) || typeof boundary.occurredAt !== 'string' || !Number.isFinite(Date.parse(boundary.occurredAt)) || !bodies.has(boundary.callId) || boundary.sequence !== i + 1 || !Number.isFinite(boundary.offsetMs) || boundary.offsetMs < time) return fail();
    boundaryIds.add(boundary.id);
    time = boundary.offsetMs;
    const parentId = parents.get(boundary.callId);
    if (boundary.value.type === 'call') {
      if (entered.has(boundary.callId) || (parentId !== undefined && (!active.has(executionId) || !active.has(parentId))) || (boundary.callId === executionId && i !== 0)) return fail();
      entered.add(boundary.callId);
      active.add(boundary.callId);
    } else {
      const body = bodies.get(boundary.callId)!;
      if (!['return', 'throw'].includes(boundary.value.type) || !active.has(boundary.callId) || [...active].some((id) => id !== boundary.callId && (boundary.callId === executionId || parents.get(id) === boundary.callId)) || !(boundary.value.type === 'return' ? hasOutput(body) : Object.hasOwn(body, 'error')) || statuses.get(boundary.callId) !== (boundary.value.type === 'return' ? 'succeeded' : 'failed')) return fail();
      active.delete(boundary.callId);
      ended.add(boundary.callId);
    }
  }
  if (!historical && entered.size !== bodies.size) return fail();
  for (const [id, body] of bodies) {
    if (!historical && !ended.has(id) && (statuses.get(id) !== 'running' || hasOutput(body) || Object.hasOwn(body, 'error'))) return fail();
    if (historical && !validRecordedStatus(statuses.get(id)!, body)) return fail();
  }
  if (!Array.isArray(snapshot.runtimeEvents) || !validRuntimeCallBoundaries(snapshot.runtimeEvents, runtimeCall.id, runtimeCall.status, runtimeCall.value, historical)) return fail();
  for (const boundary of snapshot.runtimeEvents) {
    if (boundaryIds.has(boundary.id) || observedBodies.has(boundary.id) || contextIds.has(boundary.id)) return fail();
    boundaryIds.add(boundary.id);
  }
  const resourceIds = new Set<string>();
  const resourceSequences = new Map<string, number>();
  const accesses = new Map<string, string>();
  const interactions = new Map<string, string>();
  for (const resourceRecord of snapshot.resources) {
    if (!resourceRecord || typeof resourceRecord.id !== 'string' || !resourceRecord.id || bodies.has(resourceRecord.id) || contextIds.has(resourceRecord.id) || boundaryIds.has(resourceRecord.id) || resourceIds.has(resourceRecord.id) || typeof resourceRecord.parentId !== 'string' || !observedBodies.has(resourceRecord.parentId) || typeof resourceRecord.access !== 'string' || !resourceRecord.access || typeof resourceRecord.supplyId !== 'string' || !resourceRecord.supplyId || typeof resourceRecord.occurredAt !== 'string' || !Number.isFinite(Date.parse(resourceRecord.occurredAt)) || !Object.hasOwn(resourceRecord, 'value')) return fail();
    if (resourceRecord.sequence !== (resourceSequences.get(resourceRecord.parentId) ?? 0) + 1) return fail();
    resourceSequences.set(resourceRecord.parentId, resourceRecord.sequence);
    resourceIds.add(resourceRecord.id);
    const accessKey = JSON.stringify([resourceRecord.parentId, resourceRecord.supplyId, resourceRecord.access]);
    if (resourceRecord.phase === 'bound') {
      if (accesses.has(accessKey) || resourceRecord.interactionId !== undefined) return fail();
      accesses.set(accessKey, 'bound');
    } else if (resourceRecord.phase === 'available' || resourceRecord.phase === 'unavailable') {
      if (accesses.get(accessKey) !== 'bound' || resourceRecord.interactionId !== undefined) return fail();
      accesses.set(accessKey, resourceRecord.phase);
    } else if (resourceRecord.phase === 'started') {
      if (accesses.get(accessKey) !== 'available' || typeof resourceRecord.interactionId !== 'string' || !resourceRecord.interactionId || interactions.has(resourceRecord.interactionId)) return fail();
      interactions.set(resourceRecord.interactionId, accessKey);
    } else if (resourceRecord.phase === 'returned' || resourceRecord.phase === 'threw') {
      if (typeof resourceRecord.interactionId !== 'string' || interactions.get(resourceRecord.interactionId) !== accessKey) return fail();
      interactions.delete(resourceRecord.interactionId);
    } else return fail();
  }
}

function validFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const failure = value as Record<string, unknown>;
  return (failure.kind === 'exception' || failure.kind === 'error') && typeof failure.contextId === 'string' && failure.contextId.length > 0 && ['setup', 'execute', 'receive', 'handling', 'control', 'observation'].includes(failure.phase as string) && (failure.contract === undefined || typeof failure.contract === 'string');
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
function validRuntimeCallBoundaries(boundaries: readonly InvocationBoundaryRecord[], id: string, status: string, value: InvocationValue, historical = false): boolean {
  if ((!historical && boundaries.length < 1) || boundaries.length > 2) return false;
  for (const [index, boundary] of boundaries.entries()) {
    if (!boundary || !boundary.id || boundary.scopeId !== id || boundary.executionId !== undefined || boundary.callId !== id || boundary.parentId !== id || boundary.sequence !== index + 1 || !Number.isFinite(boundary.offsetMs) || boundary.offsetMs < (boundaries[index - 1]?.offsetMs ?? 0) || !Number.isFinite(Date.parse(boundary.occurredAt)) || boundary.value?.scope !== 'work' || boundary.value.type !== (index === 0 ? 'call' : status === 'succeeded' ? 'return' : 'throw')) return false;
  }
  if (historical && boundaries.length < 2) return validRecordedStatus(status, value);
  return status === 'running' ? boundaries.length === 1 : boundaries.length === 2 && (status === 'succeeded' ? hasOutput(value) : Object.hasOwn(value, 'error'));
}

/** Validate one invocation body independently of its separately published boundaries. */
export function validateInvocationRecordValue(value: unknown, ownerContextId: string): asserts value is InvocationValue {
  const fail = () => {
    throw new Error('调用记录正文无效。');
  };
  const body = value as InvocationValue;
  if (!body || !Array.isArray(body.processes) || !Array.isArray(body.relationChanges) || typeof body !== 'object' || !Object.hasOwn(body, 'input') || (hasOutput(body) && Object.hasOwn(body, 'error')) || (Object.hasOwn(body, 'output') && Object.hasOwn(body, 'resultOf')) || (Object.hasOwn(body, 'error') && (!body.error || typeof body.error.code !== 'string' || typeof body.error.message !== 'string'))) return fail();
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
  if (!validRelations(body, ownerContextId)) return fail();
  if (Object.hasOwn(body, 'resultOf')) {
    try {
      readOutput(body);
    } catch {
      return fail();
    }
  }
}

function validRecordedStatus(status: string, body: InvocationValue): boolean {
  return status === 'running' ? !hasOutput(body) && !Object.hasOwn(body, 'error') : status === 'succeeded' ? hasOutput(body) && !Object.hasOwn(body, 'error') : status === 'failed' && Object.hasOwn(body, 'error') && !hasOutput(body);
}
