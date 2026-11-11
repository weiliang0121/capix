import type { CallableKind, InvocationFailureFact, InvocationRelationIdentity } from '@weiliang0121/capix-contracts';

export const invocationProcessStages = ['execute', 'receive', 'handling', 'control'] as const;
export const invocationProcessActions = ['start', 'return', 'throw', 'continue', 'unhandled', 'stop'] as const;
export type InvocationProcessStage = (typeof invocationProcessStages)[number];
export type InvocationProcessAction = (typeof invocationProcessActions)[number];
export type InvocationRelationPhase = 'attached' | 'returned' | 'receiving' | 'accepted' | 'handled' | 'failed';

/** Live call progress metadata, independent of recording or arbitrary IO serialization. */
export type InvocationEvent = Readonly<{ type: 'invocation'; contextId: string; parentContextId?: string; kind: CallableKind; sequence: number; occurredAt: string; change: Readonly<{ kind: 'started' }> | Readonly<{ kind: 'process'; processSequence: number; round: number; stage: InvocationProcessStage; action: InvocationProcessAction }> | Readonly<{ kind: 'relation'; identity: InvocationRelationIdentity; phase: InvocationRelationPhase; status?: 'succeeded' | 'failed'; failure?: InvocationFailureFact }> | Readonly<{ kind: 'finished'; status: 'succeeded' | 'failed' }> }>;
