import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { Group, checkpointPoint, childReference, type ChildCall, type GroupWork, type ResumeWork } from '@weiliang0121/capix-structure';
import { ResourceOffer, ResourcePortError, type ResourcesOf } from '@weiliang0121/capix-resources';
import { ModelExchangeResource } from '@weiliang0121/capix-model-exchanges';
import type { InteractionChannel } from '@weiliang0121/capix-interaction';
import type { ModelRequest, ModelReply, ModelRequestInspection } from '@weiliang0121/capix-model-provider';
import { Resources } from '@weiliang0121/capix-runtime';
import type { ConversationMaterialInput } from '../materials/input.js';
import { materialInputCodec } from '../recovery/model-codecs.js';
import { codec, stringCodec } from '../recovery/codecs.js';
import { defaultConversationOutputBudget, requireOutputTokens } from '../model/budget.js';
import { ToolLoop } from '../tools/loop.js';
import { toolAnswerRequest } from '../tools/answer.js';
import { ToolModelResource, type ToolInteractionRecovery } from '../tools/model.js';
import { ToolExchangeUse, type ToolExchangePlan, type ToolExchangeSelection } from './tool-exchanges.js';
import type { ExchangeArchiveMetadata } from '../persistence/exchanges.js';

export interface ToolHostOptions {
  readonly exchangeUse: ToolExchangeUse;
}
export interface ArchiveSource {
  readonly use: ToolExchangeUse;
  readonly basis: Omit<ExchangeArchiveMetadata, 'scope'>;
}
export const selectionSchema = z.strictObject({ collection: z.string().min(1), scope: z.string().min(1) }).readonly();
export const planSchema = z
  .strictObject({
    selection: selectionSchema,
    empty: z.strictObject({ formatVersion: z.literal(1), id: z.string().min(1), sequence: z.literal(0), entries: z.tuple([]).readonly() }).readonly(),
    metadata: z
      .strictObject({
        source: z.strictObject({ transcriptId: z.string().min(1), index: z.number().int().nonnegative() }).readonly(),
        scope: z.string().min(1),
        policy: z.record(z.string(), z.json()).readonly(),
        limits: z.strictObject({ entries: z.number().int().positive(), bytes: z.number().int().positive() }).readonly(),
      })
      .readonly(),
  })
  .readonly();
const archiveResource = new ResourceOffer({
  name: 'conversation.tools.archive',
  methods: {
    plan(source: ArchiveSource) {
      return source.use.plan(source.basis);
    },
    initializePrepared(source: ArchiveSource, plan: ToolExchangePlan) {
      if (!equal(plan.metadata, { ...source.basis, scope: plan.selection.scope })) throw changed('Tool allocation plan differs from its original materials');
      try {
        source.use.initializePrepared(plan);
      } catch (cause) {
        if (cause instanceof PersistenceError) throw cause;
        throw changed('Original tool allocation cannot be initialized', cause);
      }
    },
    acquireExisting(source: ArchiveSource, selection: ToolExchangeSelection) {
      try {
        source.use.acquireExisting(selection, { ...source.basis, scope: selection.scope });
      } catch (cause) {
        if (cause instanceof PersistenceError) throw cause;
        throw changed('Original tool exchange archive is unavailable', cause);
      }
    },
  },
});

