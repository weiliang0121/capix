import { utf8ByteLength } from '@weiliang0121/capix-platform/bytes';
import { randomUUID } from '@weiliang0121/capix-platform/identity';
import { isOpaqueObject } from '@weiliang0121/capix-platform/inspection';
import { equalData as equal } from '@weiliang0121/capix-platform/equal';
import type { ChildReceptionPermit } from '@weiliang0121/capix-contracts';
import { z } from 'zod';
import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import { maximumModelExchangeBytes, maximumModelWireRequestBytes, modelReplyText, requireModelRequest, type ModelToolCall } from '@weiliang0121/capix-model-provider';
import { ModelExchangeResource, requireModelImageContext, feedbackDigest, requireExchangeIntakeReceipt, requireExchangeFeedbackReceipt, type ExchangeReference, type ExchangeOriginReference } from '@weiliang0121/capix-model-exchanges';
import type { ResourcesOf } from '@weiliang0121/capix-resources';
import { Group, checkpointPoint, childReferences, reception, type ChildCallable, type ChildReference, type ChildCall, type GroupWork, type ResumeWork, type CheckpointFacts, type ChildReferenceSlot, type CheckpointSelection } from '@weiliang0121/capix-structure';
import { codec, stringCodec } from './codec.js';
import { createToolCompletion, ToolModelResource, type ToolCompletion } from './model.js';
import { createToolCatalog, selectTool, toolEntries, type ToolCatalog, type ToolSelection } from './catalog.js';
import type { ToolConfiguration, ToolInput, ToolMembers } from './types.js';
import { assertToolFeedbackBytes, assertToolReplyBytes, assertToolOutputBytes, resolveToolBudgets, ToolBudgetError, type ToolByteBudgets } from './budget.js';
import { assertToolContextText, requireToolRequestContext, type ToolCapacityBoundary } from './context.js';

const refSchema = z.strictObject({ collection: z.string().min(1), id: z.string().min(1), revision: z.number().int().nonnegative() }).readonly();
function inputCodecFor(catalog: ToolCatalog) {
  return codec<ToolInput>(
    z
      .strictObject({
        request: z.custom<ToolInput['request']>((value) => {
          if (value === null || typeof value !== 'object' || 'tools' in value || 'exchanges' in value) return false;
          requireModelRequest({ ...value, tools: catalog.tools });
          return true;
        }),
      })
      .readonly(),
  );
}
const preparedCodec = codec<Prepared>(z.strictObject({ id: z.string().min(1), catalog: z.string().min(1) }).readonly());
const originSchema = z.strictObject({ collection: z.string().min(1), id: z.string().min(1), digest: z.string().min(1) }).readonly();
interface Prepared {
  readonly id: string;
  readonly catalog: string;
}
const deps = { exchanges: ModelExchangeResource.request(), model: ToolModelResource.request() };
type ResourceValues = ResourcesOf<typeof deps>;
type Work = GroupWork<ToolInput, string, ResourceValues, ChildCallable> | ResumeWork<'group', ToolInput, string, ResourceValues, ChildCallable>;
type RestoredWork = ResumeWork<'group', ToolInput, string, ResourceValues, ChildCallable>;
type Refs = Readonly<Record<string, readonly ChildReference<ChildCallable>[] | CheckpointSelection<ChildCallable>>>;
type RestoredRefs = Readonly<Record<string, readonly ChildReference<ChildCallable>[]>>;
type Slots = Readonly<Record<string, ChildReferenceSlot<ChildCallable, true>>>;
interface State extends Prepared {
  readonly deferred: readonly ToolCapacityBoundary[];
  readonly origin: ExchangeOriginReference;
  readonly exchanges: readonly ExchangeReference[];
  readonly current: ExchangeReference | null;
  readonly cursor: number;
  readonly active: { readonly name: string; readonly index: number; readonly callId: string } | null;
}
const boundarySchema = z.strictObject({ reason: z.strictObject({ code: z.enum(['TOOL_REQUEST_LIMIT', 'TOOL_WIRE_REQUEST_LIMIT', 'TOOL_EXCHANGE_LIMIT']), bytes: z.number().int().positive(), limit: z.number().int().positive(), phase: z.literal('reserved') }).readonly(), origin: originSchema, exchange: refSchema, callIds: z.array(z.string().min(1)).nonempty().readonly() }).readonly();
function capacityFeedback(boundary: ToolCapacityBoundary) {
  return { status: 'error' as const, content: [{ kind: 'text' as const, text: JSON.stringify({ code: 'TOOL_CAPACITY_DEFERRED', message: 'Tool was not executed because the pending batch exceeds request capacity. Request fewer or smaller tool results.', stage: 'preflight', executed: false, reason: boundary.reason }) }] };
}
const stateCodec = codec<State>(z.strictObject({ id: z.string().min(1), catalog: z.string().min(1), origin: originSchema, deferred: z.array(boundarySchema).readonly(), exchanges: z.array(refSchema).readonly(), current: refSchema.nullable(), cursor: z.number().int().nonnegative(), active: z.strictObject({ name: z.string(), index: z.number().int().nonnegative(), callId: z.string() }).readonly().nullable() }).readonly());
const intakeCodec = { check: requireExchangeIntakeReceipt, encode: (value: ReturnType<typeof requireExchangeIntakeReceipt>) => cloneCheckpointValue(requireExchangeIntakeReceipt(value)), decode: requireExchangeIntakeReceipt };
const feedbackCodec = { check: requireExchangeFeedbackReceipt, encode: (value: ReturnType<typeof requireExchangeFeedbackReceipt>) => cloneCheckpointValue(requireExchangeFeedbackReceipt(value)), decode: requireExchangeFeedbackReceipt };
function refsAt(refs: Refs, name: string) {
  const value = refs[name];
  if (!value) throw new Error('Tool checkpoint references an unknown member');
  return value;
}
function referenceAt(refs: Refs, name: string, index: number) {
  const value = refsAt(refs, name).at(index);
  if (!value) throw new Error('Tool checkpoint references a missing child');
  return value;
}

