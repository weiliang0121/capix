import { z } from 'zod';
import type { ConversationMaterialInput } from '../materials/input.js';
import { CompletionInteraction, modelReplySchema, modelRequestSchema } from '../model/completion-contract.js';
import { codec, count, identity, messageSchema } from './codecs.js';

export const modelRequestCodec = codec(modelRequestSchema);
export const modelReplyCodec = codec(modelReplySchema);
export const referenceSchema = z.strictObject({ id: identity, contract: z.literal(CompletionInteraction.key) }).readonly();
export const referenceCodec = codec(referenceSchema);

const stamp = z.strictObject({ id: identity, scope: identity, version: identity }).readonly();
const receipt = z.strictObject({ path: identity, bytes: count, digest: z.string().regex(/^[a-f0-9]{64}$/u) }).readonly();
const resultSource = z.strictObject({ id: identity, kind: z.literal('file-created'), answerIndex: count, receipt }).readonly();
const indexes = z
  .array(count)
  .min(1)
  .refine((values) => new Set(values).size === values.length, 'Duplicate memory source index')
  .readonly();
export const memoryStateSchema = z
  .strictObject({
    id: identity,
    topic: identity,
    content: identity,
    sourceIndexes: indexes,
    sourceResults: z
      .array(resultSource)
      .min(1)
      .refine((values) => new Set(values.map((value) => value.id)).size === values.length, 'Duplicate memory result source')
      .readonly()
      .optional(),
  })
  .readonly();
const entry = z.discriminatedUnion('source', [z.strictObject({ source: z.literal('messages'), key: count, value: messageSchema }).readonly(), z.strictObject({ source: z.literal('memories'), key: identity, value: memoryStateSchema }).readonly()]);
export const materialInputSchema: z.ZodType<ConversationMaterialInput> = z
  .strictObject({
    query: z.strictObject({ transcriptId: identity, index: count, content: identity }).readonly(),
    materials: z
      .strictObject({
        basis: z.strictObject({ viewRevision: count, sources: z.strictObject({ messages: stamp, memories: stamp }).readonly() }).readonly(),
        entries: z.array(entry).readonly(),
      })
      .readonly(),
  })
  .superRefine((value, context) => {
    if (value.query.transcriptId !== value.materials.basis.sources.messages.id) context.addIssue({ code: 'custom', message: 'Material transcript differs from query' });
    const seen = new Set<string>();
    for (const item of value.materials.entries) {
      const key = JSON.stringify([item.source, item.key]);
      if (seen.has(key)) context.addIssue({ code: 'custom', message: 'Duplicate material entry' });
      seen.add(key);
      if (item.source === 'messages' && item.key >= value.query.index) context.addIssue({ code: 'custom', message: 'Material contains current or later message' });
      if (item.source === 'memories' && item.key !== item.value.id) context.addIssue({ code: 'custom', message: 'Memory material identity differs from its key' });
    }
  })
  .readonly();
export const materialInputCodec = codec(materialInputSchema);
