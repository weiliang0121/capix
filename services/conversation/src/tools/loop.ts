import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import { modelReplyText, requireModelRequest, type ModelReply, type ModelToolCall } from '@weiliang0121/capix-model-provider';
import { ModelExchangeResource, feedbackDigest, requireExchangeIntakeReceipt, requireExchangeFeedbackReceipt, type ExchangeReference } from '@weiliang0121/capix-model-exchanges';
import type { ResourcesOf } from '@weiliang0121/capix-resources';
import { Group, checkpointPoint, childReferences, reception, type ChildCallable, type ChildReference, type ChildCall, type GroupWork, type ResumeWork, type CheckpointFacts, type ChildReferenceSlot, type CheckpointSelection } from '@weiliang0121/capix-structure';
import { codec, stringCodec } from '../recovery/codecs.js';
import { createToolCompletion, ToolModelResource } from './model.js';
import { createToolCatalog, selectTool, type ToolCatalog, type ToolSelection } from './catalog.js';
import { toolEntries } from './registration.js';
import type { ToolLoopOptions, ToolLoopInput, ToolBaseRequest } from './types.js';
import { assertToolFeedbackBytes, assertToolReplyBytes, assertToolOutputBytes, resolveToolBudgets, ToolBudgetError, type ToolByteBudgets } from './budget.js';

const refSchema = z.strictObject({ collection: z.string().min(1), id: z.string().min(1), revision: z.number().int().nonnegative() }).readonly();
export const toolLoopInputCodec = codec<ToolLoopInput>(
  z
    .strictObject({
      scope: z
        .string()
        .min(1)
        .max(512)
        .refine((value) => !!value.trim()),
      collection: z
        .string()
        .min(1)
        .max(512)
        .refine((value) => !!value.trim())
        .optional(),
      request: z.custom<ToolBaseRequest>((value) => {
        requireModelRequest(value);
        return value !== null && typeof value === 'object' && Object.keys(value).every((key) => ['messages', 'maxTokens', 'temperature'].includes(key));
      }),
      catalog: z.string().min(1),
      maxModelCalls: z.number().int().min(1).max(32),
      waitMs: z.number().int().min(0).max(2147483647),
      budgets: z.strictObject({ maxReplyBytes: z.number().int().min(1).max(2097152), maxFeedbackBytes: z.number().int().min(1).max(2097152), maxRequestBytes: z.number().int().min(1).max(2097152), maxWireRequestBytes: z.number().int().min(1).max(2097152), maxCollectionBytes: z.number().int().min(1).max(134217728) }).readonly(),
    })
    .readonly(),
);
const deps = { exchanges: ModelExchangeResource.request(), model: ToolModelResource.request() };
type ResourceValues = ResourcesOf<typeof deps>;
type Work = GroupWork<ToolLoopInput, string, ResourceValues, ChildCallable, string> | ResumeWork<'group', ToolLoopInput, string, ResourceValues, ChildCallable, string>;
type RestoredWork = ResumeWork<'group', ToolLoopInput, string, ResourceValues, ChildCallable, string>;
type Refs = Readonly<Record<string, readonly ChildReference<ChildCallable>[] | CheckpointSelection<ChildCallable>>>;
type RestoredRefs = Readonly<Record<string, readonly ChildReference<ChildCallable>[]>>;
type Slots = Readonly<Record<string, ChildReferenceSlot<ChildCallable, true>>>;
interface State {
  readonly exchanges: readonly ExchangeReference[];
  readonly current: ExchangeReference | null;
  readonly cursor: number;
  readonly active: { readonly name: string; readonly index: number; readonly callId: string } | null;
}
const stateCodec = codec<State>(z.strictObject({ exchanges: z.array(refSchema).readonly(), current: refSchema.nullable(), cursor: z.number().int().nonnegative(), active: z.strictObject({ name: z.string(), index: z.number().int().nonnegative(), callId: z.string() }).readonly().nullable() }).readonly());
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

/** A normal Group preset. Only its optional checkpoint mode requires recoverable tools. */
export class ToolLoop extends Group<ToolLoopInput, string, ResourceValues, string> {
  readonly catalog: ToolCatalog;
  readonly maxModelCalls: number;
  readonly waitMs: number;
  readonly recoverable: boolean;
  readonly budgets: ToolByteBudgets;
  /** Exact structure identities for optional host stage projection, independent of recording. */
  readonly stages: { readonly model: string; readonly tools: readonly { readonly structureId: string; readonly name: string }[] };
  readonly checkToolCall: (call: ModelToolCall) => ToolSelection;

