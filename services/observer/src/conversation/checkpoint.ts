import { z } from 'zod';
import { cloneCheckpointValue } from '@capix/checkpoint';
import { type CheckpointCodec } from '@capix/structure';
import { answerOutputContract } from './group/answer/output.js';
import type { GenerationOutput } from '@capix/protocol';
import { preparedConversationContextSchema } from './group/context/schema.js';

/** Service data contracts, shared by the actual R/E continuation declarations. */
export function checkpointCodec<Value>(schema: z.ZodType<Value>): CheckpointCodec<Value> {
  return { encode: (value) => cloneCheckpointValue(schema.parse(value)), decode: (value) => schema.parse(value) };
}
export const conversationCheckpointInput: CheckpointCodec<unknown> = { encode: cloneCheckpointValue, decode: cloneCheckpointValue };
export const conversationCheckpointOutput: CheckpointCodec<GenerationOutput> = { encode: (value) => cloneCheckpointValue(answerOutputContract.accept(value)), decode: (value) => answerOutputContract.accept(value) };
export const checkpointChild = z.strictObject({ childId: z.string().min(1) });
const message = z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().min(1) });
const outputFile = z.strictObject({ path: z.string().min(1) });
export const acceptedCheckpointInput = checkpointCodec(z.strictObject({ message, messageIndex: z.int().nonnegative(), fileTask: z.union([z.strictObject({ sourcePath: z.string().min(1), output: outputFile.optional() }), z.strictObject({ output: outputFile })]).optional() }));
export const answerSchema = z.strictObject({ kind: z.enum(['answer', 'unknown', 'needs-info']), content: z.string().min(1) });
const receipt = z.strictObject({ transcriptId: z.string().min(1), start: z.int().nonnegative(), count: z.literal(1), revision: z.int().nonnegative() });
const fileReceipt = z.strictObject({ path: z.string().min(1), bytes: z.int().nonnegative(), digest: z.string().min(1) });
const fileTask = z.union([z.strictObject({ sourcePath: z.string().min(1), output: outputFile.optional() }), z.strictObject({ output: outputFile })]);
const fileReady = z.strictObject({ kind: z.literal('ready'), task: fileTask, instruction: z.string().min(1) });
const fileResult = z.union([fileReady, z.strictObject({ kind: z.literal('revise'), reason: z.string(), feedback: z.string() }), z.strictObject({ kind: z.literal('needs-input'), reason: z.string(), question: z.string() })]);
const feedback = z.strictObject({ code: z.string(), message: z.string() });
export const acceptedDecisionSchema = z.union([z.strictObject({ kind: z.literal('invoke'), capability: z.enum(['checkFile', 'answer', 'document', 'save']), arguments: z.unknown() }), z.strictObject({ kind: z.literal('finish'), conclusion: z.union([z.strictObject({ kind: z.literal('settled') }), z.strictObject({ kind: z.literal('clarify'), question: z.string().min(1) }), z.strictObject({ kind: z.literal('unsupported'), explanation: z.string().min(1) })]) }), z.strictObject({ kind: z.literal('revise'), feedback })]);
export const executionProgressSchema = z.strictObject({
  file: fileReady.optional(),
  answer: answerSchema.optional(),
  saved: fileReceipt.optional(),
  latest: z.union([z.strictObject({ capability: z.literal('checkFile'), output: fileResult }), z.strictObject({ capability: z.enum(['answer', 'document']), output: answerSchema }), z.strictObject({ capability: z.literal('save'), output: fileReceipt })]).optional(),
  response: z.strictObject({ index: z.int().nonnegative(), message }).optional(),
  receipt: receipt.optional(),
  responseOrder: z.int().nonnegative().optional(),
});
export const executionContinuationSchema = z.strictObject({
  prepared: preparedConversationContextSchema,
  progress: executionProgressSchema,
  step: z.int().min(0).max(16),
  checkedCandidates: z.array(z.string()).max(16),
  feedback: feedback.optional(),
});
export const executionWaitingState = checkpointCodec(executionContinuationSchema);
export const executionDecisionState = checkpointCodec(executionContinuationSchema.extend({ choice: acceptedDecisionSchema }));
export const executionCapabilityState = checkpointCodec(executionContinuationSchema.extend({ capability: z.enum(['checkFile', 'answer', 'document', 'save']), arguments: z.unknown() }));
export const executionAcceptedState = checkpointCodec(executionContinuationSchema);
export type ExecutionProgress = z.infer<typeof executionProgressSchema>;
export type ExecutionContinuation = z.infer<typeof executionContinuationSchema>;
export type ExecutionWaitingState = ReturnType<typeof executionWaitingState.decode>;
export type ExecutionDecisionState = ReturnType<typeof executionDecisionState.decode>;
export type ExecutionCapabilityState = ReturnType<typeof executionCapabilityState.decode>;

export const decisionAcceptanceSchema = z.strictObject({ choice: acceptedDecisionSchema, progress: executionProgressSchema, checkedCandidates: z.array(z.string()).max(16) });

export type DecisionAcceptance = z.infer<typeof decisionAcceptanceSchema>;
