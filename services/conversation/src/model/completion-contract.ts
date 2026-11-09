import type { InteractionContract } from '@weiliang0121/capix-interaction';
import { requireModelRequest, requireModelReply, type ModelReply, type ModelRequest } from '@weiliang0121/capix-model-provider';
import { z } from 'zod';
import { requireString } from '../text.js';

// Provider owns the complete pure-value contract; CP composition uses the same validators.
export const modelRequestSchema = checked(requireModelRequest);
export const modelReplySchema = checked(requireModelReply);

/** Keep the exact returned identity; Interaction/CP own immutable capture. */
export const requireCompletionReply = requireModelReply;

export const CompletionInteraction: InteractionContract<ModelRequest, ModelReply, string> = Object.freeze({
  key: 'conversation.completion.v2',
  request: requireModelRequest,
  reply: requireModelReply,
  progress: (value: unknown) => requireString(value, 'Completion progress'),
});

function checked<T>(require: (value: unknown) => T): z.ZodType<T> {
  return z.custom<T>((value) => {
    try {
      require(value);
      return true;
    } catch {
      return false;
    }
  }, 'Model value does not match its transport contract');
}
