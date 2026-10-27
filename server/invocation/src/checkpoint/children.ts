import { isEqual } from 'es-toolkit';
import type { CheckpointChild, CheckpointHead, InvocationCheckpointFrame } from '@capix/checkpoint';
import { cloneCheckpointHead, cloneCheckpointValue } from '@capix/checkpoint';
import { checkpointTarget } from './target.js';
import type { CheckpointBinding } from './work.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationChildren, InvocationChildBaseline } from '../invocation/children.js';
import type { InvocationRelation, InvocationTarget } from '../invocation/relation.js';
import type { InvocationReceptionBinding } from '../invocation/reception.js';
import { RuntimeErrorHelper } from '@capix/diagnostics';
import { checkpointReceptionBinding, decodeCheckpointDiagnostic, decodeCheckpointReception, decodeCheckpointHandledReception } from './facts.js';
import { failureFact } from '../invocation/failure.js';
import { InvocationCancelled } from '../invocation/cancellation.js';

/** Interpret saved evidence only; installing a target and its relationship belongs to the parent call. */
export function resolveCheckpointChild(saved: CheckpointChild, value?: CheckpointHead): { readonly kind: 'continuation' } | { readonly kind: 'delivery'; readonly child: CheckpointChild } {
  if (saved.state.kind === 'failed') throw new Error('Historical failed child cannot be resumed');
  if (saved.state.kind === 'returned' && saved.state.reception.kind === 'failed') throw new Error('Historical failed child reception cannot be resumed');
  if (saved.state.kind !== 'waiting') return { kind: 'delivery', child: saved };
  if (!value) throw new Error('Waiting child has no durable continuation; execution is unknown');
  const head = cloneCheckpointHead(value);
  if (!isEqual(head.image.frame.owner, saved.identity) || !isEqual(head.image.frame.input, saved.input) || !isEqual(head.image.contract, saved.contract)) throw new Error('Child checkpoint differs from parent-owned identity');
  if (!head.delivery) return { kind: 'continuation' };
  if (head.delivery.status !== 'succeeded') throw new Error('Failed or cancelled child cannot be resumed');
  return { kind: 'delivery', child: { ...saved, state: { kind: 'returned', output: head.delivery.output, progress: head.delivery.progress, reception: { kind: 'pending' } } } };
}

/** Decode once: both the target and its relation retain the same delivered value. */
export function decodeCheckpointChild(child: CheckpointChild, binding: CheckpointBinding | undefined, signal: AbortSignal, receptions: readonly InvocationReceptionBinding[] = []): InvocationChildBaseline {
  const receptionBinding = checkpointReceptionBinding(child, receptions);
  const target = checkpointTarget(child, binding, signal);
  const identity = { target, round: child.round, order: child.order, key: child.key, declarationPosition: child.target.position };
  const state = target.context.state;
  if (child.state.kind === 'waiting') return { ...identity, state: { reception: { status: 'pending' } } };
  if (child.state.kind === 'failed') {
    const returned = { status: 'failed' as const, error: child.state.error, diagnostic: decodeCheckpointDiagnostic(child.state.error), failure: Object.freeze({ ...child.state.failure, error: child.state.error }) };
    const handled = decodeCheckpointHandledReception(child, receptionBinding);
    const reception = handled ? { status: 'handled' as const, output: handled.output, ...(receptionBinding ? { contract: receptionBinding } : {}) } : { status: 'pending' as const };
    return { ...identity, state: { returned, reception } };
  }
  if (state.status !== 'succeeded') throw new Error('Saved delivery did not produce a successful target');
  const returned = { status: 'succeeded' as const, output: state.output };
  const savedReception = decodeCheckpointReception(child, receptionBinding);
  const contract = receptionBinding ? { contract: receptionBinding } : {};
  const reception = savedReception.kind === 'accepted' ? { status: 'accepted' as const, output: savedReception.output, ...contract } : savedReception.kind === 'failed' ? { status: 'failed' as const, error: savedReception.error, diagnostic: decodeCheckpointDiagnostic(savedReception.error), failure: Object.freeze({ ...savedReception.failure, error: savedReception.error }), ...contract } : { status: savedReception.kind, ...contract };
  return { ...identity, state: { returned, reception } };
}

/** Checkpoint policy and encoding do not belong to the live relationship collection. */
export function captureCheckpointChildren(context: InvocationContext, relations: InvocationChildren, savedChildren: ReadonlyMap<string, CheckpointChild>): Pick<InvocationCheckpointFrame, 'nextChildOrder' | 'children'> {
  return { nextChildOrder: relations.nextOrder, children: relations.values().map((relation) => captureCheckpointChild(context, relation, savedChildren.get(relation.invocation.context.id))) };
}

