import type { InteractionContract } from '@capix/interaction';
import { z } from 'zod';

const identity = z.string().refine((value) => /\S/.test(value), 'Completion identity must not be blank');
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const message = z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).readonly();
const modelRequestSchema = z
  .strictObject({
    messages: z.array(message).min(1).readonly(),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    responseFormat: z.enum(['text', 'json_object']).optional(),
    temperature: z.number().min(0).max(2).optional(),
    stream: z.boolean().optional(),
  })
  .readonly();
const modelReplySchema = z
  .strictObject({
    id: identity,
    model: identity,
    text: z.string(),
    finishReason: identity,
    usage: z
      .strictObject({ promptTokens: count, completionTokens: count, totalTokens: count, promptCacheHitTokens: count.optional(), promptCacheMissTokens: count.optional() })
      .refine((usage) => (usage.promptCacheHitTokens === undefined || usage.promptCacheHitTokens <= usage.promptTokens) && (usage.promptCacheMissTokens === undefined || usage.promptCacheMissTokens <= usage.promptTokens) && (usage.promptCacheHitTokens === undefined || usage.promptCacheMissTokens === undefined || usage.promptCacheHitTokens === usage.promptTokens - usage.promptCacheMissTokens), 'Prompt cache counts must match reported prompt tokens')
      .readonly()
      .nullable(),
  })
  .readonly();

/** Read-only historical decoder. These replies lack native continuation material. */
export const LegacyCompletionInteraction: InteractionContract<z.infer<typeof modelRequestSchema>, z.infer<typeof modelReplySchema>> = Object.freeze({
  key: 'conversation.completion.v1',
  request: (value: unknown) => modelRequestSchema.parse(value),
  reply: (value: unknown) => modelReplySchema.parse(value),
});
