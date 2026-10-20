import { z } from 'zod';
import { checkpointCodec } from '../../checkpoint.js';
import type { MemoryInput } from './input.js';
import type { MemoryExtraction } from './output.js';

const indexes = z.array(z.int().nonnegative());
const source = z.strictObject({ id: z.string().min(1), kind: z.literal('file-created'), answerIndex: z.int().nonnegative(), receipt: z.strictObject({ path: z.string().min(1), bytes: z.int().nonnegative(), digest: z.string().min(1) }) });
const content = z.strictObject({ topic: z.string().min(1), content: z.string().min(1), sourceIndexes: indexes, sourceResults: z.array(source).optional() });
const change = { change: z.string().min(1), sourceIndexes: indexes, sourceResults: z.array(source).optional(), result: content };
export const memoryCheckpointInput = checkpointCodec(z.strictObject({ currentIndexes: indexes, messages: z.array(z.strictObject({ index: z.int().nonnegative(), message: z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().min(1) }) })), memories: z.array(content.extend({ id: z.string().min(1) })), results: z.array(source).optional() }) satisfies z.ZodType<MemoryInput>);
export const memoryCheckpointOutput = checkpointCodec(z.strictObject({ memories: z.array(z.discriminatedUnion('action', [z.strictObject({ action: z.literal('create'), memoryId: z.null(), ...change }), z.strictObject({ action: z.literal('update'), memoryId: z.string().min(1), ...change })])).max(4) }) satisfies z.ZodType<MemoryExtraction>);
