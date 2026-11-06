import type { ModelRequest } from '@capix/model-provider';
import type { ToolRegistrations } from './registration.js';
import type { ToolByteBudgets } from './budget.js';
export type { ToolByteBudgets } from './budget.js';

export interface ToolLoopOptions {
  readonly tools: ToolRegistrations;
  /** Versions input refinements, result mappings and precheck policy. Function identity is not persisted. */
  readonly policyVersion: string;
  readonly checkpoint?: boolean;
  readonly maxModelCalls?: number;
  readonly waitMs?: number;
  readonly budgets?: Partial<ToolByteBudgets>;
}
export type ToolBaseRequest = Pick<ModelRequest, 'messages' | 'maxTokens' | 'temperature'>;
export interface ToolLoopInput {
  readonly scope: string;
  /** Optional exact collection identity; required by the submission-scoped host. */
  readonly collection?: string;
  readonly request: ToolBaseRequest;
  readonly catalog: string;
  readonly maxModelCalls: number;
  readonly waitMs: number;
  readonly budgets: ToolByteBudgets;
}
