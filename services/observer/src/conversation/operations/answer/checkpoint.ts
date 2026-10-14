import { z } from 'zod';
import { isEqual } from 'es-toolkit/predicate';
import { cloneCheckpointValue, type CheckpointCodec, type CheckpointContract, type InvocationCheckpointFrame, type CheckpointChild, type CheckpointValue } from '@capix/server-runtime';
import type { GenerationOutput } from '@capix/protocol';
import { modelIndexesSchema, modelTextSchema } from '../../model/schema.js';
import { modelRequestSchema, modelOutputSchema } from '../../model/interactions.js';
import { prepareRegenerationRequest, type ModelRegenerationInput } from '../../model/regeneration.js';
import { answerOutputContract } from './output.js';
import type { GenerationInput } from './generate.js';

const receipt = z.strictObject({ path: modelTextSchema, bytes: z.int().nonnegative(), digest: modelTextSchema });
const fileOutput = z.strictObject({ path: modelTextSchema });
const task = z.union([z.strictObject({ sourcePath: modelTextSchema, output: fileOutput.optional() }), z.strictObject({ output: fileOutput })]);
const inputSchema = z.strictObject({
  selection: z.strictObject({ historyIndexes: modelIndexesSchema() }),
  memories: z.array(z.strictObject({ id: modelTextSchema, topic: modelTextSchema, content: modelTextSchema, sourceIndexes: modelIndexesSchema(1), sourceResults: z.array(z.strictObject({ id: modelTextSchema, kind: z.literal('file-created'), answerIndex: z.int().nonnegative(), receipt })).optional() })),
  document: receipt.extend({ text: z.string() }).optional(),
  task: z.strictObject({ fileTask: task, instruction: modelTextSchema }).optional(),
}) satisfies z.ZodType<GenerationInput>;
const waitingSchema = z.strictObject({ childId: modelTextSchema });
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

type AcceptedChild = CheckpointChild & { state: Extract<CheckpointChild['state'], { kind: 'returned' }> & { reception: { kind: 'accepted'; output?: CheckpointValue } } };
function accepted(child: CheckpointChild | undefined): AcceptedChild {
  if (!child || child.state.kind !== 'returned' || child.state.reception.kind !== 'accepted' || !Object.hasOwn(child.state.reception, 'output')) throw new Error('Answer checkpoint requires an accepted direct child');
  return child as AcceptedChild;
}

function modelChild(frame: InvocationCheckpointFrame, contract: CheckpointContract): CheckpointChild {
  if ((frame.round !== 1 && frame.round !== 2) || !isEqual(frame.input, frame.currentInput)) throw new Error('Answer continuation must preserve its generation input');
  const original = frame.children.filter((child) => child.round === 1);
  const context = accepted(original[0]);
  const request = accepted(original[1]);
  const input = answerCheckpointCodecs.input.decode(frame.input);
  if (context.key !== 'context' || request.key !== 'request' || !isEqual(context.input, input.selection) || !isEqual(request.state.output, request.state.reception.output)) throw new Error('Answer checkpoint has incompatible preparation');
  const current = frame.children.filter((child) => child.round === frame.round);
  let model: CheckpointChild;
  if (frame.round === 1) model = current[2]!;
  else {
    const regenerated = accepted(current[0]);
    const basis = regenerated.input as unknown as ModelRegenerationInput;
    checkRegenerationBasis(frame, basis);
    if (regenerated.key !== 'request' || !isEqual(regenerated.state.reception.output, prepareRegenerationRequest(basis))) throw new Error('Answer regeneration checkpoint changed its prepared request');
    model = current[1]!;
    if (!isEqual(model?.input, regenerated.state.reception.output)) throw new Error('Answer regeneration checkpoint changed model request');
  }
  if (!model || model.key !== 'model' || model.identity.level !== 'operation' || model.contract?.key !== contract.key || model.contract.version !== contract.version || (frame.round === 1 && !isEqual(model.input, request.state.reception.output))) throw new Error('Answer model identity or fixed request differs from its preparation');
  modelRequestSchema.parse(model.input);
  return model;
}

export function checkModelWaiting(frame: InvocationCheckpointFrame, state: AnswerModelWaiting, contract: CheckpointContract): void {
  const model = modelChild(frame, contract);
  if (frame.children.filter((child) => child.round === frame.round).length !== (frame.round === 1 ? 3 : 2) || model.identity.contextId !== state.childId || model.state.kind !== 'waiting') throw new Error('Answer checkpoint must identify its exact waiting model child');
}

