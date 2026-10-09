/** Fixed runtime vocabulary; independent of any observation carrier. */
export const invocationLevels = ['runtime', 'execution', 'operation', 'attempt'] as const;
export type InvocationLevel = (typeof invocationLevels)[number];
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
export type InvocationRelationPhase = 'attached' | 'returned' | 'receiving' | 'accepted' | 'failed';
