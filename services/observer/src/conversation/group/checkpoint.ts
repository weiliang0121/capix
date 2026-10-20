import { z } from 'zod';
import { isEqual } from 'es-toolkit/predicate';
import type { ChildFact, CheckpointFacts } from '@capix/server-runtime';
import { checkpointCodec } from '../checkpoint.js';
import { modelIndexesSchema, modelTextSchema } from '../model/schema.js';

// Persisted business values shared by the actual operation declarations; no execution policy here.
export const fileReceiptSchema = z.strictObject({ path: modelTextSchema, bytes: z.int().nonnegative(), digest: modelTextSchema });
export const fileTaskSchema = z.union([z.strictObject({ sourcePath: modelTextSchema, output: z.strictObject({ path: modelTextSchema }).optional() }), z.strictObject({ output: z.strictObject({ path: modelTextSchema }) })]);
export const messageSchema = z.strictObject({ role: z.enum(['user', 'assistant']), content: modelTextSchema });
export const activeMessageSchema = z.strictObject({ index: z.int().nonnegative(), message: messageSchema });
export const activeHistorySchema = z.array(activeMessageSchema).refine((items) => new Set(items.map((item) => item.index)).size === items.length, '活跃消息索引不能重复。');
export const answerMessageContextSchema = z.strictObject({ message: messageSchema, selectedMessages: activeHistorySchema });
export const selectionSchema = z.strictObject({ historyIndexes: modelIndexesSchema() });
export const memorySchema = z.strictObject({ id: modelTextSchema, topic: modelTextSchema, content: modelTextSchema, sourceIndexes: modelIndexesSchema(1), sourceResults: z.array(z.strictObject({ id: modelTextSchema, kind: z.literal('file-created'), answerIndex: z.int().nonnegative(), receipt: fileReceiptSchema })).optional() });
export const selectionInputSchema = z.strictObject({ message: messageSchema, memories: z.array(memorySchema) });
export const generationSchema = z.strictObject({ kind: z.enum(['answer', 'unknown', 'needs-info']), content: modelTextSchema });
const capability = z.strictObject({ name: modelTextSchema, description: z.string(), arguments: z.record(z.string(), z.unknown()) });
const feedback = z.strictObject({ code: modelTextSchema, message: modelTextSchema });
export const understandingInputSchema = selectionInputSchema.extend({ history: activeHistorySchema, fileTask: fileTaskSchema.optional(), available: z.array(capability).optional(), feedback: feedback.optional(), progress: z.strictObject({ file: fileTaskSchema.optional(), saved: z.strictObject({ path: modelTextSchema }).optional() }).optional() });
export const preflightInputSchema = z.strictObject({ task: fileTaskSchema, instruction: modelTextSchema });
export const inspectionSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('ready'), task: fileTaskSchema }), z.strictObject({ kind: z.literal('revise'), reason: modelTextSchema, feedback: modelTextSchema }), z.strictObject({ kind: z.literal('needs-input'), reason: modelTextSchema, question: modelTextSchema })]);
export const preflightSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('ready'), task: fileTaskSchema, instruction: modelTextSchema }), z.strictObject({ kind: z.literal('revise'), reason: modelTextSchema, feedback: modelTextSchema }), z.strictObject({ kind: z.literal('needs-input'), reason: modelTextSchema, question: modelTextSchema })]);
export const decisionSchema = z.union([z.strictObject({ kind: z.literal('invoke'), capability: z.literal('checkFile'), arguments: preflightInputSchema }), z.strictObject({ kind: z.literal('invoke'), capability: z.enum(['answer', 'document', 'save']), arguments: z.strictObject({}) }), z.strictObject({ kind: z.literal('finish'), conclusion: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('settled') }), z.strictObject({ kind: z.literal('clarify'), question: modelTextSchema }), z.strictObject({ kind: z.literal('unsupported'), explanation: modelTextSchema })]) })]);
const delivery = z.discriminatedUnion('capability', [z.strictObject({ capability: z.literal('checkFile'), output: preflightSchema }), z.strictObject({ capability: z.enum(['answer', 'document']), output: generationSchema }), z.strictObject({ capability: z.literal('save'), output: fileReceiptSchema })]);
export const decisionInputSchema = z.strictObject({ request: understandingInputSchema, progress: z.strictObject({ file: z.strictObject({ kind: z.literal('ready'), task: fileTaskSchema, instruction: modelTextSchema }).optional(), answer: generationSchema.optional(), saved: fileReceiptSchema.optional() }), latest: delivery.optional(), available: z.array(capability.extend({ name: z.enum(['checkFile', 'answer', 'document', 'save']) })), feedback: feedback.optional() });
export const emptyCheckpointState = checkpointCodec(z.null());
export const selectionCodec = checkpointCodec(selectionSchema);
export const selectionInputCodec = checkpointCodec(selectionInputSchema);
export const understandingInputCodec = checkpointCodec(understandingInputSchema);
export const decisionInputCodec = checkpointCodec(decisionInputSchema);
export const decisionCodec = checkpointCodec(decisionSchema);
export const preflightInputCodec = checkpointCodec(preflightInputSchema);
export const preflightCodec = checkpointCodec(preflightSchema);
export const inspectionCodec = checkpointCodec(inspectionSchema);
export const textDocumentCodec = checkpointCodec(fileReceiptSchema.extend({ text: z.string() }));
export const fileTaskCodec = checkpointCodec(fileTaskSchema);

export function originalCheckpoint(facts: Pick<CheckpointFacts<unknown>, 'round' | 'initialInput' | 'input'>): void {
  if (facts.round !== 1 || !isEqual(facts.initialInput, facts.input)) throw new Error('Operation checkpoint must preserve its original input and round');
}
export function acceptedChild<Definition>(child: ChildFact<Definition> | undefined) {
  if (!child || child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted') throw new Error('Checkpoint requires an accepted direct child');
  return Object.freeze({ ...child, returned: child.returned, reception: child.reception });
}
export function waitingChild<Definition>(facts: Pick<CheckpointFacts<unknown>, 'children'>, child: ChildFact<Definition>, key: string): ChildFact<Definition> {
  if (facts.children.values().at(-1)?.ref !== child.ref || child.key !== key || child.returned || child.reception.status !== 'pending') throw new Error('Checkpoint must identify its exact waiting child');
  return child;
}
export function checkLeafResult(facts: CheckpointFacts<unknown>): void {
  originalCheckpoint(facts);
  if (facts.children.values().length) throw new Error('Leaf result cannot contain child calls');
}
