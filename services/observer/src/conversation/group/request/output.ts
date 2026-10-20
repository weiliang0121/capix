import { z } from 'zod';
import type { FileTask } from '@capix/protocol';
import { RuntimeError } from '@capix/server-runtime';
import { modelTextSchema } from '../../model/schema.js';
import type { ModelOutputContract } from '../../model/contract.js';

export type RequestProposal = { readonly kind: 'reply' } | { readonly kind: 'file'; readonly task: FileTask; readonly instruction: string } | { readonly kind: 'clarify'; readonly question: string } | { readonly kind: 'unsupported'; readonly explanation: string };

const outputPathSchema = z.strictObject({ path: modelTextSchema.max(1024) });
const fileTaskSchema = z.union([z.strictObject({ sourcePath: modelTextSchema.max(1024), output: outputPathSchema.optional() }), z.strictObject({ output: outputPathSchema })]);
const requestProposalSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('reply') }), z.strictObject({ kind: z.literal('file'), task: fileTaskSchema, instruction: modelTextSchema }), z.strictObject({ kind: z.literal('clarify'), question: modelTextSchema }), z.strictObject({ kind: z.literal('unsupported'), explanation: modelTextSchema })]);

/** A model returns a proposal; choosing an executable task remains the parent's acceptance. */
export const requestOutputContract = {
  schema: z.toJSONSchema(requestProposalSchema),
  accept(value: unknown): RequestProposal {
    const parsed = requestProposalSchema.safeParse(value);
    if (!parsed.success) throw new RuntimeError('OUTPUT_SHAPE', '请求理解必须返回 reply、file、clarify 或 unsupported，且仅含对应契约字段。', { issues: parsed.error.issues });
    return parsed.data;
  },
} as const satisfies ModelOutputContract<unknown, RequestProposal>;
