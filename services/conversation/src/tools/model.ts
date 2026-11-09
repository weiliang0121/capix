import type { InteractionChannel, InteractionReference, InteractionState } from '@weiliang0121/capix-interaction';
import type { ModelReply, ModelRequest } from '@weiliang0121/capix-model-provider';
import { requireModelReply, requireModelRequest } from '@weiliang0121/capix-model-provider';
import type { ModelExchanges, ExchangeReference } from '@weiliang0121/capix-model-exchanges';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { isDeepStrictEqual } from 'node:util';
import { ResourceOffer, ResourcePortError, type ResourceOperation, type ResourcesOf } from '@weiliang0121/capix-resources';
import { Node, checkpointPoint, type NodeWork, type ResumeWork } from '@weiliang0121/capix-structure';
import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import { z } from 'zod';
import { codec } from '../recovery/codecs.js';
import { waitModelFeedback } from '../model/feedback.js';
import { ModelReplyPending } from '../model/pending.js';
import type { ToolLoopInput } from './types.js';
import type { ToolCatalog } from './catalog.js';
import { assertToolReplyBytes, assertToolFeedbackBytes, assertToolRequestBytes, reserveToolReply, reserveToolFeedback, type ToolByteBudgets, type ToolRequestInspection } from './budget.js';

