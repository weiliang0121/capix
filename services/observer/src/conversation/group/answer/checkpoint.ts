import { z } from 'zod';
import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import { type CheckpointCodec } from '@weiliang0121/capix-structure';
import type { GenerationOutput } from '@weiliang0121/capix-protocol';
import { modelIndexesSchema, modelTextSchema } from '../../model/schema.js';
import { answerOutputContract } from './output.js';
import { answerMessageContextSchema } from '../checkpoint.js';
import type { GenerationInput } from './generate.js';

const receipt = z.strictObject({ path: modelTextSchema, bytes: z.int().nonnegative(), digest: modelTextSchema });
const fileOutput = z.strictObject({ path: modelTextSchema });
const task = z.union([z.strictObject({ sourcePath: modelTextSchema, output: fileOutput.optional() }), z.strictObject({ output: fileOutput })]);
const inputSchema = z.strictObject({
  context: answerMessageContextSchema,
  memories: z.array(z.strictObject({ id: modelTextSchema, topic: modelTextSchema, content: modelTextSchema, sourceIndexes: modelIndexesSchema(1), sourceResults: z.array(z.strictObject({ id: modelTextSchema, kind: z.literal('file-created'), answerIndex: z.int().nonnegative(), receipt })).optional() })),
  document: receipt.extend({ text: z.string() }).optional(),
  task: z.strictObject({ fileTask: task, instruction: modelTextSchema }).optional(),
}) satisfies z.ZodType<GenerationInput>;
const waitingSchema = z.strictObject({});
export type AnswerModelWaiting = z.infer<typeof waitingSchema>;

function encodeInput(value: GenerationInput) {
  if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError('Answer checkpoint input must be plain data');
  const properties: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value);
  // The existing document composition passes absent optional fields explicitly; the codec omits them.
  for (const key of ['document', 'task']) {
    const property = properties[key];
    if (property && 'value' in property && property.value === undefined) delete properties[key];
  }
  return cloneCheckpointValue(inputSchema.parse(cloneCheckpointValue(Object.defineProperties({}, properties))));
}

/** Recovery reads the saved preparation; it neither reconstructs history nor captures current settings. */
export const answerCheckpointCodecs = Object.freeze({
  input: Object.freeze<CheckpointCodec<GenerationInput>>({ encode: encodeInput, decode: (value) => inputSchema.parse(value) }),
  output: Object.freeze<CheckpointCodec<GenerationOutput>>({ encode: (value) => cloneCheckpointValue(answerOutputContract.accept(cloneCheckpointValue(value))), decode: (value) => answerOutputContract.accept(value) }),
  waiting: Object.freeze<CheckpointCodec<AnswerModelWaiting>>({ encode: (value) => waitingSchema.parse(cloneCheckpointValue(value)), decode: (value) => waitingSchema.parse(value) }),
});