/** Stops a Tool invocation before dispatching a model call beyond its configured limit. */
export class ToolModelCallLimitError extends Error {
  readonly code = 'TOOL_MODEL_CALL_LIMIT';
  constructor(
    readonly calls: number,
    readonly limit: number,
  ) {
    super(`TOOL_MODEL_CALL_LIMIT: ${calls} model calls reached limit ${limit}`);
    this.name = 'ToolModelCallLimitError';
  }
}

/** A normal Group preset. Only its optional checkpoint mode requires recoverable tools. */
export class Tool<const Definitions extends Readonly<Record<string, ChildCallable>>> extends Group<ToolInput, string, ResourceValues> {
  declare readonly run: NonNullable<Group<ToolInput, string, ResourceValues>['run']>;
  readonly tools: ToolMembers<Definitions>;
  readonly catalog: ToolCatalog;
  readonly maxModelCalls: number;
  readonly waitMs: number;
  readonly recoverable: boolean;
  readonly budgets: ToolByteBudgets;
  /** Exact structure identities for optional host stage projection, independent of recording. */
  readonly stages: { readonly model: string; readonly tools: readonly { readonly structureId: string; readonly name: string }[] };
  readonly checkToolCall: (call: ModelToolCall) => ToolSelection;

  constructor(configuration: ToolConfiguration<Definitions>) {
    const options = snapshotConfiguration(configuration);
    super({
      name: 'Tool',
      deps,
      output: {
        result: (value) => {
          if (typeof value !== 'string' || !value.trim()) throw new TypeError('Tool final answer must be nonempty');
          return value;
        },
      },
    });
    this.maxModelCalls = options.maxModelCalls === undefined ? 1000 : options.maxModelCalls;
    this.waitMs = options.waitMs === undefined ? 30_000 : options.waitMs;
    this.recoverable = options.checkpoint === true;
    this.budgets = resolveToolBudgets(options.budgets);
    if (!Number.isSafeInteger(this.maxModelCalls) || this.maxModelCalls < 1) throw new RangeError('Tool model call limit must be a positive safe integer');
    if (!Number.isSafeInteger(this.waitMs) || this.waitMs < 0 || this.waitMs > 2147483647) throw new RangeError('Tool wait must be a nonnegative timer duration');
    const entries = toolEntries(options.tools, this.recoverable, this.budgets.maxFeedbackBytes);
    this.tools = Object.freeze(Object.fromEntries(entries.map((entry) => [entry.name, entry.registration]))) as ToolMembers<Definitions>;
    Object.defineProperty(this, 'tools', { value: this.tools, enumerable: true, writable: false, configurable: false });
    const requestContext = options.requestContext;
    const capacityPolicy = options.capacityPolicy ?? 'fail';
    const catalog = (this.catalog = createToolCatalog(entries, options.policyVersion, { capacityPolicy, maxModelCalls: this.maxModelCalls, waitMs: this.waitMs, budgets: this.budgets, ...(options.imageContext === undefined ? {} : { imageContext: options.imageContext }), ...(requestContext ? { requestContext } : {}) }));
    this.checkToolCall = (call) => selectTool(entries, catalog, call);
    Object.defineProperty(this, 'checkToolCall', { value: this.checkToolCall, enumerable: false, writable: false, configurable: false });
    const inputCodec = inputCodecFor(catalog);
    for (const name of ['catalog', 'maxModelCalls', 'waitMs', 'recoverable', 'budgets'] as const) Object.defineProperty(this, name, { value: this[name], enumerable: true, writable: false, configurable: false });
    const budgets = this.budgets;
    const completion = createToolCompletion(this.recoverable, catalog, budgets, this.waitMs, requestContext);
    this.stages = Object.freeze({ model: completion.id, tools: Object.freeze(entries.map((entry) => Object.freeze({ structureId: entry.registration.node.id, name: entry.name }))) });
    Object.defineProperty(this, 'stages', { value: this.stages, enumerable: true, writable: false, configurable: false });
    const tools = new Map(entries.map((entry) => [entry.name, entry]));
    const modelReception = reception(completion, intakeCodec);
    const toolReceptions = new Map(entries.map((entry) => [entry.name, reception(entry.registration.node, feedbackCodec)]));
    const slots: Slots = Object.freeze(Object.fromEntries([['models', childReferences(completion)], ...entries.map((entry) => [entry.name, childReferences(entry.registration.node)])]));
    const members: readonly ChildCallable[] = Object.freeze([completion, ...entries.map((entry) => entry.registration.node)]);
    const maxModelCalls = this.maxModelCalls;
    const recoverable = this.recoverable;
    const point = checkpointPoint<'group', ToolInput, string>();
    const prepared = point({
      name: 'prepared',
      state: preparedCodec,
      references: slots,
      check: (state, facts) => {
        if (state.catalog !== catalog.digest || facts.children.values().length || Object.values(facts.references).some((refs) => refs.length)) throw new Error('Prepared Tool configuration or child relations changed');
      },
      resume: { deps, uses: members, run: (work, state, saved) => prepare(work, state, selections(work, saved)) },
    });
    const waiting = point({ name: 'model-waiting', state: stateCodec, references: slots, check, resume: { deps, uses: members, run: resumeModel } });
    const processing = point({ name: 'tools', state: stateCodec, references: slots, check, resume: { deps, uses: members, run: resumeTools } });
    const completed = point({
      name: 'completed',
      state: stateCodec,
      references: slots,
      check,
      resume: {
        deps,
        uses: members,
        run: async (work, state, refs) => {
          await confirmExchanges(work, state, refs);
          return finalText(work, state);
        },
      },
    });
    if (recoverable) this.checkpoint = { key: 'capix.tool', version: 5, input: inputCodec, output: stringCodec, receptions: [modelReception, ...toolReceptions.values()], points: [prepared, waiting, processing, completed] };
    const save = (work: Work, name: 'waiting' | 'processing' | 'completed', state: State, refs: Refs) => work.checkpoint?.({ point: name === 'waiting' ? waiting : name === 'processing' ? processing : completed, state, refs });
    // Selection ownership is the current invocation. Both points explicitly use
    // the same choices; normal calls without checkpoints keep ordinary arrays.
    const selections = (work: Work, saved?: RestoredRefs): Refs => Object.fromEntries(Object.entries(slots).map(([name, slot]) => [name, work.checkpoint ? work.checkpoint.select(slot.definition, saved?.[name]) : (saved?.[name] ?? [])]));
    const append = (refs: Refs, name: string, reference: ChildReference<ChildCallable>): Refs => {
      const selected = refsAt(refs, name);
      if ('add' in selected) {
        selected.add(reference);
        return refs;
      }
      return { ...refs, [name]: [...selected, reference] };
    };
    const toolReception = (name: string) => {
      const value = toolReceptions.get(name);
      if (!value) throw new Error('Tool reception is not registered');
      return value;
    };
    const modelFact = (facts: CheckpointFacts<ToolInput>['children'], ref: ChildReference) => facts.require(completion, ref);
    function check(state: State, facts: CheckpointFacts<ToolInput, Slots>) {
      if (state.catalog !== catalog.digest || state.id !== state.origin.id) throw new Error('Tool fixed catalog or budgets changed');
      const models = facts.references.models;
      if (!models || facts.children.values().length !== Object.values(facts.references).reduce((sum, values) => sum + values.length, 0)) throw new Error('Tool checkpoint omitted child relations');
      if (models.length !== state.exchanges.length + 1 || models.length > maxModelCalls) throw new Error('Tool model prefix changed');
      models.forEach((fact, index) => {
        const child = modelFact(facts.children, fact.ref);
        const { context, ...prefix } = child.input;
        assertToolContextText(context, requestContext);
        if (!equal(prefix, { origin: state.origin, exchanges: state.exchanges.slice(0, index) })) throw new Error('Model input differs from fixed exchange prefix');
        const expected = state.exchanges[index];
        if (expected) {
          const receipt = facts.children.accepted(child.ref, modelReception);
          if (receipt.reference.collection !== expected.collection || receipt.reference.id !== expected.id) throw new Error('Model reception differs from exchange prefix');
        }
      });
      const deferredIds = new Set<string>();
      for (const boundary of state.deferred) {
        const upperLimit = boundary.reason.code === 'TOOL_REQUEST_LIMIT' ? budgets.maxRequestBytes : boundary.reason.code === 'TOOL_WIRE_REQUEST_LIMIT' ? (budgets.maxWireRequestBytes ?? maximumModelWireRequestBytes) : maximumModelExchangeBytes;
        // The current provider's exact lower limit is checked against durable
        // model material during confirmExchanges, outside this facts-only window.
        if (capacityPolicy !== 'defer' || !equal(boundary.origin, state.origin) || boundary.reason.limit > upperLimit || boundary.reason.bytes <= boundary.reason.limit || new Set(boundary.callIds).size !== boundary.callIds.length || deferredIds.has(boundary.exchange.id)) throw new Error('Invalid saved capacity decision');
        deferredIds.add(boundary.exchange.id);
        const index = models.findIndex((model) => {
          const fact = modelFact(facts.children, model.ref);
          return fact.reception.status === 'accepted' && facts.children.accepted(fact.ref, modelReception).reference.id === boundary.exchange.id;
        });
        const model = models[index];
        if (!model) throw new Error('Deferred exchange has no model');
        const fact = modelFact(facts.children, model.ref);
        const receipt = facts.children.accepted(fact.ref, modelReception);
        if (boundary.exchange.collection !== receipt.reference.collection || boundary.exchange.revision < receipt.reference.revision || fact.returned?.status !== 'succeeded') throw new Error('Deferred exchange identity changed');
        const calls = fact.returned.output.reply.output.filter((item) => item.kind === 'tool-call');
        const pending = calls.slice(calls.length - boundary.callIds.length);
        if (
          !equal(
            pending.map((call) => call.id),
            boundary.callIds,
          )
        )
          throw new Error('Deferred calls are not an exact pending suffix');
        const end = models[index + 1]?.order ?? Infinity;
        for (const callId of boundary.callIds) {
          if (facts.children.values().some((child) => child.order > fact.order && child.order < end && child.key === callId)) throw new Error('Deferred call has a tool child');
        }
        if (state.current?.id === boundary.exchange.id && (state.active || state.cursor < calls.length - boundary.callIds.length)) throw new Error('Deferred cursor precedes decision');
      }
      if (!state.current) {
        if (state.active || state.cursor !== 0) throw new Error('Waiting model has tool progress');
        return;
      }
      const latest = models.at(-1);
      if (!latest) throw new Error('Current exchange lacks its model');
      const child = modelFact(facts.children, latest.ref);
      const received = facts.children.accepted(child.ref, modelReception);
      if (state.current.collection !== received.reference.collection || state.current.id !== received.reference.id || child.returned?.status !== 'succeeded') throw new Error('Current exchange differs from accepted model');
      const calls = child.returned.output.reply.output.filter((item) => item.kind === 'tool-call');
      if (state.cursor > calls.length) throw new Error('Tool cursor exceeds model requests');
      for (let index = 0; index < state.cursor; index++) {
        const call = calls[index]!;
        if (state.deferred.some((boundary) => boundary.exchange.id === state.current!.id && boundary.callIds.includes(call.id))) continue;
        const selected = selectTool(entries, catalog, call);
        if (selected.kind === 'rejected') continue;
        const found = facts.references[selected.entry.name]?.find((fact) => fact.order > child.order && fact.key === call.id && equal(fact.input, selected.input));
        if (!found) throw new Error('Processed tool has no exact child');
        const receipt = found.reception.status === 'accepted' ? facts.children.accepted(found.ref, toolReception(selected.entry.name)) : facts.children.handled(found.ref, toolReception(selected.entry.name));
        if (receipt.reference.collection !== state.current.collection || receipt.reference.id !== state.current.id) throw new Error('Tool receipt belongs to another exchange');
      }
      if (state.active) {
        const call = calls[state.cursor];
        const relation = facts.references[state.active.name]?.[state.active.index];
        const selected = call && selectTool(entries, catalog, call);
        if (!call || selected?.kind !== 'accepted' || selected.entry.name !== state.active.name || call.id !== state.active.callId || !relation || relation.order <= child.order || relation.key !== call.id || !equal(relation.input, selected.input)) throw new Error('Active tool differs from fixed model request');
      }
    }
    async function receiveModel(work: Work, state: State, refs: Refs, child: ChildCall<typeof completion>): Promise<string> {
      const result = { succeeded: ({ reply }: ToolCompletion, permit: ChildReceptionPermit) => work.resources.exchanges.intake(state.origin, assertToolReplyBytes(reply, budgets), permit) };
      const received = recoverable ? await child.invoke({ reception: modelReception, result }) : await child.invoke({ result });
      const next: State = { ...state, current: received.reference, cursor: 0, active: null };
      save(work, 'processing', next, refs);
      return processTools(work, next, refs);
    }
    async function startModel(work: Work, state: State, refs: Refs): Promise<string> {
      const models = refsAt(refs, 'models');
      if (models.length >= maxModelCalls) throw new ToolModelCallLimitError(models.length, maxModelCalls);
      verifyOrigin(work, state);
      const prefix = { origin: state.origin, exchanges: state.exchanges };
      const deferred = state.deferred.find((boundary) => boundary.exchange.id === state.exchanges.at(-1)?.id);
      const boundary = deferred ? { ...deferred, exchange: state.exchanges.at(-1)! } : undefined;
      const context = requestContext ? await work.resources.model.prepare({ prefix, context: requestContext, ...(boundary ? { boundary } : {}) }) : undefined;
      const child = work.children.create(completion, { ...prefix, ...(context === undefined ? {} : { context }) }, { key: `model:${models.length}` });
      const nextRefs = append(refs, 'models', child.ref);
      save(work, 'waiting', state, nextRefs);
      return receiveModel(work, state, nextRefs, child);
    }
    async function resumeModel(work: RestoredWork, state: State, saved: RestoredRefs): Promise<string> {
      const refs = selections(work, saved);
      await confirmExchanges(work, state, refs);
      const child = modelFact(work.children.facts, referenceAt(refs, 'models', refsAt(refs, 'models').length - 1));
      if (child.reception.status === 'accepted') {
        const receipt = work.children.facts.accepted(child.ref, modelReception);
        return processTools(work, { ...state, current: receipt.reference, cursor: 0, active: null }, refs);
      }
      return receiveModel(work, state, refs, work.children.resume(child.ref));
    }
    async function receiveTool(work: Work, state: State, refs: Refs, child: ChildCall<ChildCallable>): Promise<string> {
      if (!state.current || !state.active) throw new Error('Missing active tool state');
      const active = state.active;
      const reference = state.current;
      const entry = tools.get(active.name);
      if (!entry) throw new Error('Tool is not registered');
      const result = {
        succeeded: async (value: unknown, permit: ChildReceptionPermit) => {
          if (entry.registration.maxOutputBytes !== undefined) assertToolOutputBytes(value, entry.registration.maxOutputBytes);
          const mapped = assertToolFeedbackBytes(active.callId, await entry.registration.result.succeeded(value), { maxFeedbackBytes: entry.registration.maxFeedbackBytes ?? budgets.maxFeedbackBytes });
          return work.resources.exchanges.receive(state.origin, reference, active.callId, mapped, permit);
        },
        ...(entry.registration.result.failed
          ? {
              failed: async (failure: unknown, permit: ChildReceptionPermit) => {
                // This preset stops on its own budget failures. This is not a new
                // kernel error category and a matching business code is not enough.
                if (failure instanceof ToolBudgetError) throw failure;
                return work.resources.exchanges.receive(state.origin, reference, active.callId, assertToolFeedbackBytes(active.callId, await entry.registration.result.failed!(failure), { maxFeedbackBytes: entry.registration.maxFeedbackBytes ?? budgets.maxFeedbackBytes }), permit);
              },
            }
          : {}),
      };
      const receipt = recoverable ? await child.invoke({ reception: toolReception(active.name), result }) : await child.invoke({ result });
      const next: State = { ...state, current: receipt.reference, cursor: state.cursor + 1, active: null };
      save(work, 'processing', next, refs);
      return processTools(work, next, refs);
    }
    async function resumeTools(work: RestoredWork, state: State, saved: RestoredRefs): Promise<string> {
      const refs = selections(work, saved);
      await confirmExchanges(work, state, refs);
      if (!state.active) return processTools(work, state, refs);
      const ref = referenceAt(refs, state.active.name, state.active.index);
      const fact = work.children.facts.get(ref);
      if (fact.reception.status === 'accepted' || fact.reception.status === 'handled') {
        const receipt = fact.reception.status === 'accepted' ? work.children.facts.accepted(ref, toolReception(state.active.name)) : work.children.facts.handled(ref, toolReception(state.active.name));
        return processTools(work, { ...state, current: receipt.reference, cursor: state.cursor + 1, active: null }, refs);
      }
      // An existing relation cannot be reclassified as unexecuted. If resuming
      // it can still run member code, require today's route and reservation first.
      if (!fact.returned && state.current) {
        const entry = work.resources.exchanges.read(state.origin, state.current, false);
        const calls = entry.reply.output.filter((item) => item.kind === 'tool-call');
        await preflight(
          work,
          state,
          state.current,
          calls,
          calls.map((call) => selectTool(entries, catalog, call)),
          false,
        );
      }
      return receiveTool(work, state, refs, work.children.resume(ref));
    }
    async function confirmExchanges(work: RestoredWork, state: State, refs: Refs) {
      verifyOrigin(work, state);
      const modelRefs = Array.from(refsAt(refs, 'models'));
      for (const [index, ref] of modelRefs.entries()) {
        const fact = modelFact(work.children.facts, ref);
        if (fact.reception.status !== 'accepted') continue;
        const receipt = work.children.facts.accepted(fact.ref, modelReception);
        const entry = work.resources.exchanges.read(state.origin, receipt.reference, false);
        assertToolReplyBytes(entry.reply, budgets);
        if (fact.returned?.status !== 'succeeded' || !equal(entry.reply, fact.returned.output.reply) || !equal(entry.operation, receipt.operation)) throw new Error('Exchange differs from original model return or reception');
        const deferred = state.deferred.find((boundary) => boundary.exchange.id === entry.id);
        await work.resources.model.confirm({ reference: fact.returned.output.reference, basis: fact.input, reply: fact.returned.output.reply, budgets, ...(requestContext ? { context: requestContext } : {}), ...(deferred ? { capacity: deferred.reason } : {}) });
        const next = modelRefs[index + 1];
        const end = next ? work.children.facts.get(next).order : Infinity;
        if (deferred) {
          const calls = entry.reply.output.filter((item) => item.kind === 'tool-call');
          for (const callId of deferred.callIds) {
            const position = calls.findIndex((call) => call.id === callId);
            if ((state.current?.id !== entry.id || position < state.cursor) && !entry.feedback.some((feedback) => feedback.toolCallId === callId)) throw new Error('Saved deferred progress has no feedback');
          }
        }
        for (const feedback of entry.feedback) {
          assertToolFeedbackBytes(feedback.toolCallId, { status: feedback.status, content: feedback.content }, budgets);
          const call = entry.reply.output.find((item) => item.kind === 'tool-call' && item.id === feedback.toolCallId);
          if (!call || call.kind !== 'tool-call') throw new Error('Feedback has no original model call');
          const boundary = state.deferred.find((boundary) => boundary.exchange.id === entry.id && boundary.callIds.includes(call.id));
          if (boundary) {
            if (!equal(feedback, { toolCallId: call.id, ...capacityFeedback(boundary) }) || entry.receptions.some((receipt) => receipt.callId === call.id) || work.children.facts.values().some((child) => child.order > fact.order && child.order < end && child.key === call.id)) throw new Error('Deferred feedback differs from fixed capacity decision');
            assertToolFeedbackBytes(call.id, capacityFeedback(boundary), { maxFeedbackBytes: tools.get(call.name)?.registration.maxFeedbackBytes ?? budgets.maxFeedbackBytes });
            continue;
          }
          const selected = selectTool(entries, catalog, call);
          assertToolFeedbackBytes(feedback.toolCallId, { status: feedback.status, content: feedback.content }, { maxFeedbackBytes: tools.get(call.name)?.registration.maxFeedbackBytes ?? budgets.maxFeedbackBytes });
          if (selected.kind === 'rejected') {
            if (!equal(feedback, { toolCallId: call.id, ...selected.result }) || entry.receptions.some((receipt) => receipt.callId === call.id)) throw new Error('Precheck feedback differs from fixed policy');
            continue;
          }
          const child = Array.from(refsAt(refs, selected.entry.name))
            .map((ref) => work.children.facts.get(ref))
            .find((child) => child.order > fact.order && child.order < end && child.key === call.id && equal(child.input, selected.input));
          if (!child) throw new Error('Feedback has no exact tool child');
          if (child.returned?.status === 'succeeded' && selected.entry.registration.maxOutputBytes !== undefined) assertToolOutputBytes(child.returned.output, selected.entry.registration.maxOutputBytes);
          if (child.reception.status !== 'accepted' && child.reception.status !== 'handled') continue;
          const prior = child.reception.status === 'accepted' ? work.children.facts.accepted(child.ref, toolReception(selected.entry.name)) : work.children.facts.handled(child.ref, toolReception(selected.entry.name));
          if (prior.reference.collection !== receipt.reference.collection || prior.reference.id !== receipt.reference.id || prior.feedbackDigest !== feedbackDigest(feedback) || !equal(prior.operation, entry.receptions.find((item) => item.callId === call.id)?.operation)) throw new Error('Feedback differs from original tool reception');
        }
      }
      // Every saved reception needs its entity effect, including receipts whose
      // slot was removed from an otherwise well-formed restored snapshot.
      for (const entry of entries) {
        for (const ref of refsAt(refs, entry.name)) {
          const child = work.children.facts.require(entry.registration.node, ref);
          if (child.reception.status !== 'accepted' && child.reception.status !== 'handled') continue;
          const receipt = child.reception.status === 'accepted' ? work.children.facts.accepted(ref, toolReception(entry.name)) : work.children.facts.handled(ref, toolReception(entry.name));
          const exchange = work.resources.exchanges.read(state.origin, receipt.reference, false);
          const feedback = exchange.feedback.find((feedback) => feedback.toolCallId === child.key);
          if (!feedback || receipt.feedbackDigest !== feedbackDigest(feedback) || !equal(receipt.operation, exchange.receptions.find((reception) => reception.callId === child.key)?.operation)) throw new Error('Saved tool reception has no exact exchange feedback');
        }
      }
    }
    function finalText(work: Work, state: State): string {
      if (!state.current) throw new Error('Missing final model exchange');
      const reply = work.resources.exchanges.read(state.origin, state.current, false).reply;
      if (reply.output.some((item) => item.kind === 'tool-call')) throw new Error('Tool final reply still contains tool calls');
      if (reply.termination.kind !== 'completed') throw new Error('Incomplete model reply cannot finish Tool');
      const text = modelReplyText(reply);
      if (!text.trim()) throw new Error('Tool final answer is empty');
      return text;
    }
    function preflight(work: Work, state: State, current: ExchangeReference, calls: readonly ModelToolCall[], selectedCalls: readonly ToolSelection[], defer: boolean) {
      const feedbackReservations = calls.map((call, index) => {
        const selected = selectedCalls[index]!;
        const maxBytes = tools.get(call.name)?.registration.maxFeedbackBytes ?? budgets.maxFeedbackBytes;
        if (selected.kind === 'accepted') return { toolCallId: call.id, maxBytes };
        assertToolFeedbackBytes(call.id, selected.result, { maxFeedbackBytes: maxBytes });
        return { toolCallId: call.id, maxBytes: utf8ByteLength(JSON.stringify({ toolCallId: call.id, ...selected.result })), fixed: selected.result };
      });
      return work.resources.model.preflight({ feedbackReservations, origin: state.origin, exchanges: state.exchanges, current, budgets, defer, ...(requestContext ? { context: requestContext } : {}) });
    }
    async function processTools(work: Work, initial: State, refs: Refs): Promise<string> {
      let state = initial;
      if (!state.current) throw new Error('Missing model exchange');
      verifyOrigin(work, state);
      const entry = work.resources.exchanges.read(state.origin, state.current, false);
      if (entry.reply.termination.kind !== 'completed') throw new Error('Incomplete model reply cannot execute tools');
      const calls = entry.reply.output.filter((item) => item.kind === 'tool-call');
      if (!calls.length) {
        const value = finalText(work, state);
        save(work, 'completed', state, refs);
        return value;
      }
      const selectedCalls = calls.map((call) => selectTool(entries, catalog, call));
      const savedBoundary = state.deferred.find((boundary) => boundary.exchange.id === entry.id);
      let boundary = savedBoundary;
      if (state.cursor < calls.length && !boundary) {
        const reason = await preflight(work, state, state.current, calls, selectedCalls, capacityPolicy === 'defer');
        if (reason) {
          const pending = calls.slice(state.cursor);
          if (pending.some((call) => entry.feedback.some((feedback) => feedback.toolCallId === call.id))) throw new Error('Pending capacity calls already have feedback');
          boundary = { reason, origin: state.origin, exchange: state.current, callIds: pending.map((call) => call.id) };
          const feedback = pending.map((call) => ({ toolCallId: call.id, result: assertToolFeedbackBytes(call.id, capacityFeedback(boundary!), { maxFeedbackBytes: tools.get(call.name)?.registration.maxFeedbackBytes ?? budgets.maxFeedbackBytes }) }));
          await work.resources.model.closure({ origin: state.origin, exchanges: state.exchanges, current: state.current, feedback, budgets });
          state = { ...state, deferred: [...state.deferred, boundary] };
          save(work, 'processing', state, refs);
        }
      }
      if (savedBoundary && state.cursor < calls.length) {
        const feedback = calls
          .slice(state.cursor)
          .filter((call) => !entry.feedback.some((feedback) => feedback.toolCallId === call.id))
          .map((call) => ({ toolCallId: call.id, result: assertToolFeedbackBytes(call.id, capacityFeedback(boundary!), { maxFeedbackBytes: tools.get(call.name)?.registration.maxFeedbackBytes ?? budgets.maxFeedbackBytes }) }));
        await work.resources.model.closure({ origin: state.origin, exchanges: state.exchanges, current: state.current!, feedback, budgets });
      }
      while (state.cursor < calls.length) {
        const call = calls[state.cursor]!;
        const selected = selectedCalls[state.cursor]!;
        if (boundary?.callIds.includes(call.id) || selected.kind === 'rejected') {
          const result = boundary?.callIds.includes(call.id) ? capacityFeedback(boundary) : (selected as Extract<ToolSelection, { kind: 'rejected' }>).result;
          const current = work.resources.exchanges.complete(state.origin, state.current!, call.id, assertToolFeedbackBytes(call.id, result, { maxFeedbackBytes: tools.get(call.name)?.registration.maxFeedbackBytes ?? budgets.maxFeedbackBytes }));
          state = { ...state, current, cursor: state.cursor + 1 };
          save(work, 'processing', state, refs);
          continue;
        }
        const name = selected.entry.name;
        const child = work.children.create(selected.entry.registration.node, selected.input, { key: call.id });
        const currentRefs = refsAt(refs, name);
        const active = { name, index: currentRefs.length, callId: call.id };
        const nextRefs = append(refs, name, child.ref);
        const next = { ...state, active };
        save(work, 'processing', next, nextRefs);
        return receiveTool(work, next, nextRefs, child);
      }
      const exchanges = [...state.exchanges, state.current!];
      work.resources.exchanges.closed(state.origin, exchanges);
      return startModel(work, { ...state, exchanges, current: null, cursor: 0, active: null }, refs);
    }
    function prepare(work: Work, state: Prepared, refs: Refs): Promise<string> {
      if (state.catalog !== catalog.digest) throw new Error('Tool fixed catalog or policy changed');
      const origin = work.resources.exchanges.begin(state.id, { request: work.input.request, catalog });
      return startModel(work, { ...state, origin, deferred: [], exchanges: [], current: null, cursor: 0, active: null }, refs);
    }
    function verifyOrigin(work: Work, state: State) {
      const origin = work.resources.exchanges.origin(state.origin);
      if (state.catalog !== catalog.digest || state.id !== origin.id || !equal(origin.request, work.input.request) || !equal(origin.catalog, catalog)) throw new Error('Tool fixed origin differs from its input or execution catalog');
      work.resources.exchanges.closed(state.origin, state.exchanges);
    }
    const run: NonNullable<Group<ToolInput, string, ResourceValues>['run']> = (work) => {
      inputCodec.encode(work.input);
      const state: Prepared = { id: randomUUID(), catalog: catalog.digest };
      const refs = selections(work);
      work.checkpoint?.({ point: prepared, state, refs });
      return prepare(work, state, refs);
    };
    Object.defineProperty(this, 'run', { get: () => run, enumerable: true, configurable: true });
    // Validate the complete configuration before claiming any supplied structure.
    this.add(...members);
  }
}