export interface ToolModelSource {
  readonly channel: InteractionChannel<ModelRequest, ModelReply, string>;
  readonly exchanges: ModelExchanges;
  readonly input: ToolLoopInput;
  readonly catalog: ToolCatalog;
  readonly recovery?: ToolInteractionRecovery;
  readonly inspection?: ToolRequestInspection;
}
export interface ToolInteractionRecovery {
  read(id: string): InteractionState<ModelRequest, ModelReply> | undefined;
}
export function buildToolModelRequest(source: Pick<ToolModelSource, 'input' | 'catalog' | 'exchanges' | 'inspection'>, next: ToolModelInput): ModelRequest {
  if (source.input.catalog !== source.catalog.digest) throw new Error('Tool directory changed before model dispatch');
  if (source.input.collection !== undefined && source.input.collection !== source.exchanges.id) throw new Error('Tool exchange collection differs from the fixed input');
  const exchanges = source.exchanges.closed(source.input.scope, next.exchanges).map((entry) => ({ reply: entry.reply, feedback: entry.feedback }));
  const value = requireModelRequest({ ...source.input.request, stream: false, responseFormat: 'text', exchanges, tools: source.catalog.tools });
  assertToolRequestBytes(value, source.input.budgets, source.inspection);
  return value;
}
export const ToolModelResource = new ResourceOffer({
  name: 'conversation.tools.model',
  methods: {
    start(source: ToolModelSource, next: ToolModelInput) {
      const value = buildToolModelRequest(source, next);
      reserveToolReply(source.exchanges.values(), source.input.budgets);
      return source.channel.start(value);
    },
    preflight(source: ToolModelSource, input: { readonly exchanges: readonly ExchangeReference[]; readonly current: ExchangeReference }) {
      const base = buildToolModelRequest(source, { exchanges: input.exchanges });
      const current = source.exchanges.read(source.input.scope, input.current, false);
      assertToolReplyBytes(current.reply, source.input.budgets);
      const calls = current.reply.output.filter((item) => item.kind === 'tool-call');
      const pending = calls.filter((call) => !current.feedback.some((item) => item.toolCallId === call.id));
      const placeholders = pending.map((call) => {
        const content: { kind: 'text'; text: string }[] = [{ kind: 'text', text: '' }];
        const result = assertToolFeedbackBytes(call.id, { status: 'ok', content }, source.input.budgets);
        // Empty blocks maximize JSON structure within this byte budget. A one-block
        // placeholder would undercount the provider's separate 100,000-node bound.
        for (let count = 1; count < 32; count++) {
          const candidate = [...content, { kind: 'text', text: '' }];
          if (Buffer.byteLength(JSON.stringify({ toolCallId: call.id, status: 'ok', content: candidate })) > source.input.budgets.maxFeedbackBytes) break;
          content.push({ kind: 'text', text: '' });
        }
        return { toolCallId: call.id, ...result };
      });
      for (const feedback of current.feedback) assertToolFeedbackBytes(feedback.toolCallId, { status: feedback.status, content: feedback.content }, source.input.budgets);
      reserveToolFeedback(source.exchanges.values(), current, pending.length, source.input.budgets);
      // A legal complete exchange is inspected without storing placeholder feedback.
      // Reserve complete feedback JSON, including its identity, beyond this baseline.
      const estimate = { ...base, exchanges: [...(base.exchanges ?? []), { reply: current.reply, feedback: [...current.feedback, ...placeholders] }] };
      assertToolRequestBytes(estimate, source.input.budgets, source.inspection, pending.length * source.input.budgets.maxFeedbackBytes);
    },
    confirm(source: ToolModelSource, input: { readonly reference: InteractionReference; readonly basis: ToolModelInput; readonly reply?: ModelReply }) {
      try {
        const saved = source.recovery?.read(input.reference.id);
        if (!saved || saved.id !== input.reference.id || saved.contract !== input.reference.contract || !saved.feedback || !isDeepStrictEqual(requireModelRequest(saved.request), buildToolModelRequest(source, input.basis))) throw new Error('Original model request or durable feedback is unavailable');
        assertToolReplyBytes(saved.feedback.payload, source.input.budgets);
        if (input.reply !== undefined && !isDeepStrictEqual(input.reply, saved.feedback.payload)) throw new Error('Completed model reply differs from its durable interaction');
      } catch (cause) {
        if (cause instanceof PersistenceError) throw cause;
        throw new ResourcePortError('ToolLoop recovery requires exact original model request and durable feedback; it will not resend', { cause: new RuntimeError('CHECKPOINT_CONTENT_CHANGED', 'Saved model interaction does not match the fixed request', undefined, { cause }) });
      }
    },
    async wait(source: ToolModelSource, reference: InteractionReference, operation: ResourceOperation) {
      const result = await waitModelFeedback(source.channel, { reference, waitMs: source.input.waitMs }, operation);
      if (result.kind === 'unavailable') throw result.error;
      if (result.kind !== 'received') throw new ModelReplyPending(reference);
      return assertToolReplyBytes(result.feedback.payload, source.input.budgets);
    },
  },
});
export interface ToolModelInput {
  readonly exchanges: readonly ExchangeReference[];
}
const interactionReferenceSchema = z.strictObject({ id: z.string().min(1), contract: z.string().min(1) }).readonly();
const referenceCodec = codec<InteractionReference>(interactionReferenceSchema);
const reference = z.strictObject({ collection: z.string().min(1), id: z.string().min(1), revision: z.number().int().nonnegative() }).readonly();
export const toolModelInputCodec = codec<ToolModelInput>(z.strictObject({ exchanges: z.array(reference).readonly() }).readonly());
export function createToolCompletion(checkpoint: boolean, budgets: ToolByteBudgets) {
  const toolReplyCodec = { encode: (value: ModelReply) => cloneCheckpointValue(assertToolReplyBytes(value, budgets)), decode: (value: unknown) => assertToolReplyBytes(requireModelReply(value), budgets) };
  const deps = { model: ToolModelResource.request() };
  type Work = NodeWork<ToolModelInput, ModelReply, ResourcesOf<typeof deps>> | ResumeWork<'node', ToolModelInput, ModelReply, ResourcesOf<typeof deps>>;
  const point = checkpointPoint<'node', ToolModelInput, ModelReply>();
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
        await work.resources.model.confirm({ reference, basis: work.input, reply });
        return reply;
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
        await work.resources.model.confirm({ reference, basis: work.input });
        return receive(work, reference);
      },
    },
  });
  async function receive(work: Work, reference: InteractionReference): Promise<ModelReply> {
    const reply = await work.resources.model.wait(reference);
    work.checkpoint?.({ point: completed, state: { reference, reply }, refs: {} });
    return reply;
  }
  return new Node<ToolModelInput, ModelReply, ResourcesOf<typeof deps>>({
    name: 'tools-model-completion',
    deps,
    ...(checkpoint ? { checkpoint: { key: 'conversation.tools.completion', version: 3, input: toolModelInputCodec, output: toolReplyCodec, points: [established, completed] } } : {}),
    async run(work) {
      const reference = await work.resources.model.start(work.input);
      work.checkpoint?.({ point: established, state: reference, refs: {} });
      return receive(work, reference);
    },
  });
}
