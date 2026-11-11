import { Interaction, type InteractionChannel, type InteractionReference, type InteractionState } from '@weiliang0121/capix-interaction';
import type { ModelReply, ModelRequest } from '@weiliang0121/capix-model-provider';
import { requireModelReply, requireModelRequest } from '@weiliang0121/capix-model-provider';
import { ModelExchangeResource, type ModelExchanges, type ExchangeReference, type ExchangePrefix } from '@weiliang0121/capix-model-exchanges';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { isDeepStrictEqual } from 'node:util';
import { ResourceOffer, ResourcePortError, type ResourceOperation, type ResourcesOf } from '@weiliang0121/capix-resources';
import { Node, checkpointPoint, type NodeWork, type ResumeWork } from '@weiliang0121/capix-structure';
import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import { z } from 'zod';
import { codec } from './codec.js';
import type { ToolCatalog } from './catalog.js';
import { assertToolReplyBytes, assertToolFeedbackBytes, assertToolRequestBytes, reserveToolReply, reserveToolFeedback, type ToolByteBudgets, type ToolRequestInspection } from './budget.js';

/** Host registration contains no per-call input or mutable Tool configuration. */
export interface ToolModelSource {
  readonly channel: InteractionChannel<ModelRequest, ModelReply, string>;
  readonly exchanges: ModelExchanges;
  readonly recovery?: ToolInteractionRecovery;
  readonly inspection?: ToolRequestInspection;
}
export interface ToolInteractionRecovery {
  read(id: string): InteractionState<ModelRequest, ModelReply> | undefined;
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

function request(source: ToolModelSource, prefix: ExchangePrefix, budgets: ToolByteBudgets): ModelRequest {
  const value = source.exchanges.request(prefix);
  assertToolRequestBytes(value, budgets, source.inspection);
  return value;
}

export const ToolModelResource = new ResourceOffer({
  name: 'tool.model',
  methods: {
    start(source: ToolModelSource, input: { readonly prefix: ExchangePrefix; readonly budgets: ToolByteBudgets }) {
      const value = request(source, input.prefix, input.budgets);
      // Full snapshot accounting is linear and includes every fixed origin.
      const snapshot = source.exchanges.snapshot();
      reserveToolReply(snapshot.entries, input.budgets, snapshot.origins);
      return source.channel.start(value);
    },
    preflight(source: ToolModelSource, input: ExchangePrefix & { readonly current: ExchangeReference; readonly budgets: ToolByteBudgets }) {
      const base = request(source, { origin: input.origin, exchanges: input.exchanges }, input.budgets);
      const current = source.exchanges.read(input.origin, input.current, false);
      assertToolReplyBytes(current.reply, input.budgets);
      // Validate that this is the next exchange after the exact closed prefix.
      const ordered = source.exchanges.values(input.origin);
      if (ordered[input.exchanges.length]?.id !== current.id) throw new Error('Tool exchange is not the next exchange in its origin');
      const calls = current.reply.output.filter((item) => item.kind === 'tool-call');
      const pending = calls.filter((call) => !current.feedback.some((item) => item.toolCallId === call.id));
      const placeholders = pending.map((call) => {
        const content: { kind: 'text'; text: string }[] = [{ kind: 'text', text: '' }];
        const result = assertToolFeedbackBytes(call.id, { status: 'ok', content }, input.budgets);
        // Reserve node-count overhead as well as bytes before dispatching effects.
        for (let count = 1; count < 32; count++) {
          const candidate = [...content, { kind: 'text', text: '' }];
          if (Buffer.byteLength(JSON.stringify({ toolCallId: call.id, status: 'ok', content: candidate })) > input.budgets.maxFeedbackBytes) break;
          content.push({ kind: 'text', text: '' });
        }
        return { toolCallId: call.id, ...result };
      });
      for (const feedback of current.feedback) assertToolFeedbackBytes(feedback.toolCallId, { status: feedback.status, content: feedback.content }, input.budgets);
      const snapshot = source.exchanges.snapshot();
      reserveToolFeedback(snapshot.entries, current, pending.length, input.budgets, snapshot.origins);
      const estimate = { ...base, exchanges: [...(base.exchanges ?? []), { reply: current.reply, feedback: [...current.feedback, ...placeholders] }] };
      assertToolRequestBytes(estimate, input.budgets, source.inspection, pending.length * input.budgets.maxFeedbackBytes);
    },
    confirm(source: ToolModelSource, input: { readonly reference: InteractionReference; readonly basis: ExchangePrefix; readonly reply?: ModelReply; readonly budgets: ToolByteBudgets }) {
      try {
        const saved = source.recovery?.read(input.reference.id);
        if (saved && typeof saved === 'object' && 'then' in saved) {
          void Promise.resolve(saved).catch(() => undefined);
          throw new TypeError('Tool interaction recovery read must be synchronous');
        }
        if (!saved) throw new Error('Original model request or durable feedback is unavailable');
        // Reuse Interaction's recovery admission, including delivery/revision and
        // feedback identity checks. Restoring creates no sender or persistence.
        const interaction = Interaction.restore<ModelRequest, ModelReply>(saved, { contract: { key: input.reference.contract, request: requireModelRequest, reply: requireModelReply } });
        const state = interaction.exportState();
        const received = interaction.read();
        if (state.id !== input.reference.id || received.kind !== 'received' || !isDeepStrictEqual(state.request, request(source, input.basis, input.budgets))) throw new Error('Original model request or durable feedback is unavailable');
        assertToolReplyBytes(received.feedback.payload, input.budgets);
        if (input.reply !== undefined && !isDeepStrictEqual(input.reply, received.feedback.payload)) throw new Error('Completed model reply differs from its durable interaction');
      } catch (cause) {
        if (cause instanceof PersistenceError) throw cause;
        throw new ResourcePortError('Tool recovery requires exact original model request and durable feedback; it will not resend', { cause: new RuntimeError('CHECKPOINT_CONTENT_CHANGED', 'Saved model interaction does not match the fixed request', undefined, { cause }) });
      }
    },
    async wait(source: ToolModelSource, input: { readonly reference: InteractionReference; readonly waitMs: number; readonly maxReplyBytes: number }, operation: ResourceOperation) {
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
const prefixCodec = codec<ExchangePrefix>(z.strictObject({ origin: originSchema, exchanges: z.array(referenceSchema).readonly() }).readonly());

export interface ToolCompletion {
  readonly reference: InteractionReference;
  readonly reply: ModelReply;
}

export function createToolCompletion(checkpoint: boolean, catalog: ToolCatalog, budgets: ToolByteBudgets, waitMs: number) {
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
  type Work = NodeWork<ExchangePrefix, ToolCompletion, ResourcesOf<typeof deps>> | ResumeWork<'node', ExchangePrefix, ToolCompletion, ResourcesOf<typeof deps>>;
  function verify(work: Work): void {
    const origin = work.resources.exchanges.origin(work.input.origin);
    if (origin.catalog.digest !== catalog.digest || origin.catalog.policyVersion !== catalog.policyVersion || !isDeepStrictEqual(origin.catalog.tools, catalog.tools)) throw new ResourcePortError('Tool catalog differs from the fixed model origin', { cause: new RuntimeError('CHECKPOINT_CONTENT_CHANGED', 'Tool catalog differs from the fixed model origin') });
  }
  const point = checkpointPoint<'node', ExchangePrefix, ToolCompletion>();
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
        await work.resources.model.confirm({ reference, basis: work.input, reply, budgets });
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
        await work.resources.model.confirm({ reference, basis: work.input, budgets });
        return receive(work, reference);
      },
    },
  });
  async function receive(work: Work, reference: InteractionReference): Promise<ToolCompletion> {
    const reply = await work.resources.model.wait({ reference, waitMs, maxReplyBytes: budgets.maxReplyBytes });
    work.checkpoint?.({ point: completed, state: { reference, reply }, refs: {} });
    return { reference, reply };
  }
  return new Node<ExchangePrefix, ToolCompletion, ResourcesOf<typeof deps>>({
    name: 'tool-model-completion',
    deps,
    ...(checkpoint ? { checkpoint: { key: 'tool.completion', version: 1, input: prefixCodec, output: completionCodec, points: [established, completed] } } : {}),
    async run(work) {
      verify(work);
      const reference = await work.resources.model.start({ prefix: work.input, budgets });
      work.checkpoint?.({ point: established, state: reference, refs: {} });
      return receive(work, reference);
    },
  });
}
