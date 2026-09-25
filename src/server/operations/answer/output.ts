import { z } from 'zod';
import type { GenerationOutput } from '../../../shared/operations/generation.js';
import { RuntimeError } from '../../errors/error.js';
import type { GenerationInput } from '../context/assemble.js';
import type { ModelOutputContract } from '../model.js';
import { modelTextSchema } from '../model/schema.js';

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
