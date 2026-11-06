import { z } from 'zod';
import { resolveToolBudgets, type ToolByteBudgets } from '../tools/budget.js';

export interface HistoryToolPolicy {
  readonly maxSearchResults: number;
  readonly maxSearchMessages: number;
  readonly excerptLength: number;
  readonly maxReadLength: number;
  readonly maxOutputBytes: number;
}
export interface ToolConversationPolicy {
  readonly version: string;
  readonly modelWaitMs: number;
  readonly maxModelCalls: number;
  readonly maxMaterialBytes: number;
  readonly budgets: ToolByteBudgets;
  readonly history: HistoryToolPolicy;
}
export type ToolConversationPolicyOptions = Partial<Omit<ToolConversationPolicy, 'budgets' | 'history'>> & { readonly budgets?: Partial<ToolByteBudgets>; readonly history?: Partial<HistoryToolPolicy> };
const policySchema = z
  .strictObject({
    version: z.string().trim().min(1),
    modelWaitMs: z.number().int().min(1).max(2147483647),
    maxModelCalls: z.number().int().min(1).max(32),
    maxMaterialBytes: z
      .number()
      .int()
      .min(1)
      .max(2 * 1024 * 1024),
    history: z.strictObject({ maxSearchResults: z.number().int().min(1).max(20), maxSearchMessages: z.number().int().min(1).max(1000), excerptLength: z.number().int().min(2).max(1024), maxReadLength: z.number().int().min(2).max(4096), maxOutputBytes: z.number().int().min(256).max(8192) }).readonly(),
  })
  .readonly();
export function resolveToolConversationPolicy(options: ToolConversationPolicyOptions = {}): ToolConversationPolicy {
  const { budgets, history, ...settings } = options;
  const value = policySchema.parse({ version: 'history-tools-v1', modelWaitMs: 50_000, maxModelCalls: 8, maxMaterialBytes: 256 * 1024, ...settings, history: { maxSearchResults: 6, maxSearchMessages: 256, excerptLength: 120, maxReadLength: 1024, maxOutputBytes: 4096, ...history } });
  const limits = resolveToolBudgets(budgets);
  if (limits.maxFeedbackBytes < 2048) throw new RangeError('History tools require at least 2048 feedback bytes for identities and bounded metadata');
  return Object.freeze({ ...value, budgets: limits });
}
