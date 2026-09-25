import { z } from 'zod';
import type { GenerationOutput } from '@capix-observer/protocol';
import { RuntimeError } from '@capix-observer/runtime';
import type { GenerationInput } from './generate.js';
import type { ModelOutputContract } from '../../model/contract.js';
import { modelTextSchema } from '../../model/schema.js';

const answerSchema = z.strictObject({
  kind: z.enum(['answer', 'unknown', 'needs-info']),
  content: modelTextSchema,
}) satisfies z.ZodType<GenerationOutput>;

export const answerOutputContract = {
  schema: z.toJSONSchema(answerSchema),
  accept(value: unknown): GenerationOutput {
    const result = answerSchema.safeParse(value);
    if (!result.success) throw new RuntimeError('OUTPUT_SHAPE', '回答必须仅包含合法的 kind 和非空 content。', { issues: result.error.issues });
    return result.data;
  },
} as const satisfies ModelOutputContract<GenerationInput, GenerationOutput>;