/** Host preset: persist an empty allocation intent before creating the archive or the loop. */
export function createArchivedToolAnswer(loop: ToolLoop, maxTokens = defaultConversationOutputBudget.answer) {
  requireOutputTokens(maxTokens);
  const deps = { archive: archiveResource.request() };
  type Work = GroupWork<ConversationMaterialInput, string, ResourcesOf<typeof deps>, ToolLoop, string> | ResumeWork<'group', ConversationMaterialInput, string, ResourcesOf<typeof deps>, ToolLoop, string>;
  const point = checkpointPoint<'group', ConversationMaterialInput, string, string>();
  const expected = (input: ConversationMaterialInput, scope: string): ExchangeArchiveMetadata => ({ ...archiveBasis(loop, input, maxTokens), scope });
  const prepared = point({
    name: 'prepared',
    state: codec<ToolExchangePlan>(planSchema),
    references: {},
    check(plan, facts) {
      if (facts.round !== 1 || facts.children.values().length !== 0 || plan.empty.id !== plan.selection.collection || !equal(plan.metadata, expected(facts.input, plan.selection.scope))) throw new Error('Tool prepared checkpoint must describe its exact empty allocation');
    },
    resume: { deps, uses: [loop], run: (work, plan) => initialize(work, plan) },
  });
  const waiting = point({
    name: 'waiting',
    state: codec(selectionSchema),
    references: { loop: childReference(loop) },
    check(selection, facts) {
      const child = facts.references.loop;
      if (facts.children.values().length !== 1 || child.order !== 0 || child.returned || !equal(loop.checkInput(child.input), loop.input(toolAnswerRequest(facts.input, maxTokens), selection.scope, selection.collection))) throw new Error('Tool waiting checkpoint changed its selected archive or input');
    },
    resume: {
      deps,
      uses: [loop],
      async run(work, selection, refs) {
        await work.resources.archive.acquireExisting(selection);
        return receive(work, selection, work.children.resume(refs.loop));
      },
    },
  });
  const completed = point({
    name: 'completed',
    state: codec(z.strictObject({ selection: selectionSchema, value: z.string() }).readonly()),
    references: { loop: childReference(loop) },
    check({ selection, value }, facts) {
      const child = facts.references.loop;
      if (facts.children.values().length !== 1 || child.order !== 0 || !equal(loop.checkInput(child.input), loop.input(toolAnswerRequest(facts.input, maxTokens), selection.scope, selection.collection)) || child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted' || child.returned.output !== value || child.reception.value !== value) throw new Error('Tool answer differs from its accepted loop');
    },
    resume: { run: (_work, state) => state.value },
  });
  async function receive(work: Work, selection: ToolExchangeSelection, child: ChildCall<ToolLoop>): Promise<string> {
    const value = await child.invoke();
    work.checkpoint?.({ point: completed, state: { selection, value }, refs: { loop: child.ref } });
    return value;
  }
  async function initialize(work: Work, plan: ToolExchangePlan): Promise<string> {
    await work.resources.archive.initializePrepared(plan);
    const child = work.children.create(loop, loop.input(toolAnswerRequest(work.input, maxTokens), plan.selection.scope, plan.selection.collection));
    work.checkpoint?.({ point: waiting, state: plan.selection, refs: { loop: child.ref } });
    return receive(work, plan.selection, child);
  }
  const answer = new Group<ConversationMaterialInput, string, ResourcesOf<typeof deps>, string>({
    name: 'archived-tool-answer',
    deps,
    ...(loop.recoverable ? { checkpoint: { key: 'conversation.tools.archived-answer', version: 1, input: materialInputCodec, output: stringCodec, points: [prepared, waiting, completed] } } : {}),
  }).add({ loop });
  answer.run = async (work) => {
    const plan = await work.resources.archive.plan();
    work.checkpoint?.({ point: prepared, state: plan, refs: {} });
    return initialize(work, plan);
  };
  return answer;
}

export function registerArchivedToolResources<Options extends ToolHostOptions>(resources: Resources<Options>, answer: ReturnType<typeof createArchivedToolAnswer>, loop: ToolLoop, channel: InteractionChannel<ModelRequest, ModelReply, string>, inspectRequest: (request: ModelRequest) => ModelRequestInspection, recovery?: ToolInteractionRecovery, maxTokens = defaultConversationOutputBudget.answer) {
  if (typeof inspectRequest !== 'function') throw new TypeError('Tool host requires a pure provider request inspection');
  if (loop.recoverable && !recovery) throw new TypeError('Recoverable tools require the original interaction reader');
  const fixedRecovery = recovery ? Object.freeze({ read: recovery.read.bind(recovery) }) : undefined;
  // One capture fixes the material and local use for all answer-scoped resource supplies.
  const capture = resources.capture(answer, (input, options) => ({ use: options.exchangeUse, basis: archiveBasis(loop, input, maxTokens), input: materialInputCodec.decode(materialInputCodec.encode(input)) }));
  capture.register(archiveResource, (source) => source);
  resources
    .capture(loop, (input, options) => {
      const checked = loop.checkInput(input);
      if (!checked.collection) throw changed('Tool host input requires an exact archive selection');
      return { input: loop.input(checked.request, checked.scope, checked.collection), exchanges: options.exchangeUse.requireLoaded({ collection: checked.collection, scope: checked.scope }) };
    })
    .register(ModelExchangeResource, ({ input, exchanges }) => ({ exchanges, scope: input.scope }))
    .register(ToolModelResource, ({ input, exchanges }) => ({ input, exchanges, channel, catalog: loop.catalog, recovery: fixedRecovery, inspection: Object.freeze({ inspectRequest }) }));
  return capture;
}

export function archiveBasis(loop: ToolLoop, input: ConversationMaterialInput, maxTokens: number): Omit<ExchangeArchiveMetadata, 'scope'> {
  return {
    source: { transcriptId: input.query.transcriptId, index: input.query.index },
    policy: { catalog: loop.catalog.digest, maxModelCalls: loop.maxModelCalls, waitMs: loop.waitMs, maxTokens, budgets: { ...loop.budgets } },
    limits: { entries: loop.maxModelCalls, bytes: loop.budgets.maxCollectionBytes },
  };
}
function changed(message: string, cause?: unknown): ResourcePortError {
  return new ResourcePortError(message, { cause: new RuntimeError('CHECKPOINT_CONTENT_CHANGED', message, undefined, { cause }) });
}
