import type { InvocationExceptionOrigin } from '../invocation/provenance.js';
import type { CheckpointChild, CheckpointContinuation, InvocationCheckpointFrame } from '@capix/checkpoint';
import { checkpointReference, checkpointReferenceChild } from '@capix/checkpoint';

/** Inert transition metadata for decoding historical checkpoint frames. */
export interface CheckpointContinuationFact {
  readonly fromRound: 1;
  readonly stage: 'accept' | 'handling';
  readonly reason: string;
  readonly origin?: InvocationExceptionOrigin;
}

/** Historical metadata is preserved, never used to drive current business execution. */
export function captureCheckpointContinuation(continuation: CheckpointContinuationFact | undefined, children: readonly CheckpointChild[]): CheckpointContinuation | undefined {
  if (!continuation) return undefined;
  const { origin, ...accepted } = continuation;
  if (!origin || origin.kind === 'self') return Object.freeze({ ...accepted, ...(origin ? { origin } : {}) });
  const child = children.find((child) => child.identity.contextId === origin.child.childContextId);
  if (!child || child.identity.parentContextId !== origin.child.parentContextId || child.round !== origin.child.parentRound || child.order !== origin.child.order) throw new Error('Continuation source is not the saved direct child relationship');
  return Object.freeze({ ...continuation, origin: Object.freeze({ kind: origin.kind, child: checkpointReference(child) }) });
}

/** Wire references are verified against the complete frame before installation. */
export function restoreCheckpointContinuation(frame: InvocationCheckpointFrame): CheckpointContinuationFact | undefined {
  const continuation = frame.continuation;
  if (!continuation) return undefined;
  const { origin, ...accepted } = continuation;
  if (!origin || origin.kind === 'self') return Object.freeze({ ...accepted, ...(origin ? { origin } : {}) });
  const child = checkpointReferenceChild(origin.child, frame.children);
  return Object.freeze({ ...continuation, origin: Object.freeze({ kind: origin.kind, child: Object.freeze({ parentContextId: frame.owner.contextId, childContextId: child.identity.contextId, parentRound: child.round, order: child.order }) }) });
}
