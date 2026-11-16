import { DEFAULT_INTERACTION_TEXT_UNITS, MAX_INTERACTION_TEXT_UNITS, Interaction, type InteractionChannel, type InteractionReference, type InteractionState, type InteractionDataLimits } from '@weiliang0121/capix-interaction';
import type { ModelReply, ModelRequest } from '@weiliang0121/capix-model-provider';
import { requireModelReply, requireModelRequest } from '@weiliang0121/capix-model-provider';
import { ModelExchangeResource, type ModelExchanges, type ExchangeReference, type ExchangePrefix } from '@weiliang0121/capix-model-exchanges';
import { RuntimeError, stableValue } from '@weiliang0121/capix-contracts';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { isDeepStrictEqual, types } from 'node:util';
import { ResourceOffer, ResourcePortError, type ResourceOperation, type ResourcesOf } from '@weiliang0121/capix-resources';
import { Node, checkpointPoint, type NodeWork, type ResumeWork } from '@weiliang0121/capix-structure';
import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import { z } from 'zod';
import { codec } from './codec.js';
import type { ToolCatalog } from './catalog.js';
import { assertToolExchangeBytes, assertToolReplyBytes, assertToolFeedbackBytes, assertToolRequestBytes, reserveToolReply, reserveToolFeedback, type ToolByteBudgets, type ToolRequestInspection, type ToolCapacityReason } from './budget.js';
import { assertToolContextText, toolContextMessage, toolContextReservation, type ToolCapacityBoundary, type ToolContextPreparation, type ToolRequestContext } from './context.js';

/** Host registration contains no per-call input or mutable Tool configuration. */
export interface ToolModelSource {
  readonly channel: InteractionChannel<ModelRequest, ModelReply, string>;
  readonly exchanges: ModelExchanges;
  readonly recovery?: ToolInteractionRecovery;
  readonly inspection?: ToolRequestInspection;
  readonly context?: ToolContextPreparation;
}
export interface ToolInteractionRecovery {
  read(id: string): InteractionState<ModelRequest, ModelReply> | undefined;
  /** Same fixed data budgets as the host Interaction registration; rechecked on cold reads. */
  readonly interactionLimits?: InteractionDataLimits;
}

/** A local timeout preserves the original interaction for a later read. */
export class ToolModelPending extends Error {
  readonly reference: InteractionReference;
  constructor(reference: InteractionReference) {
    super('Model reply is still pending; read the same interaction later');
    this.name = 'ToolModelPending';
    this.reference = Object.freeze({ id: reference.id, contract: reference.contract });
  }
}

export interface ToolModelInput extends ExchangePrefix {
  readonly context?: string;
}

