import type { InvocationIdentity } from '@weiliang0121/capix-contracts';
import type { CheckpointChild } from '@weiliang0121/capix-checkpoint';
import { RuntimeErrorHelper } from '@weiliang0121/capix-diagnostics';
import { invocationProgress, type InvocationFact, type InvocationProgress, type ResourceObservation, type ResourceFact, type BusinessObservation, type CheckpointFact } from '@weiliang0121/capix-invocation';
import type { RunnerDiagnostic, RunnerResourceFact, RunnerFact, RunnerBusinessFact, RunnerCheckpointChild, RunnerCheckpointFact } from './observation-contract.js';

/** Projection must happen during synchronous observation, while borrowed fields are valid. */
export function projectInvocation(fact: InvocationFact, signal: AbortSignal): InvocationProgress {
  return invocationProgress(fact, signal);
}

export function projectResource(fact: ResourceObservation): RunnerResourceFact {
  return Object.freeze({ contextId: fact.contextId, offerId: fact.offerId, access: fact.access, supplyId: fact.supplyId, sequence: fact.sequence, occurredAt: fact.occurredAt, phase: fact.phase, ...(fact.interactionId !== undefined ? { interactionId: fact.interactionId } : {}) });
}

export function projectFact(fact: ResourceFact): RunnerFact {
  return Object.freeze({ contextId: fact.contextId, offerId: fact.offerId, access: fact.access, supplyId: fact.supplyId, operationId: fact.operationId, sequence: fact.sequence, occurredAt: fact.occurredAt, ...(fact.fact.name !== undefined ? { name: fact.fact.name } : {}) });
}

export function projectBusiness(fact: BusinessObservation): RunnerBusinessFact {
  return Object.freeze({ identity: projectIdentity(fact.identity), sequence: fact.sequence, occurredAt: fact.occurredAt, event: fact.event.event });
}

export function projectDiagnostic(error: unknown): RunnerDiagnostic {
  try {
    const diagnostic = RuntimeErrorHelper.format(error);
    return Object.freeze({ code: diagnostic.code.slice(0, 128), message: diagnostic.message.slice(0, 512) });
  } catch {
    return Object.freeze({ code: 'OBSERVATION_DIAGNOSTIC_FAILED', message: 'The failure could not be described.' });
  }
}

export function projectCheckpoint(fact: CheckpointFact, signal: AbortSignal): RunnerCheckpointFact {
  const base = { activityId: fact.activityId, contextId: fact.contextId, owner: projectIdentity(fact.owner), recovering: fact.recovering, sequence: fact.sequence, occurredAt: fact.occurredAt };
  switch (fact.kind) {
    case 'captured':
    case 'saved':
    case 'checking':
    case 'continued':
      return Object.freeze({ ...base, kind: fact.kind, checkpointId: fact.checkpointId, point: fact.point });
    case 'installed':
      return Object.freeze({ ...base, kind: fact.kind, checkpointId: fact.checkpointId, point: fact.point, baseline: Object.freeze({ round: fact.frame.round, nextChildOrder: fact.frame.nextChildOrder, childCount: fact.frame.children.length }) });
    case 'child-restored':
      return Object.freeze({ ...base, kind: fact.kind, child: projectChild(fact.child), mode: fact.mode });
    case 'activity':
      return Object.freeze({ ...base, kind: fact.kind, fact: projectInvocation(fact.fact, signal) });
    case 'resource':
      return Object.freeze({ ...base, kind: fact.kind, fact: projectResource(fact.fact) });
    case 'fact':
      return Object.freeze({ ...base, kind: fact.kind, fact: projectFact(fact.fact) });
    case 'failed':
      return Object.freeze({ ...base, kind: fact.kind, stage: fact.stage, diagnostic: projectDiagnostic(fact.error), ...(fact.childContextId !== undefined ? { childContextId: fact.childContextId } : {}) });
    case 'finishing':
    case 'finished':
      return Object.freeze({ ...base, kind: fact.kind, status: fact.status });
  }
}

function projectIdentity(identity: InvocationIdentity): InvocationIdentity {
  return Object.freeze({ contextId: identity.contextId, kind: identity.kind, ...(identity.parentContextId !== undefined ? { parentContextId: identity.parentContextId } : {}) });
}

function projectChild(child: CheckpointChild): RunnerCheckpointChild {
  const base = { identity: projectIdentity(child.identity), round: child.round, order: child.order, ...(child.key !== undefined ? { key: child.key } : {}) };
  if (child.state.kind === 'waiting') return Object.freeze({ ...base, state: child.state.kind });
  if (child.state.kind === 'returned') return Object.freeze({ ...base, state: child.state.kind, reception: child.state.reception.kind });
  return Object.freeze({ ...base, state: child.state.kind, ...(child.state.reception ? { reception: child.state.reception.kind } : {}) });
}