  constructor(options: ToolLoopOptions) {
    super({
      name: 'native-tool-loop',
      deps,
      output: {
        result: (value) => {
          if (typeof value !== 'string' || !value.trim()) throw new TypeError('ToolLoop final answer must be nonempty');
          return value;
        },
        delta: (value) => {
          if (typeof value !== 'string') throw new TypeError('ToolLoop output must be text');
          return value;
        },
      },
    });
    this.maxModelCalls = options.maxModelCalls ?? 8;
    this.waitMs = options.waitMs ?? 30_000;
    this.recoverable = options.checkpoint === true;
    this.budgets = resolveToolBudgets(options.budgets);
    if (!Number.isSafeInteger(this.maxModelCalls) || this.maxModelCalls < 1 || this.maxModelCalls > 32) throw new RangeError('Tool model budget must be within 1..32');
    if (!Number.isSafeInteger(this.waitMs) || this.waitMs < 0 || this.waitMs > 2147483647) throw new RangeError('Tool wait must be a nonnegative timer duration');
    const entries = toolEntries(options.tools, this.recoverable);
    this.checkToolCall = (call) => selectTool(entries, call);
    Object.defineProperty(this, 'checkToolCall', { value: this.checkToolCall, enumerable: false, writable: false, configurable: false });
    const catalog = (this.catalog = createToolCatalog(entries, options.policyVersion));
    for (const name of ['catalog', 'maxModelCalls', 'waitMs', 'recoverable', 'budgets'] as const) Object.defineProperty(this, name, { value: this[name], enumerable: true, writable: false, configurable: false });
    const budgets = this.budgets;
    const completion = createToolCompletion(this.recoverable, budgets);
    this.stages = Object.freeze({ model: completion.id, tools: Object.freeze(entries.map((entry) => Object.freeze({ structureId: entry.registration.node.id, name: entry.name }))) });
    Object.defineProperty(this, 'stages', { value: this.stages, enumerable: true, writable: false, configurable: false });
    const tools = new Map(entries.map((entry) => [entry.name, entry]));
    const modelReception = reception(completion, intakeCodec);
    const toolReceptions = new Map(entries.map((entry) => [entry.name, reception(entry.registration.node, feedbackCodec)]));
    const slots: Slots = Object.freeze(Object.fromEntries([['models', childReferences(completion)], ...entries.map((entry) => [entry.name, childReferences(entry.registration.node)])]));
    const members: readonly ChildCallable[] = Object.freeze([completion, ...entries.map((entry) => entry.registration.node)]);
    this.add(...members);
    const maxModelCalls = this.maxModelCalls;
    const waitMs = this.waitMs;
    const recoverable = this.recoverable;
    const point = checkpointPoint<'group', ToolLoopInput, string, string>();
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
        run: (work, state, refs) => {
          confirmExchanges(work, state, refs);
          return finalText(work, state);
        },
      },
    });
    if (recoverable) this.checkpoint = { key: 'conversation.tools.loop', version: 2, input: toolLoopInputCodec, output: stringCodec, receptions: [modelReception, ...toolReceptions.values()], points: [waiting, processing, completed] };
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
    const modelFact = (facts: CheckpointFacts<ToolLoopInput>['children'], ref: ChildReference) => facts.require(completion, ref);
    function check(state: State, facts: CheckpointFacts<ToolLoopInput, Slots>) {
      if (facts.input.catalog !== catalog.digest || facts.input.maxModelCalls !== maxModelCalls || facts.input.waitMs !== waitMs || !equal(facts.input.budgets, budgets)) throw new Error('ToolLoop fixed catalog or budgets changed');
      const models = facts.references.models;
      if (!models || facts.children.values().length !== Object.values(facts.references).reduce((sum, values) => sum + values.length, 0)) throw new Error('ToolLoop checkpoint omitted child relations');
      if (models.length !== state.exchanges.length + 1 || models.length > maxModelCalls) throw new Error('ToolLoop model prefix changed');
      models.forEach((fact, index) => {
        const child = modelFact(facts.children, fact.ref);
        if (!equal(child.input, { exchanges: state.exchanges.slice(0, index) })) throw new Error('Model input differs from fixed exchange prefix');
        const expected = state.exchanges[index];
        if (expected) {
          const receipt = facts.children.accepted(child.ref, modelReception);
          if (receipt.reference.collection !== expected.collection || receipt.reference.id !== expected.id) throw new Error('Model reception differs from exchange prefix');
        }
      });
      if (!state.current) {
        if (state.active || state.cursor !== 0) throw new Error('Waiting model has tool progress');
        return;
      }
      const latest = models.at(-1);
      if (!latest) throw new Error('Current exchange lacks its model');
      const child = modelFact(facts.children, latest.ref);
      const received = facts.children.accepted(child.ref, modelReception);
      if (state.current.collection !== received.reference.collection || state.current.id !== received.reference.id || child.returned?.status !== 'succeeded') throw new Error('Current exchange differs from accepted model');
      const calls = child.returned.output.output.filter((item) => item.kind === 'tool-call');
      if (state.cursor > calls.length) throw new Error('Tool cursor exceeds model requests');
      for (let index = 0; index < state.cursor; index++) {
        const call = calls[index]!;
        const selected = selectTool(entries, call);
        if (selected.kind === 'rejected') continue;
        const found = facts.references[selected.entry.name]?.find((fact) => fact.order > child.order && fact.key === call.id && equal(fact.input, selected.input));
        if (!found) throw new Error('Processed tool has no exact child');
        const receipt = found.reception.status === 'accepted' ? facts.children.accepted(found.ref, toolReception(selected.entry.name)) : facts.children.handled(found.ref, toolReception(selected.entry.name));
        if (receipt.reference.collection !== state.current.collection || receipt.reference.id !== state.current.id) throw new Error('Tool receipt belongs to another exchange');
      }
      if (state.active) {
        const call = calls[state.cursor];
        const relation = facts.references[state.active.name]?.[state.active.index];
        const selected = call && selectTool(entries, call);
        if (!call || selected?.kind !== 'accepted' || selected.entry.name !== state.active.name || call.id !== state.active.callId || !relation || relation.order <= child.order || relation.key !== call.id || !equal(relation.input, selected.input)) throw new Error('Active tool differs from fixed model request');
      }
    }
    async function receiveModel(work: Work, state: State, refs: Refs, child: ChildCall<typeof completion>): Promise<string> {
      const result = { succeeded: (reply: ModelReply) => work.resources.exchanges.intake(assertToolReplyBytes(reply, budgets)) };
      const received = recoverable ? await child.invoke({ reception: modelReception, result }) : await child.invoke({ result });
      const next: State = { ...state, current: received.reference, cursor: 0, active: null };
      save(work, 'processing', next, refs);
      return processTools(work, next, refs);
    }
    function startModel(work: Work, state: State, refs: Refs): Promise<string> {
      const models = refsAt(refs, 'models');
      if (models.length >= maxModelCalls) throw new Error('ToolLoop model call budget exhausted');
      work.resources.exchanges.closed(state.exchanges);
      const child = work.children.create(completion, { exchanges: state.exchanges }, { key: `model:${models.length}` });
      const nextRefs = append(refs, 'models', child.ref);
      save(work, 'waiting', state, nextRefs);
      return receiveModel(work, state, nextRefs, child);
    }
    function resumeModel(work: RestoredWork, state: State, saved: RestoredRefs): Promise<string> {
      const refs = selections(work, saved);
      confirmExchanges(work, state, refs);
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
        succeeded: async (value: unknown) => {
          if (entry.registration.maxOutputBytes !== undefined) assertToolOutputBytes(value, entry.registration.maxOutputBytes);
          const mapped = assertToolFeedbackBytes(active.callId, await entry.registration.result.succeeded(value), budgets);
          return work.resources.exchanges.receive(reference, active.callId, mapped);
        },
        ...(entry.registration.result.failed
          ? {
              failed: async (failure: unknown) => {
                // This preset stops on its own budget failures. This is not a new
                // kernel error category and a matching business code is not enough.
                if (failure instanceof ToolBudgetError) throw failure;
                return work.resources.exchanges.receive(reference, active.callId, assertToolFeedbackBytes(active.callId, await entry.registration.result.failed!(failure), budgets));
              },
            }
          : {}),
      };
      const receipt = recoverable ? await child.invoke({ reception: toolReception(active.name), result }) : await child.invoke({ result });
      const next: State = { ...state, current: receipt.reference, cursor: state.cursor + 1, active: null };
      save(work, 'processing', next, refs);
      return processTools(work, next, refs);
    }
    function resumeTools(work: RestoredWork, state: State, saved: RestoredRefs): Promise<string> {
      const refs = selections(work, saved);
      confirmExchanges(work, state, refs);
      if (!state.active) return processTools(work, state, refs);
      const ref = referenceAt(refs, state.active.name, state.active.index);
      const fact = work.children.facts.get(ref);
      if (fact.reception.status === 'accepted' || fact.reception.status === 'handled') {
        const receipt = fact.reception.status === 'accepted' ? work.children.facts.accepted(ref, toolReception(state.active.name)) : work.children.facts.handled(ref, toolReception(state.active.name));
        return processTools(work, { ...state, current: receipt.reference, cursor: state.cursor + 1, active: null }, refs);
      }
      return receiveTool(work, state, refs, work.children.resume(ref));
    }
    function confirmExchanges(work: RestoredWork, state: State, refs: Refs) {
      work.resources.exchanges.closed(state.exchanges);
      Array.from(refsAt(refs, 'models')).forEach((ref, index, modelRefs) => {
        const fact = modelFact(work.children.facts, ref);
        if (fact.reception.status !== 'accepted') return;
        const receipt = work.children.facts.accepted(fact.ref, modelReception);
        const entry = work.resources.exchanges.read(receipt.reference);
        assertToolReplyBytes(entry.reply, budgets);
        if (fact.returned?.status !== 'succeeded' || !equal(entry.reply, fact.returned.output) || !equal(entry.operation, receipt.operation)) throw new Error('Exchange differs from original model return or reception');
        const next = modelRefs[index + 1];
        const end = next ? work.children.facts.get(next).order : Infinity;
        for (const feedback of entry.feedback) {
          assertToolFeedbackBytes(feedback.toolCallId, { status: feedback.status, content: feedback.content }, budgets);
          const call = entry.reply.output.find((item) => item.kind === 'tool-call' && item.id === feedback.toolCallId);
          if (!call || call.kind !== 'tool-call') throw new Error('Feedback has no original model call');
          const selected = selectTool(entries, call);
          if (selected.kind === 'rejected') {
            if (!equal(feedback, { toolCallId: call.id, ...selected.result })) throw new Error('Precheck feedback differs from fixed policy');
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
      });
    }
    function finalText(work: Work, state: State): string {
      if (!state.current) throw new Error('Missing final model exchange');
      const reply = work.resources.exchanges.read(state.current).reply;
      if (reply.termination.kind !== 'completed') throw new Error('Incomplete model reply cannot finish ToolLoop');
      const text = modelReplyText(reply);
      if (!text.trim()) throw new Error('ToolLoop final answer is empty');
      return text;
    }
    async function processTools(work: Work, initial: State, refs: Refs): Promise<string> {
      let state = initial;
      if (!state.current) throw new Error('Missing model exchange');
      const entry = work.resources.exchanges.read(state.current);
      if (entry.reply.termination.kind !== 'completed') throw new Error('Incomplete model reply cannot execute tools');
      const calls = entry.reply.output.filter((item) => item.kind === 'tool-call');
      if (!calls.length) {
        const value = finalText(work, state);
        save(work, 'completed', state, refs);
        return value;
      }
      await work.resources.model.preflight({ exchanges: state.exchanges, current: state.current });
      while (state.cursor < calls.length) {
        const call = calls[state.cursor]!;
        const selected = selectTool(entries, call);
        if (selected.kind === 'rejected') {
          const current = work.resources.exchanges.complete(state.current!, call.id, assertToolFeedbackBytes(call.id, selected.result, budgets));
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
      work.resources.exchanges.closed(exchanges);
      return startModel(work, { exchanges, current: null, cursor: 0, active: null }, refs);
    }
    this.run = (work) => {
      this.checkInput(work.input);
      return startModel(work, { exchanges: [], current: null, cursor: 0, active: null }, selections(work));
    };
  }

  input(request: ToolBaseRequest, scope: string = randomUUID(), collection?: string): ToolLoopInput {
    return toolLoopInputCodec.decode(cloneCheckpointValue({ scope, ...(collection === undefined ? {} : { collection }), request, catalog: this.catalog.digest, maxModelCalls: this.maxModelCalls, waitMs: this.waitMs, budgets: this.budgets }));
  }
  checkInput(input: ToolLoopInput): ToolLoopInput {
    toolLoopInputCodec.encode(input);
    if (input.catalog !== this.catalog.digest || input.maxModelCalls !== this.maxModelCalls || input.waitMs !== this.waitMs || !equal(input.budgets, this.budgets)) throw new Error('ToolLoop fixed catalog or budgets changed');
    return input;
  }
}
export function createToolLoop(options: ToolLoopOptions): ToolLoop {
  return new ToolLoop(options);
}