/** Read capability declarations without evaluating author accessors or proxy traps. */
function recoveryField(value: object, key: string): PropertyDescriptor | undefined {
  let current: object | null = value;
  while (current !== null) {
    if (types.isProxy(current)) throw new TypeError('Tool recovery configuration must not contain proxies');
    const field = Object.getOwnPropertyDescriptor(current, key);
    if (field) {
      if (!('value' in field)) throw new TypeError('Tool recovery configuration must use data properties');
      return field;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/** Internal capture material, separate from the host capability's receiver. */
export interface CapturedToolModelSource {
  readonly source: ToolModelSource;
  readonly recovery?: ToolInteractionRecovery;
}

function captureModelSource(source: ToolModelSource): CapturedToolModelSource {
  const recovery = recoveryField(source, 'recovery')?.value;
  if (recovery === undefined) return Object.freeze({ source });
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery) || types.isProxy(recovery)) throw new TypeError('Tool recovery requires a host read capability');
  const read = recoveryField(recovery, 'read')?.value;
  if (typeof read !== 'function' || types.isProxy(read)) throw new TypeError('Tool recovery requires a host read capability');
  const configured = recoveryField(recovery, 'interactionLimits')?.value;
  let interactionLimits: InteractionDataLimits | undefined;
  if (configured !== undefined) {
    if (!configured || typeof configured !== 'object' || Array.isArray(configured) || types.isProxy(configured)) throw new TypeError('Tool recovery limits must be plain data');
    const prototype = Object.getPrototypeOf(configured);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Tool recovery limits must be plain data');
    const fields = Object.getOwnPropertyDescriptors(configured);
    for (const key of Reflect.ownKeys(fields)) {
      const field = fields[key as string]!;
      if ((key !== 'requestTextUnits' && key !== 'replyTextUnits') || !field.enumerable || !('value' in field)) throw new TypeError('Tool recovery limits must use own data properties');
      if (field.value !== undefined && (!Number.isSafeInteger(field.value) || field.value < 1 || field.value > MAX_INTERACTION_TEXT_UNITS)) throw new RangeError('Tool recovery text limits exceed framework support bounds');
    }
    interactionLimits = Object.freeze({ requestTextUnits: fields.requestTextUnits?.value ?? DEFAULT_INTERACTION_TEXT_UNITS, replyTextUnits: fields.replyTextUnits?.value ?? DEFAULT_INTERACTION_TEXT_UNITS });
  }
  return Object.freeze({ source, recovery: Object.freeze({ read: Function.prototype.bind.call(read, recovery), ...(interactionLimits ? { interactionLimits } : {}) }) });
}

function request(source: ToolModelSource, input: ToolModelInput, budgets: ToolByteBudgets, context?: ToolRequestContext, expectedCapacity?: ToolCapacityReason): ModelRequest {
  const text = assertToolContextText(input.context, context);
  const base = source.exchanges.request({ origin: input.origin, exchanges: input.exchanges });
  const value = text === undefined ? base : Object.freeze({ ...base, messages: Object.freeze([...base.messages, toolContextMessage(text)]) });
  assertToolRequestBytes(value, budgets, source.inspection, 0, [], false, expectedCapacity);
  return value;
}

export const ToolModelResource = new ResourceOffer({
  name: 'tool.model',
  capture: captureModelSource,
  methods: {
    prepare({ source }: CapturedToolModelSource, input: { readonly prefix: ExchangePrefix; readonly context: ToolRequestContext; readonly boundary?: ToolCapacityBoundary }) {
      if (types.isProxy(source)) throw new TypeError('Tool request context requires a host preparation capability');
      const prefix = stableValue(input.prefix);
      const closed = source.exchanges.closed(prefix.origin, prefix.exchanges);
      if (source.exchanges.values(prefix.origin).length !== closed.length) throw new TypeError('Tool request preparation requires the complete closed origin prefix');
      const field = Object.getOwnPropertyDescriptor(source, 'context');
      if (!field || !field.enumerable || !('value' in field)) throw new TypeError('Tool request context requires an own host preparation capability');
      const capability = field.value;
      if (!capability || typeof capability !== 'object' || Array.isArray(capability) || types.isProxy(capability) || Object.getOwnPropertySymbols(capability).length) throw new TypeError('Tool request context requires a host preparation capability');
      const descriptors = Object.getOwnPropertyDescriptors(capability);
      const prepare = descriptors.prepare;
      if (Object.keys(descriptors).length !== 1 || !prepare || !prepare.enumerable || !('value' in prepare) || typeof prepare.value !== 'function' || types.isProxy(prepare.value)) throw new TypeError('Tool context preparation must be an own synchronous method');
      const value: unknown = Reflect.apply(prepare.value, capability, [prefix, input.boundary === undefined ? undefined : stableValue(input.boundary)]);
      if (types.isPromise(value)) {
        void Promise.prototype.then.call(value, undefined, () => undefined);
        throw new TypeError('Tool request context preparation must be synchronous');
      }
      return assertToolContextText(value, input.context);
    },
    start({ source }: CapturedToolModelSource, input: { readonly prefix: ToolModelInput; readonly budgets: ToolByteBudgets; readonly context?: ToolRequestContext }) {
      const value = request(source, input.prefix, input.budgets, input.context);
      // Full snapshot accounting is linear and includes every fixed origin.
      const snapshot = source.exchanges.snapshot();
      reserveToolReply(snapshot.entries, input.budgets, snapshot.origins);
      return source.channel.start(value);
    },
    preflight({ source }: CapturedToolModelSource, input: ExchangePrefix & { readonly current: ExchangeReference; readonly defer?: boolean; readonly feedbackReservations: readonly { readonly toolCallId: string; readonly maxBytes: number }[]; readonly budgets: ToolByteBudgets; readonly context?: ToolRequestContext }) {
      const base = request(source, { origin: input.origin, exchanges: input.exchanges }, input.budgets);
      const current = source.exchanges.read(input.origin, input.current, false);
      assertToolReplyBytes(current.reply, input.budgets);
      // Validate that this is the next exchange after the exact closed prefix.
      const ordered = source.exchanges.values(input.origin);
      if (ordered[input.exchanges.length]?.id !== current.id) throw new Error('Tool exchange is not the next exchange in its origin');
      const calls = current.reply.output.filter((item) => item.kind === 'tool-call');
      const reservations = new Map(input.feedbackReservations.map((item) => [item.toolCallId, item.maxBytes]));
      if (reservations.size !== calls.length || input.feedbackReservations.length !== calls.length || calls.some((call) => !reservations.has(call.id)) || [...reservations.values()].some((limit) => !Number.isSafeInteger(limit) || limit < 1 || limit > input.budgets.maxFeedbackBytes)) throw new TypeError('Tool feedback reservations must exactly cover the fixed calls within the global limit');
      const pending = calls.filter((call) => !current.feedback.some((item) => item.toolCallId === call.id));
      const placeholders = pending.map((call) => {
        const content: { kind: 'text'; text: string }[] = [{ kind: 'text', text: '' }];
        const limit = reservations.get(call.id)!;
        const result = assertToolFeedbackBytes(call.id, { status: 'ok', content }, { maxFeedbackBytes: limit }, 'reserved');
        // Reserve node-count overhead as well as bytes before dispatching effects.
        for (let count = 1; count < 32; count++) {
          const candidate = [...content, { kind: 'text', text: '' }];
          if (Buffer.byteLength(JSON.stringify({ toolCallId: call.id, status: 'ok', content: candidate })) > limit) break;
          content.push({ kind: 'text', text: '' });
        }
        return { toolCallId: call.id, ...result };
      });
      for (const feedback of current.feedback) assertToolFeedbackBytes(feedback.toolCallId, { status: feedback.status, content: feedback.content }, input.budgets);
      const feedbackGrowth = pending.reduce((total, call, index) => total + reservations.get(call.id)! - Buffer.byteLength(JSON.stringify(placeholders[index]), 'utf8'), 0);
      const projectedExchange = { reply: current.reply, feedback: [...current.feedback, ...placeholders] };
      const exchangeFailure = assertToolExchangeBytes(projectedExchange, feedbackGrowth, input.defer);
      if (exchangeFailure) return exchangeFailure;
      const snapshot = source.exchanges.snapshot();
      reserveToolFeedback(
        snapshot.entries,
        current,
        pending.map((call) => reservations.get(call.id)!),
        input.budgets,
        snapshot.origins,
      );
      const emptyContext = toolContextMessage('');
      const contextBytes = Buffer.byteLength(JSON.stringify(emptyContext), 'utf8');
      // Count the message's structure too; byte growth alone cannot reserve nodes.
      const contextPlaceholder = input.context && input.context.maxBytes >= contextBytes ? emptyContext : undefined;
      const estimate = { ...base, ...(contextPlaceholder ? { messages: Object.freeze([...base.messages, contextPlaceholder]) } : {}), exchanges: [...(base.exchanges ?? []), projectedExchange] };
      return assertToolRequestBytes(
        estimate,
        input.budgets,
        source.inspection,
        feedbackGrowth + toolContextReservation(input.context) - (contextPlaceholder ? contextBytes + 1 : 0),
        pending.map((call) => call.id),
        input.defer,
      );
    },
    closure({ source }: CapturedToolModelSource, input: ExchangePrefix & { readonly current: ExchangeReference; readonly feedback: readonly { readonly toolCallId: string; readonly result: import('@weiliang0121/capix-model-provider').ToolResult }[]; readonly budgets: ToolByteBudgets }) {
      const base = source.exchanges.request({ origin: input.origin, exchanges: input.exchanges });
      const current = source.exchanges.read(input.origin, input.current, false);
      const feedback = input.feedback.map(({ toolCallId, result }) => ({ toolCallId, ...assertToolFeedbackBytes(toolCallId, result, input.budgets) }));
      const snapshot = source.exchanges.snapshot();
      reserveToolFeedback(
        snapshot.entries,
        current,
        feedback.map((value) => Buffer.byteLength(JSON.stringify(value))),
        input.budgets,
        snapshot.origins,
      );
      assertToolRequestBytes({ ...base, exchanges: [...(base.exchanges ?? []), { reply: current.reply, feedback: [...current.feedback, ...feedback] }] }, input.budgets, source.inspection);
    },
    confirm({ source, recovery }: CapturedToolModelSource, input: { readonly reference: InteractionReference; readonly basis: ToolModelInput; readonly reply?: ModelReply; readonly budgets: ToolByteBudgets; readonly context?: ToolRequestContext; readonly capacity?: ToolCapacityReason }) {
      try {
        const saved = recovery?.read(input.reference.id);
        if (types.isPromise(saved)) {
          void Promise.prototype.then.call(saved, undefined, () => undefined);
          throw new TypeError('Tool interaction recovery read must be synchronous');
        }
        if (!saved) throw new Error('Original model request or durable feedback is unavailable');
        // Reuse Interaction's recovery admission, including delivery/revision and
        // feedback identity checks. Restoring creates no sender or persistence.
        const interaction = Interaction.restore<ModelRequest, ModelReply>(saved, { contract: { key: input.reference.contract, request: requireModelRequest, reply: requireModelReply }, ...(recovery?.interactionLimits ? { limits: recovery.interactionLimits } : {}) });
        const state = interaction.exportState();
        const received = interaction.read();
        if (state.id !== input.reference.id || received.kind !== 'received' || !isDeepStrictEqual(state.request, request(source, input.basis, input.budgets, input.context, input.capacity))) throw new Error('Original model request or durable feedback is unavailable');
        assertToolReplyBytes(received.feedback.payload, input.budgets);
        if (input.reply !== undefined && !isDeepStrictEqual(input.reply, received.feedback.payload)) throw new Error('Completed model reply differs from its durable interaction');
      } catch (cause) {
        if (cause instanceof PersistenceError) throw cause;
        throw new ResourcePortError('Tool recovery requires exact original model request and durable feedback; it will not resend', { cause: new RuntimeError('CHECKPOINT_CONTENT_CHANGED', 'Saved model interaction does not match the fixed request', undefined, { cause }) });
      }
    },
    async wait({ source }: CapturedToolModelSource, input: { readonly reference: InteractionReference; readonly waitMs: number; readonly maxReplyBytes: number }, operation: ResourceOperation) {
      if (!Number.isSafeInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 2_147_483_647) throw new RangeError('Model reply wait must be a nonnegative timer duration');
      const local = new AbortController();
      const cancel = () => local.abort(operation.signal?.reason);
      const detach = operation.onClose((reason) => local.abort(reason));
      operation.signal?.addEventListener('abort', cancel, { once: true });
      if (operation.signal?.aborted) cancel();
      try {
        const result = await source.channel.wait(input.reference, { waitMs: input.waitMs, signal: local.signal });
        if (result.kind === 'unavailable') throw result.error;
        if (result.kind !== 'received') throw new ToolModelPending(input.reference);
        return assertToolReplyBytes(result.feedback.payload, { maxReplyBytes: input.maxReplyBytes });
      } finally {
        detach();
        operation.signal?.removeEventListener('abort', cancel);
      }
    },
  },
});

const interactionReferenceSchema = z.strictObject({ id: z.string().min(1), contract: z.string().min(1) }).readonly();
const referenceCodec = codec<InteractionReference>(interactionReferenceSchema);
const referenceSchema = z.strictObject({ collection: z.string().min(1), id: z.string().min(1), revision: z.number().int().nonnegative() }).readonly();
const originSchema = z.strictObject({ collection: z.string().min(1), id: z.string().min(1), digest: z.string().min(1) }).readonly();

export interface ToolCompletion {
  readonly reference: InteractionReference;
  readonly reply: ModelReply;
}

export function createToolCompletion(checkpoint: boolean, catalog: ToolCatalog, budgets: ToolByteBudgets, waitMs: number, context?: ToolRequestContext) {
  const prefixCodec = codec<ToolModelInput>(
    z
      .strictObject({ origin: originSchema, exchanges: z.array(referenceSchema).readonly(), context: z.string().optional() })
      .readonly()
      .superRefine((value) => {
        assertToolContextText(value.context, context);
      }),
  );
  const toolReplyCodec = { encode: (value: ModelReply) => cloneCheckpointValue(assertToolReplyBytes(value, budgets)), decode: (value: unknown) => assertToolReplyBytes(requireModelReply(value), budgets) };
  const completionCodec = codec<ToolCompletion>(
    z
      .strictObject({
        reference: interactionReferenceSchema,
        reply: z.custom<ModelReply>((value) => {
          toolReplyCodec.decode(value);
          return true;
        }),
      })
      .readonly(),
  );
  const deps = { model: ToolModelResource.request(), exchanges: ModelExchangeResource.request() };
  type Work = NodeWork<ToolModelInput, ToolCompletion, ResourcesOf<typeof deps>> | ResumeWork<'node', ToolModelInput, ToolCompletion, ResourcesOf<typeof deps>>;
  function verify(work: Work): void {
    const origin = work.resources.exchanges.origin(work.input.origin);
    assertToolContextText(work.input.context, context);
    if (origin.catalog.digest !== catalog.digest || origin.catalog.policyVersion !== catalog.policyVersion || !isDeepStrictEqual(origin.catalog.tools, catalog.tools) || !isDeepStrictEqual(origin.catalog.imageContext, catalog.imageContext)) throw new ResourcePortError('Tool catalog differs from the fixed model origin', { cause: new RuntimeError('CHECKPOINT_CONTENT_CHANGED', 'Tool catalog differs from the fixed model origin') });
  }
  const point = checkpointPoint<'node', ToolModelInput, ToolCompletion>();
  const completed = point({
    name: 'completed',
    state: codec(
      z
        .strictObject({
          reference: interactionReferenceSchema,
          reply: z.custom<ModelReply>((value) => {
            toolReplyCodec.decode(value);
            return true;
          }),
        })
        .readonly(),
    ),
    references: {},
    resume: {
      deps,
      run: async (work, { reference, reply }) => {
        verify(work);
        await work.resources.model.confirm({ reference, basis: work.input, reply, budgets, ...(context ? { context } : {}) });
        return { reference, reply };
      },
    },
  });
  const established = point({
    name: 'established',
    state: referenceCodec,
    references: {},
    resume: {
      deps,
      run: async (work, reference) => {
        verify(work);
        await work.resources.model.confirm({ reference, basis: work.input, budgets, ...(context ? { context } : {}) });
        return receive(work, reference);
      },
    },
  });
  async function receive(work: Work, reference: InteractionReference): Promise<ToolCompletion> {
    const reply = await work.resources.model.wait({ reference, waitMs, maxReplyBytes: budgets.maxReplyBytes });
    work.checkpoint?.({ point: completed, state: { reference, reply }, refs: {} });
    return { reference, reply };
  }
  return new Node<ToolModelInput, ToolCompletion, ResourcesOf<typeof deps>>({
    name: 'tool-model-completion',
    deps,
    ...(checkpoint ? { checkpoint: { key: 'tool.completion', version: 3, input: prefixCodec, output: completionCodec, points: [established, completed] } } : {}),
    async run(work) {
      verify(work);
      const reference = await work.resources.model.start({ prefix: work.input, budgets, ...(context ? { context } : {}) });
      work.checkpoint?.({ point: established, state: reference, refs: {} });
      return receive(work, reference);
    },
  });
}
