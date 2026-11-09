import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import type { CheckpointCodec } from '@weiliang0121/capix-structure';
import { z } from 'zod';

/** A checkpoint accepts only the declared value, on both sides of storage. */
export function codec<Value>(schema: z.ZodType<Value>): CheckpointCodec<Value> {
  return { encode: (value) => cloneCheckpointValue(schema.parse(value)), decode: (value) => schema.parse(value) };
}

export const identity = z.string().refine((value) => /\S/.test(value), 'Expected a nonempty identity');
export const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const messageSchema = z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string() }).readonly();
export const acceptedMessageSchema = z.strictObject({ transcriptId: identity, index: count, message: messageSchema }).readonly();
export const acceptedMessageCodec = codec(acceptedMessageSchema);
export const stringCodec = codec(z.string());
export const emptyCodec = codec(z.strictObject({}));
export const voidCodec: CheckpointCodec<void> = {
  encode: (value) => {
    if (value !== undefined) throw new TypeError('Expected an empty result');
    return null;
  },
  decode: (value) => {
    if (value !== null) throw new TypeError('Expected an encoded empty result');
  },
};