function snapshotConfiguration<Definitions extends Readonly<Record<string, ChildCallable>>>(value: ToolConfiguration<Definitions>): ToolConfiguration<Definitions> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isOpaqueObject(value)) throw new TypeError('Tool configuration must be a data object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.keys(descriptors).some((key) => !['tools', 'policyVersion', 'checkpoint', 'maxModelCalls', 'waitMs', 'budgets', 'imageContext', 'requestContext', 'capacityPolicy'].includes(key))) throw new TypeError('Unknown Tool configuration field');
  const result: Record<string, unknown> = {};
  for (const key of ['tools', 'policyVersion', 'checkpoint', 'maxModelCalls', 'waitMs', 'budgets', 'imageContext', 'requestContext', 'capacityPolicy']) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if ((!field && key in value) || (field && !('value' in field))) throw new TypeError('Tool configuration must use own data properties');
    if (field && !field.enumerable) throw new TypeError('Tool configuration fields must be enumerable');
    if (field) result[key] = field.value;
  }
  if (result.capacityPolicy !== undefined && result.capacityPolicy !== 'fail' && result.capacityPolicy !== 'defer') throw new TypeError('Invalid Tool capacity policy');
  if (result.checkpoint !== undefined && typeof result.checkpoint !== 'boolean') throw new TypeError('Tool checkpoint must be boolean');
  if (result.imageContext !== undefined) result.imageContext = requireModelImageContext(result.imageContext);
  if (result.requestContext !== undefined) result.requestContext = requireToolRequestContext(result.requestContext);
  if (result.budgets !== undefined) {
    const budgets = result.budgets;
    if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets) || isOpaqueObject(budgets) || Object.getOwnPropertySymbols(budgets).length) throw new TypeError('Tool budgets must be a data object');
    const snapshot: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(budgets))) {
      if (!['maxReplyBytes', 'maxFeedbackBytes', 'maxRequestBytes', 'maxWireRequestBytes', 'maxCollectionBytes'].includes(key) || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Tool budgets must contain known data properties');
      snapshot[key] = descriptor.value;
    }
    result.budgets = Object.freeze(snapshot);
  }
  return Object.freeze(result) as unknown as ToolConfiguration<Definitions>;
}
