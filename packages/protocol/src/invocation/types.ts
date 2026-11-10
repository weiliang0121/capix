export { callableKinds, type CallableKind } from '@weiliang0121/capix-contracts';
/** Read-only vocabulary of historical REOA records. */
export type LegacyInvocationLevel = 'runtime' | 'execution' | 'operation' | 'attempt';
export const invocationProcessStages = ['execute', 'receive', 'handling', 'control'] as const;
export const invocationProcessActions = ['start', 'return', 'throw', 'continue', 'unhandled', 'stop'] as const;
export type InvocationProcessStage = (typeof invocationProcessStages)[number];
export type InvocationProcessAction = (typeof invocationProcessActions)[number];

export interface InvocationRelationIdentity {
  readonly parentContextId: string;
  readonly childContextId: string;
  readonly parentRound: number;
  readonly key?: string;
}
export type InvocationRelationPhase = 'attached' | 'returned' | 'receiving' | 'accepted' | 'handled' | 'failed';

/** Identity of the call that caused an entity change, at any REOA level. */
export interface InvocationOrigin {
  readonly contextId: string;
}
