import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import type { CheckpointCodec } from '@weiliang0121/capix-structure';
import { z } from 'zod';

export function codec<Value>(schema: z.ZodType<Value>): CheckpointCodec<Value> {
  return { encode: (value) => cloneCheckpointValue(schema.parse(value)), decode: (value) => schema.parse(value) };
}
export const stringCodec = codec(z.string());
