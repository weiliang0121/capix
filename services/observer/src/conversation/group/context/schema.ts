import { z } from 'zod';
import { modelTextSchema } from '../../model/schema.js';
import type { ActiveViewBasis, ActiveViewSelection, ActiveViewSnapshot } from '@capix/view';
import type { ContextMaintenanceInput, ContextMaintenanceRequest, PreparedConversationContext } from './types.js';

const indexes = z
  .array(z.int().nonnegative())
  .refine((values) => new Set(values).size === values.length, '活跃消息索引不能重复。')
  .readonly();
const memoryIds = z
  .array(z.string().min(1))
  .refine((values) => new Set(values).size === values.length, '活跃记忆不能重复。')
  .readonly();
const message = z.strictObject({ role: z.enum(['user', 'assistant']), content: modelTextSchema }).readonly();
const messages = z
  .array(z.strictObject({ index: z.int().nonnegative(), message }).readonly())
  .refine((values) => new Set(values.map((item) => item.index)).size === values.length, '活跃消息索引不能重复。')
  .readonly();
const receipt = z.strictObject({ path: modelTextSchema, bytes: z.int().nonnegative(), digest: modelTextSchema }).readonly();
const resultSource = z.strictObject({ id: modelTextSchema, kind: z.literal('file-created'), answerIndex: z.int().nonnegative(), receipt }).readonly();
const memory = z.strictObject({ id: modelTextSchema, topic: modelTextSchema, content: modelTextSchema, sourceIndexes: indexes.refine((values) => values.length > 0, '记忆必须有来源。'), sourceResults: z.array(resultSource).readonly().optional() }).readonly();

export const activeViewBasisSchema = z.strictObject({ transcriptId: z.string().min(1), memoriesId: z.string().min(1), indexRevision: z.int().nonnegative(), transcriptRevision: z.int().nonnegative(), memorySequence: z.int().nonnegative() }).readonly() satisfies z.ZodType<ActiveViewBasis>;
export const activeViewSelectionSchema = z.strictObject({ basis: activeViewBasisSchema, messageIndexes: indexes, memoryIds }).readonly() satisfies z.ZodType<ActiveViewSelection>;
export const activeViewSnapshotSchema = z
  .strictObject({
    basis: activeViewBasisSchema,
    messages,
    memories: z
      .array(memory)
      .refine((values) => new Set(values.map((item) => item.id)).size === values.length, '活跃记忆不能重复。')
      .readonly(),
  })
  .readonly() satisfies z.ZodType<ActiveViewSnapshot>;
export const contextMaintenanceRequestSchema = z.strictObject({ phase: z.enum(['before-request', 'after-content']) }) satisfies z.ZodType<ContextMaintenanceRequest>;
const settings = z.strictObject({ model: z.string().min(1), contextBudget: z.int().positive(), maxOutputTokens: z.int().positive(), timeoutMs: z.int().positive() });
export const contextMaintenanceInputSchema = contextMaintenanceRequestSchema.extend({ material: activeViewSnapshotSchema, settings }) satisfies z.ZodType<ContextMaintenanceInput>;
export const preparedConversationContextSchema = z.strictObject({ material: activeViewSnapshotSchema, context: z.strictObject({ message, selectedMessages: messages }).readonly(), selection: z.strictObject({ historyIndexes: indexes }).readonly() }).readonly() satisfies z.ZodType<PreparedConversationContext>;

export const maintenanceAcceptedSchema = z.strictObject({ input: contextMaintenanceInputSchema, decision: activeViewSelectionSchema });
export const maintenanceCompletedSchema = maintenanceAcceptedSchema.extend({ material: activeViewSnapshotSchema });
