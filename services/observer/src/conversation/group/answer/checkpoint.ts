import { z } from 'zod';
import { isEqual } from 'es-toolkit/predicate';
import { cloneCheckpointValue, type CheckpointCodec, type CheckpointFacts, type ChildFact, type ChildDefinition } from '@capix/server-runtime';
import type { GenerationOutput } from '@capix/protocol';
import { modelIndexesSchema, modelTextSchema } from '../../model/schema.js';
import { modelRequestSchema, modelOutputSchema } from '../../model/interactions.js';
import { prepareRegenerationRequest, type ModelRegenerationInput } from '../../model/regeneration.js';
import { answerOutputContract } from './output.js';
import { answerMessageContextSchema } from '../checkpoint.js';
import type { GenerationInput, GenerateAnswerDefinition } from './generate.js';

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

type Facts = CheckpointFacts<GenerationInput>;
type Definitions = Pick<GenerateAnswerDefinition, 'assembleContextDefinition' | 'prepareRequestDefinition' | 'prepareRegenerationDefinition' | 'requestModelDefinition' | 'acceptOutputDefinition'>;
type AcceptedChild = ChildFact & { returned: { status: 'succeeded'; output: unknown }; reception: { status: 'accepted'; value: unknown } };
function accepted(child: ChildFact | undefined): AcceptedChild {
  if (!child || child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted') throw new Error('Answer checkpoint requires an accepted direct child');
  return child as AcceptedChild;
}
function requireDefinition(facts: Facts, definition: ChildDefinition, child: ChildFact | undefined): ChildFact {
  if (!child) throw new Error('Answer checkpoint is missing a child');
  return facts.children.require(definition, child.ref);
}
function sameInput(facts: Facts): void {
  if (!isEqual(facts.initialInput, facts.input)) throw new Error('Answer continuation must preserve its generation input');
}

function modelChild(facts: Facts, definitions: Definitions): ChildFact {
  sameInput(facts);
  const original = facts.children.values().filter((child) => child.parentRound === 1);
  const context = accepted(requireDefinition(facts, definitions.assembleContextDefinition, original[0]));
  const request = accepted(requireDefinition(facts, definitions.prepareRequestDefinition, original[1]));
  if (context.key !== 'context' || request.key !== 'request' || !isEqual(context.input, facts.initialInput.context) || !isEqual(context.returned.output, facts.initialInput.context) || !isEqual(context.reception.value, context.returned.output) || !isEqual(request.returned.output, request.reception.value)) throw new Error('Answer checkpoint has incompatible preparation');
  const current = facts.children.values().filter((child) => child.parentRound === facts.round);
  let model: ChildFact;
  if (facts.round === 1) model = requireDefinition(facts, definitions.requestModelDefinition, current[2]);
  else {
    const regenerated = accepted(requireDefinition(facts, definitions.prepareRegenerationDefinition, current[0]));
    const basis = regenerated.input as ModelRegenerationInput;
    checkRegenerationBasis(facts, basis, definitions);
    if (regenerated.key !== 'request' || !isEqual(regenerated.reception.value, prepareRegenerationRequest(basis))) throw new Error('Answer regeneration checkpoint changed its prepared request');
    model = requireDefinition(facts, definitions.requestModelDefinition, current[1]);
    if (!isEqual(model.input, regenerated.reception.value)) throw new Error('Answer regeneration checkpoint changed model request');
  }
  if (model.key !== 'model' || (facts.round === 1 && !isEqual(model.input, request.reception.value))) throw new Error('Answer model request differs from its preparation');
  modelRequestSchema.parse(model.input);
  return model;
}

export function checkModelWaiting(facts: Facts, child: ChildFact, definitions: Definitions): void {
  const model = modelChild(facts, definitions);
  if (facts.children.values().filter((item) => item.parentRound === facts.round).length !== (facts.round === 1 ? 3 : 2) || model.ref !== child.ref || model.returned) throw new Error('Answer checkpoint must identify its exact waiting model child');
}

export function checkAnswerAccepted(facts: Facts, output: GenerationOutput, definitions: Definitions): void {
  const model = accepted(modelChild(facts, definitions));
  const current = facts.children.values().filter((child) => child.parentRound === facts.round);
  const acceptance = accepted(requireDefinition(facts, definitions.acceptOutputDefinition, current.at(-1)));
  if (current.length !== (facts.round === 1 ? 4 : 3) || acceptance.key !== 'acceptance' || !isEqual(model.returned.output, model.reception.value) || !isEqual(acceptance.input, { output: model.reception.value }) || !isEqual(acceptance.returned.output, output) || !isEqual(acceptance.reception.value, output)) throw new Error('Answer checkpoint differs from the accepted model result');
  const feedback = modelOutputSchema.parse(model.returned.output);
  if (feedback.finishReason !== 'stop' || !isEqual(answerOutputContract.accept(JSON.parse(feedback.content)), output)) throw new Error('Answer checkpoint does not contain a complete validated answer');
}

export function checkPreparationWaiting(facts: Facts, child: ChildFact, key: 'context' | 'request', definitions: Definitions): void {
  sameInput(facts);
  const current = facts.children.values().filter((item) => item.parentRound === facts.round);
  if (current.at(-1)?.ref !== child.ref || child.key !== key || child.returned) throw new Error('Answer preparation checkpoint must identify its exact child');
  const input = facts.initialInput;
  if (key === 'context') {
    requireDefinition(facts, definitions.assembleContextDefinition, child);
    if (facts.round !== 1 || current.length !== 1 || !isEqual(child.input, input.context)) throw new Error('Answer context checkpoint changed fixed material');
  } else if (facts.round === 1) {
    requireDefinition(facts, definitions.prepareRequestDefinition, child);
    const assembled = accepted(requireDefinition(facts, definitions.assembleContextDefinition, current[0]));
    const context = assembled.reception.value as Record<string, unknown>;
    if (current.length !== 2 || assembled.key !== 'context' || !isEqual(assembled.input, input.context) || !isEqual(assembled.returned.output, input.context) || !isEqual(assembled.reception.value, assembled.returned.output) || !isEqual(child.input, { ...context, memories: input.memories, ...(input.task ? { task: input.task } : {}), ...(input.document ? { document: input.document } : {}) })) throw new Error('Answer request checkpoint changed fixed preparation');
  } else {
    requireDefinition(facts, definitions.prepareRegenerationDefinition, child);
    if (current.length !== 1) throw new Error('Answer regeneration preparation has unexpected child calls');
    checkRegenerationBasis(facts, child.input as ModelRegenerationInput, definitions);
  }
}

export function checkAcceptanceWaiting(facts: Facts, child: ChildFact, definitions: Definitions): void {
  const model = accepted(modelChild(facts, definitions));
  const current = facts.children.values().filter((item) => item.parentRound === facts.round);
  requireDefinition(facts, definitions.acceptOutputDefinition, child);
  if (current.length !== (facts.round === 1 ? 4 : 3) || current.at(-1)?.ref !== child.ref || child.key !== 'acceptance' || child.returned || !isEqual(child.input, { output: model.reception.value })) throw new Error('Answer acceptance checkpoint changed fixed feedback');
}

function checkRegenerationBasis(facts: Facts, basis: ModelRegenerationInput, definitions: Definitions): void {
  const original = facts.children.values().filter((child) => child.parentRound === 1);
  const assembled = accepted(requireDefinition(facts, definitions.assembleContextDefinition, original[0]));
  const request = accepted(requireDefinition(facts, definitions.prepareRequestDefinition, original[1]));
  const previous = accepted(requireDefinition(facts, definitions.requestModelDefinition, original[2]));
  const rejection = requireDefinition(facts, definitions.acceptOutputDefinition, original[3]);
  if (original.length !== 4 || assembled.key !== 'context' || !isEqual(assembled.input, facts.initialInput.context) || !isEqual(assembled.returned.output, facts.initialInput.context) || !isEqual(assembled.reception.value, assembled.returned.output) || request.key !== 'request' || previous.key !== 'model' || !isEqual(previous.input, request.reception.value) || !isEqual(previous.returned.output, previous.reception.value) || rejection.key !== 'acceptance' || rejection.returned?.status !== 'failed' || rejection.returned.failure?.contract !== 'MODEL_OUTPUT_REJECTED' || !isEqual(rejection.input, { output: previous.reception.value }) || facts.continuation?.origin?.kind !== 'child-return' || facts.continuation.origin.child !== rejection.ref) throw new Error('Answer regeneration checkpoint has incompatible rejection history');
  const diagnostic = z.looseObject({ message: z.string(), detail: z.looseObject({ code: z.enum(['INVALID_JSON', 'EMPTY_OUTPUT', 'OUTPUT_SHAPE']) }) }).parse(rejection.returned.diagnostic);
  if (modelOutputSchema.parse(previous.returned.output).finishReason !== 'stop' || !isEqual(basis.request, previous.input) || !isEqual(basis.output, previous.reception.value) || basis.error?.code !== diagnostic.detail.code || basis.error.message !== diagnostic.message) throw new Error('Answer regeneration preparation changed accepted rejection evidence');
}