function captureCheckpointChild(context: InvocationContext, relation: InvocationRelation, saved?: CheckpointChild): CheckpointChild {
  const target = relation.invocation;
  const binding = target.checkpointBinding;
  const identity = target.identity;
  if (!identity) throw new Error('Checkpoint child has no explicit callable identity');
  const position = relation.declarationPosition ?? saved?.target.position;
  if (position === undefined) throw new Error('Checkpoint child has no fixed declaration position');
  const base = { identity, target: { position }, ...(binding ? { contract: { key: binding.key, version: binding.version } } : saved?.contract ? { contract: saved.contract } : {}), round: relation.round, order: relation.order, ...(relation.key ? { key: relation.key } : {}), input: binding ? cloneCheckpointValue(binding.input.encode(target.context.input)) : saved ? saved.input : cloneCheckpointValue(target.context.input) };
  if (!relation.returned) {
    if (!base.contract) throw new Error('Waiting child has no checkpoint declaration');
    return { ...base, state: { kind: 'waiting' } };
  }
  if (relation.returned.status === 'failed') {
    const failure = relation.returned.failure;
    const reception = relation.reception;
    if (reception.status === 'handled') {
      if (!failure || !failure.contextId || !['execute', 'receive', 'handling'].includes(failure.phase) || relation.returned.error instanceof InvocationCancelled) throw new Error('Only a completed non-cancelled business-stage failure can have checkpointed handling');
      if (reception.contract && reception.contract.childPosition !== position) throw new Error('Checkpoint handling targets a different child declaration');
      const output = reception.contract ? { output: cloneCheckpointValue(reception.contract.codec.encode(reception.output)) } : reception.output !== undefined ? { output: cloneCheckpointValue(reception.output) } : {};
      return { ...base, state: { kind: 'failed', error: saved?.state.kind === 'failed' ? saved.state.error : cloneCheckpointValue(RuntimeErrorHelper.format(relation.returned.error)), failure: failureFact(failure), progress: captureChildProgress(target), reception: { kind: 'handled', ...(reception.contract ? { contract: { position: reception.contract.position } } : {}), ...output } } };
    }
    if (relation.round >= context.progress.round || failure?.kind !== 'exception' || !failure.contract || failure.contextId !== target.context.id) throw new Error('Only a prior round declared child exception can be checkpointed as history');
    if (saved?.state.kind === 'failed') return { ...base, state: saved.state };
    return { ...base, state: { kind: 'failed', error: cloneCheckpointValue(RuntimeErrorHelper.format(relation.returned.error)), failure: { kind: 'exception', phase: failure.phase, contextId: failure.contextId, contract: failure.contract }, progress: captureChildProgress(target) } };
  }
  const output = binding ? cloneCheckpointValue(binding.output.encode(relation.returned.output)) : cloneCheckpointValue(relation.returned.output);
  const reception = relation.reception;
  if (reception.status === 'handled') throw new Error('A successful child cannot have a handled failure reception');
  const receptionContract = reception.status !== 'pending' && reception.contract ? { contract: { position: reception.contract.position } } : {};
  if (reception.status !== 'pending' && reception.contract && reception.contract.childPosition !== position) throw new Error('Checkpoint reception targets a different child declaration');
  if (reception.status === 'failed') {
    const failure = reception.failure;
    const continuation = context.continuation;
    const origin = continuation?.origin;
    if (context.progress.round !== 2 || relation.round !== 1 || continuation?.stage !== 'handling' || origin?.kind !== 'child-reception' || origin.child.parentContextId !== context.id || origin.child.childContextId !== identity.contextId || origin.child.parentRound !== relation.round || origin.child.order !== relation.order || failure?.kind !== 'exception' || !failure.contract || failure.contextId !== context.id || failure.phase === 'handling') throw new Error('Only the prior handled declared reception exception can be checkpointed as history');
    if (saved?.state.kind === 'returned' && saved.state.reception.kind === 'failed') return { ...base, state: { kind: 'returned', output, progress: captureChildProgress(target), reception: saved.state.reception } };
    return { ...base, state: { kind: 'returned', output, progress: captureChildProgress(target), reception: { kind: 'failed', ...receptionContract, error: cloneCheckpointValue(RuntimeErrorHelper.format(reception.error)), failure: { kind: 'exception', phase: failure.phase, contextId: failure.contextId, contract: failure.contract } } } };
  }
  return { ...base, state: { kind: 'returned', output, progress: captureChildProgress(target), reception: reception.status === 'accepted' ? { kind: 'accepted', ...receptionContract, ...(reception.contract ? { output: cloneCheckpointValue(reception.contract.codec.encode(reception.output)) } : reception.output !== undefined ? { output: cloneCheckpointValue(reception.output) } : {}) } : { kind: reception.status, ...receptionContract } } };
}

function captureChildProgress(target: InvocationTarget) {
  const context = target.context;
  const currentInput = target.checkpointBinding ? target.checkpointBinding.input.encode(context.currentInput) : context.currentInput;
  return { round: context.progress.round, phase: context.progress.phase, currentInput: cloneCheckpointValue(currentInput) };
}
