import type { CallInteractionLinks, InteractionObservation, InteractionUpdate } from '@capix/protocol';
import { RuntimeError } from '@capix/contracts';
import { RuntimeErrorHelper, type InteractionFact, type InteractionRead, type InteractionState } from '@capix/server-runtime';
import { CompositeRecord, ResourceRecord } from '@capix/records';
import { isPlainObject } from 'es-toolkit/predicate';
import type { ObserverEnvironment } from '../assembly/environment.js';
import type { ModelInteractionRequest } from '../conversation/model/interactions.js';
import type { ModelOutput } from '../conversation/model/types.js';

type InteractionEnvironment = Pick<ObserverEnvironment, 'persistence' | 'interactions'> & { readonly records: Pick<ObserverEnvironment['records'], 'source' | 'book'> };

/** The call grants access through its direct, recorded resource usage. No global ID guessing. */
export function callInteractionLinks(environment: InteractionEnvironment, callId: string): CallInteractionLinks {
  environment.records.source.assertComplete();
  const call = environment.records.book.get(callId);
  if (!(call instanceof CompositeRecord) || !['invocation', 'runtime-call', 'execution', 'operation', 'attempt'].includes(call.kind)) throw new RuntimeError('CALL_NOT_FOUND', '找不到指定对话中的调用。');
  const ids = new Set<string>();
  for (const childId of call.childIds) {
    const resource = environment.records.book.get(childId);
    if (!(resource instanceof ResourceRecord) || resource.parentId !== callId || !isPlainObject(resource.value)) continue;
    const value = resource.value;
    const ref = resource.access === 'model-interaction.create' && resource.phase === 'returned' && value.action === 'start' ? value.output : resource.access === 'model-interaction.read' && resource.phase === 'started' && (value.action === 'wait' || value.action === 'result' || value.action === 'subscribe') ? value.input : undefined;
    if (isPlainObject(ref) && typeof ref.id === 'string' && ref.id) ids.add(ref.id);
  }
  return { callId, interactionIds: [...ids] };
}

/** A cumulative metadata projection; it follows entity facts, never a call's completion status. */
export function observeCallInteraction(environment: InteractionEnvironment, callId: string, id: string, receive: (frame: InteractionUpdate) => void): () => void {
  if (!callInteractionLinks(environment, callId).interactionIds.includes(id)) throw new RuntimeError('INTERACTION_NOT_FOUND', '该调用未关联指定的外部交互。');
  const retained = environment.persistence ? 'persistent' : 'memory';
  let active = true;
  let scheduled = false;
  let pending: InteractionUpdate | undefined;
  const enqueue = (frame: InteractionUpdate) => {
    if (!active) return;
    pending = frame;
    if (scheduled) return;
    scheduled = true;
    // Cumulative snapshots can coalesce; socket writes never run inside entity mutation.
    queueMicrotask(() => {
      scheduled = false;
      const next = pending;
      pending = undefined;
      if (!active || !next) return;
      try {
        emit(next);
      } catch {
        close();
      }
    });
  };
  const observation = environment.interactions.observe(
    { id },
    {
      receive(fact) {
        enqueue({ type: 'snapshot', value: projectFact(fact, retained) });
      },
      failed() {
        enqueue({ type: 'error', code: 'INTERACTION_OBSERVATION_FAILED', error: '外部交互观测已中断。' });
      },
    },
  );
  function close() {
    active = false;
    pending = undefined;
    observation.close();
  }
  function emit(frame: InteractionUpdate) {
    if (frame.type === 'error' || frame.value.result.kind !== 'pending') close();
    receive(frame);
  }
  try {
    emit({ type: 'snapshot', value: projectState(observation.state, observation.result, retained) });
  } catch (error) {
    close();
    throw error;
  }
  return close;
}

function projectFact(fact: InteractionFact<ModelInteractionRequest, ModelOutput>, retained: InteractionObservation['retained']): InteractionObservation {
  const state = fact.state;
  const result: InteractionRead<ModelOutput> = fact.type === 'unavailable' ? { kind: 'unavailable', error: fact.error } : state.feedback ? { kind: 'received', feedback: state.feedback } : state.failure ? { kind: 'unavailable', error: state.failure } : { kind: 'pending' };
  return projectState(state, result, retained);
}

function projectState(state: InteractionState<ModelInteractionRequest, ModelOutput>, result: InteractionRead<ModelOutput>, retained: InteractionObservation['retained']): InteractionObservation {
  const diagnostic = result.kind === 'unavailable' ? RuntimeErrorHelper.format(result.error) : undefined;
  return {
    id: state.id,
    contract: state.contract,
    revision: state.revision,
    delivery: state.delivery,
    retained,
    model: state.request.request.model,
    purpose: state.request.purpose,
    result: result.kind === 'received' ? { kind: 'received', feedbackId: result.feedback.id } : diagnostic ? { kind: 'unavailable', error: { code: diagnostic.code, message: diagnostic.message } } : { kind: 'pending' },
  };
}
