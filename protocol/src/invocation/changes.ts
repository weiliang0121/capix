import type { InvocationFailureFact } from './errors.js';
import type { CallableKind, InvocationProcessStage, InvocationProcessAction, InvocationRelationIdentity, InvocationRelationPhase } from './types.js';

/** Live call progress metadata, independent of recording or arbitrary IO serialization. */
export type InvocationEvent = Readonly<{ type: 'invocation'; contextId: string; parentContextId?: string; kind: CallableKind; sequence: number; occurredAt: string; change: Readonly<{ kind: 'started' }> | Readonly<{ kind: 'process'; processSequence: number; round: number; stage: InvocationProcessStage; action: InvocationProcessAction }> | Readonly<{ kind: 'relation'; identity: InvocationRelationIdentity; phase: InvocationRelationPhase; status?: 'succeeded' | 'failed'; failure?: InvocationFailureFact }> | Readonly<{ kind: 'finished'; status: 'succeeded' | 'failed' }> }>;
