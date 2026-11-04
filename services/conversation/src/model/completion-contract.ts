import type { InteractionContract } from '@capix/interaction';
import type { ModelReply, ModelRequest } from '@capix/model-provider';
import { z } from 'zod';
import { requireString } from '../text.js';

const identity = z.string().refine((value) => /\S/.test(value), 'Completion identity must not be blank');
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const message = z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).readonly();
export const modelRequestSchema = z
  .strictObject({
    messages: z.array(message).min(1).readonly(),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    responseFormat: z.enum(['text', 'json_object']).optional(),
    temperature: z.number().min(0).max(2).optional(),
    stream: z.boolean().optional(),
  })
  .readonly();
export const modelReplySchema = z
  .strictObject({
    id: identity,
    model: identity,
    text: z.string(),
    finishReason: identity,
    usage: z.strictObject({ promptTokens: count, completionTokens: count, totalTokens: count }).readonly().nullable(),
  })
  .readonly();

function isCompletionReply(value: unknown): value is ModelReply {
  return modelReplySchema.safeParse(value).success;
}

/** Output validation keeps the exact returned object; the interaction owns fixed-value capture. */
export function requireCompletionReply(value: unknown): ModelReply {
  if (!isCompletionReply(value)) throw new TypeError('Completion reply does not match its transport contract');
  return value;
}

/** A complete transport reply is a fact; accepting its finish reason and text belongs to the caller. */
export const CompletionInteraction: InteractionContract<ModelRequest, ModelReply, string> = Object.freeze({
  key: 'conversation.completion.v1',
  request: (value: unknown) => modelRequestSchema.parse(value),
  reply: requireCompletionReply,
  progress: (value: unknown) => requireString(value, 'Completion progress'),
});
