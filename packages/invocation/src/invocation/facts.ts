import type { InvocationEvent } from '@weiliang0121/capix-protocol';
import type { InvocationFact } from '../observation/facts.js';
import { isInvocationCancelled } from './cancellation.js';
import { failureFact } from './failure.js';
import type { InvocationProgress } from './progress.js';

/** Project established facts without publishing, sequencing or changing their producer. */
export function invocationProgress(fact: InvocationFact, signal: AbortSignal): InvocationProgress {
  const description: { id?: string; name?: string; label?: string } = {};
  // Optional descriptions must not execute getters or break passive progress.
  try {
    if (fact.description) {
      for (const key of ['id', 'name', 'label'] as const) {
        const property = Object.getOwnPropertyDescriptor(fact.description, key);
        if (property && 'value' in property && typeof property.value === 'string') description[key] = property.value;
      }
    }
  } catch {
    // A hostile description cannot prevent publication of the underlying fact.
  }
  const identity = Object.freeze({ contextId: fact.identity.contextId, kind: fact.identity.kind, ...(fact.identity.parentContextId ? { parentContextId: fact.identity.parentContextId } : {}) });
  const base = { identity, eventSequence: fact.eventSequence, occurredAt: fact.occurredAt, ...(Object.keys(description).length ? { description: Object.freeze(description) } : {}) };
  if (fact.kind === 'started') return Object.freeze({ ...base, kind: 'started' });
  if (fact.kind === 'process') return Object.freeze({ ...base, kind: 'process', processSequence: fact.processSequence, round: fact.round, stage: fact.process.stage, action: fact.process.type });
  if (fact.kind === 'relation') {
    const relation = Object.freeze({ parentContextId: fact.relation.parentContextId, childContextId: fact.relation.childContextId, parentRound: fact.relation.parentRound, ...(fact.relation.key ? { key: fact.relation.key } : {}) });
    if (fact.change.kind !== 'returned') return Object.freeze({ ...base, kind: 'relation', relation, phase: fact.change.kind });
    const result = fact.change.result;
    const status = result.status === 'succeeded' ? 'succeeded' : isInvocationCancelled(result.error, signal) ? 'cancelled' : 'failed';
    return Object.freeze({ ...base, kind: 'relation', relation, phase: 'returned', status });
  }
  const state = fact.state;
  const status = state.status === 'succeeded' ? 'succeeded' : state.status === 'failed' && isInvocationCancelled(state.error, signal) ? 'cancelled' : 'failed';
  return Object.freeze({ ...base, kind: 'finished', status });
}

export function invocationChange(fact: InvocationFact): InvocationEvent['change'] {
  if (fact.kind === 'process') return { kind: 'process', processSequence: fact.processSequence, round: fact.round, stage: fact.process.stage, action: fact.process.type };
  if (fact.kind === 'relation') return { kind: 'relation', identity: fact.relation, phase: fact.change.kind, ...(fact.change.kind === 'returned' ? { status: fact.change.result.status, ...(fact.change.result.status === 'failed' && fact.change.result.failure ? { failure: failureFact(fact.change.result.failure) } : {}) } : {}) };
  if (fact.kind === 'finished') return { kind: 'finished', status: fact.state.status === 'succeeded' ? 'succeeded' : 'failed' };
  return { kind: 'started' };
}