export function checkAnswerAccepted(frame: InvocationCheckpointFrame, output: GenerationOutput, contract: CheckpointContract): void {
  const model = accepted(modelChild(frame, contract));
  const current = frame.children.filter((child) => child.round === frame.round);
  const acceptance = accepted(current.at(-1));
  if (current.length !== (frame.round === 1 ? 4 : 3) || acceptance.key !== 'acceptance' || acceptance.identity.level !== 'attempt' || !isEqual(model.state.output, model.state.reception.output) || !isEqual(acceptance.input, { output: model.state.reception.output }) || !isEqual(acceptance.state.output, output) || !isEqual(acceptance.state.reception.output, output)) throw new Error('Answer checkpoint differs from the accepted model result');
  const feedback = modelOutputSchema.parse(model.state.output);
  if (feedback.finishReason !== 'stop' || !isEqual(answerOutputContract.accept(JSON.parse(feedback.content)), output)) throw new Error('Answer checkpoint does not contain a complete validated answer');
}

export function checkPreparationWaiting(frame: InvocationCheckpointFrame, state: AnswerModelWaiting, key: 'context' | 'request', contract: CheckpointContract): void {
  if ((frame.round !== 1 && frame.round !== 2) || !isEqual(frame.input, frame.currentInput)) throw new Error('Answer preparation checkpoint changed input');
  const current = frame.children.filter((child) => child.round === frame.round);
  const child = current.at(-1);
  if (!child || child.identity.contextId !== state.childId || child.key !== key || child.state.kind !== 'waiting' || child.contract?.key !== contract.key || child.contract.version !== contract.version) throw new Error('Answer preparation checkpoint must identify its exact child');
  const input = answerCheckpointCodecs.input.decode(frame.input);
  if (key === 'context') {
    if (frame.round !== 1 || current.length !== 1 || !isEqual(child.input, input.selection)) throw new Error('Answer context checkpoint changed selection');
  } else if (frame.round === 1) {
    const assembled = accepted(current[0]);
    const context = assembled.state.reception.output as unknown as Record<string, unknown>;
    if (current.length !== 2 || assembled.key !== 'context' || !isEqual(child.input, { ...context, memories: input.memories, ...(input.task ? { task: input.task } : {}), ...(input.document ? { document: input.document } : {}) })) throw new Error('Answer request checkpoint changed fixed preparation');
  } else {
    if (current.length !== 1) throw new Error('Answer regeneration preparation has unexpected child calls');
    checkRegenerationBasis(frame, child.input as unknown as ModelRegenerationInput);
  }
}

export function checkAcceptanceWaiting(frame: InvocationCheckpointFrame, state: AnswerModelWaiting, modelContract: CheckpointContract, acceptanceContract: CheckpointContract): void {
  const model = accepted(modelChild(frame, modelContract));
  const current = frame.children.filter((child) => child.round === frame.round);
  const child = current.at(-1);
  if (current.length !== (frame.round === 1 ? 4 : 3) || !child || child.identity.contextId !== state.childId || child.key !== 'acceptance' || child.contract?.key !== acceptanceContract.key || child.contract.version !== acceptanceContract.version || child.state.kind !== 'waiting' || !isEqual(child.input, { output: model.state.reception.output })) throw new Error('Answer acceptance checkpoint changed fixed feedback');
}

function checkRegenerationBasis(frame: InvocationCheckpointFrame, basis: ModelRegenerationInput): void {
  const original = frame.children.filter((child) => child.round === 1);
  const assembled = accepted(original[0]);
  const request = accepted(original[1]);
  const previous = accepted(original[2]);
  const rejection = original[3];
  const input = answerCheckpointCodecs.input.decode(frame.input);
  if (original.length !== 4 || assembled.key !== 'context' || !isEqual(assembled.input, input.selection) || request.key !== 'request' || previous.key !== 'model' || !isEqual(previous.input, request.state.reception.output) || !isEqual(previous.state.output, previous.state.reception.output) || !rejection || rejection.key !== 'acceptance' || rejection.state.kind !== 'failed' || rejection.state.failure.contract !== 'MODEL_OUTPUT_REJECTED' || !isEqual(rejection.input, { output: previous.state.reception.output })) throw new Error('Answer regeneration checkpoint has incompatible rejection history');
  const diagnostic = z.looseObject({ message: z.string(), detail: z.looseObject({ code: z.enum(['INVALID_JSON', 'EMPTY_OUTPUT', 'OUTPUT_SHAPE']) }) }).parse(rejection.state.error);
  if (modelOutputSchema.parse(previous.state.output).finishReason !== 'stop' || !isEqual(basis.request, previous.input) || !isEqual(basis.output, previous.state.reception.output) || basis.error?.code !== diagnostic.detail.code || basis.error.message !== diagnostic.message) throw new Error('Answer regeneration preparation changed accepted rejection evidence');
}
