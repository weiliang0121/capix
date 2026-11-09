import type { MemoryBasis, MemoryChange } from '@weiliang0121/capix-memory';
import { z } from 'zod';
import { codec, count, identity, messageSchema } from '../recovery/codecs.js';
import type { ConversationMemoryContext } from './context.js';

const indexes = z
  .array(count)
  .min(1)
  .refine((items) => new Set(items).size === items.length, 'Memory sources must be unique');
const resultSource = z.strictObject({ id: identity, kind: z.literal('file-created'), answerIndex: count, receipt: z.strictObject({ path: identity, bytes: count, digest: z.string().regex(/^[a-f0-9]{64}$/u) }) });
const content = z.strictObject({ topic: identity, content: identity, sourceIndexes: indexes, sourceResults: z.array(resultSource).optional() });
const changeFields = { change: identity, sourceIndexes: indexes, sourceResults: z.array(resultSource).optional(), result: content };
export const memoryChangeSchema: z.ZodType<MemoryChange> = z.discriminatedUnion('action', [z.strictObject({ action: z.literal('create'), memoryId: z.null(), ...changeFields }), z.strictObject({ action: z.literal('update'), memoryId: identity, ...changeFields })]);
export const memoryChangesSchema = z.array(memoryChangeSchema).max(32);
export const memoryChangesCodec = codec<readonly MemoryChange[]>(memoryChangesSchema);
export const memoryBasisSchema: z.ZodType<MemoryBasis> = z.strictObject({ memoriesId: identity, transcriptId: identity, sequence: count });
export const memoryContextSchema: z.ZodType<ConversationMemoryContext> = z
  .strictObject({
    basis: memoryBasisSchema,
    acceptedIndex: count,
    messages: z.array(z.strictObject({ index: count, message: messageSchema })),
    memories: z.array(content.extend({ id: identity })),
  })
  .superRefine((value, context) => {
    if (value.messages.length !== value.acceptedIndex + 1 || value.messages.some((item, index) => item.index !== index) || value.messages.at(-1)?.message.role !== 'assistant') context.addIssue({ code: 'custom', message: 'Memory context must preserve its complete formal prefix' });
    if (new Set(value.memories.map((item) => item.id)).size !== value.memories.length || value.memories.some((item) => item.sourceIndexes.some((index) => index > value.acceptedIndex) || item.sourceResults?.some((source) => source.answerIndex > value.acceptedIndex))) context.addIssue({ code: 'custom', message: 'Memory context identities and sources must belong to its fixed prefix' });
  });
export const memoryContextCodec = codec(memoryContextSchema);

export interface MemoryMaintenanceApply {
  readonly basis: MemoryBasis;
  readonly changes: readonly MemoryChange[];
  readonly existingIds: readonly string[];
}

/** Also consumed by the host when checking a fixed receipt against its owning call. */
export const memoryApplySchema: z.ZodType<MemoryMaintenanceApply> = z.strictObject({ basis: memoryBasisSchema, changes: memoryChangesSchema, existingIds: z.array(identity).refine((items) => new Set(items).size === items.length) });
export const memoryApplyCodec = codec(memoryApplySchema);
export const memoryIdsCodec = codec<readonly string[]>(z.array(identity).refine((items) => new Set(items).size === items.length));
