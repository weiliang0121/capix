import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import { Scene, Group, Node, checkpointPoint, childReference, childReferences, reception } from '@weiliang0121/capix-structure';
import { ExchangeResource, feedbackDigest } from './exchanges.mjs';
import { validateReply, encodeHistory } from './protocol.mjs';
import { precheck, rejection, validateCatalog } from './catalog.mjs';
import { fixed } from './value.mjs';
import { toolEntries, toolCatalog } from './tools.mjs';
import { waitToolFeedback } from './wait.mjs';

const codec = (schema) => ({ encode: (value) => schema.parse(value), decode: (value) => schema.parse(value) });
const reference = z.strictObject({ collection: z.string().min(1), id: z.string().min(1), revision: z.number().int().nonnegative() });
const requestInput = codec(z.strictObject({ exchanges: z.array(reference) }));
const operation = z.strictObject({ parentContextId: z.string().min(1), childContextId: z.string().min(1), position: z.string() });
const modelReceipt = z.strictObject({ reference, operation });
const toolReceipt = z.strictObject({ reference, operation, feedbackDigest: z.string() });
const inputCodec = codec(z.strictObject({ scope: z.string().min(1), materials: z.string(), catalog: z.string().min(1), maxModelCalls: z.number().int().min(1).max(32), waitMs: z.number().int().min(0).max(60000) }));
const interactionRef = codec(z.strictObject({ id: z.string().min(1), contract: z.literal('example.native-tools.model.v1') }));
const replyCodec = { encode: validateReply, decode: validateReply };
const text = (value) => {
  if (typeof value !== 'string') throw new TypeError('Expected text');
  return value;
};
const textCodec = { encode: text, decode: text };

export const ModelContract = Object.freeze({ key: 'example.native-tools.model.v1', request: fixed, reply: validateReply });

/** Expanding the request happens inside this resource, never in a child input. */
export const LoopModelResource = new ResourceOffer({
  name: 'example.native-tools.model',
  methods: {
    start({ channel, input, exchanges, catalog }, next) {
      if (input.catalog !== catalog.digest) throw new Error('Tool catalog differs from fixed input');
      const history = exchanges.closed(input.scope, next.exchanges);
      const request = {
        messages: [{ role: 'user', content: input.materials }, ...history.flatMap((entry) => encodeHistory(entry.reply, entry.feedback))],
        tools: catalog.snapshot.entries.map((entry) => ({ type: 'function', function: { name: entry.name, description: entry.description, parameters: entry.schema } })),
      };
      return channel.start(request);
    },
    wait({ channel, input }, ref, operation) {
      return waitToolFeedback(channel, ref, operation, input.waitMs);
    },
  },
});

function completionNode(write) {
  const deps = { model: LoopModelResource.request() };
  const established = checkpointPoint()({ name: 'established', state: interactionRef, references: {}, resume: { deps, run: receive } });
  const completed = checkpointPoint()({ name: 'completed', state: replyCodec, references: {}, resume: { run: (_work, reply) => reply } });
  async function receive(work, ref) {
    const reply = await work.resources.model.wait(ref);
    write(work, { point: completed, state: reply, refs: {} });
    return reply;
  }
  return new Node({
    name: 'native-model',
    deps,
    checkpoint: { key: 'example.native-tools.completion', version: 1, input: requestInput, output: replyCodec, points: [established, completed] },
    async run(work) {
      const ref = await work.resources.model.start(work.input);
      write(work, { point: established, state: ref, refs: {} });
      return receive(work, ref);
    },
  });
}

/** Finite example, deliberately not a general agent scheduler. */
export function createToolScene(registrations, { policyVersion, catalog: suppliedCatalog, maxModelCalls = 8, waitMs = 5000, write = (work, value) => work.checkpoint(value) } = {}) {
  if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 32) throw new Error('Model budget must be within 1..32');
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw new Error('Wait budget must be within 0..60000');
  if (policyVersion === undefined) throw new TypeError('Tool feedback and precheck policy require an explicit version');
  const entries = toolEntries(registrations);
  const declaredCatalog = toolCatalog(entries, policyVersion);
  const catalog = suppliedCatalog ? validateCatalog(suppliedCatalog, declaredCatalog) : declaredCatalog;
  const completion = completionNode(write);
  const tools = Object.fromEntries(entries.map(({ name, registration }) => [name, registration.node]));
  const registered = Object.fromEntries(entries.map(({ name, registration }) => [name, registration]));
  function select(call) {
    const selected = precheck(catalog, call);
    if (selected.kind === 'rejected') return selected;
    try {
      const parsed = fixed(registered[selected.name].input.parse(selected.input));
      if (!equal(parsed, selected.input)) throw new TypeError('Tool input parser must preserve the fixed model argument values');
      return { ...selected, input: parsed };
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      return rejection(call.id, 'INVALID_ARGUMENTS', 'Tool arguments do not match the registered schema.');
    }
  }
  const deps = { exchanges: ExchangeResource.request() };
  const modelReception = reception(completion, { ...codec(modelReceipt), check: (value) => modelReceipt.parse(value) });
  const toolReceptions = Object.fromEntries(Object.entries(tools).map(([name, node]) => [name, reception(node, { ...codec(toolReceipt), check: (value) => toolReceipt.parse(value) })]));
  const slots = { models: childReferences(completion), ...Object.fromEntries(Object.entries(tools).map(([name, node]) => [name, childReferences(node)])) };
  const stateCodec = codec(z.strictObject({ catalog: z.string(), exchanges: z.array(reference), current: reference.nullable(), cursor: z.number().int().nonnegative(), active: z.strictObject({ name: z.string().refine((name) => Object.hasOwn(tools, name), 'Tool is not registered'), index: z.number().int().nonnegative(), callId: z.string() }).nullable() }));
  const uses = [completion, ...Object.values(tools)];

  function check(state, facts) {
    if (facts.input.waitMs !== waitMs) throw new Error('Wait budget changed before restoration');
    if (facts.input.maxModelCalls !== maxModelCalls) throw new Error('Model budget changed before restoration');
    if (state.catalog !== catalog.digest || facts.input.catalog !== catalog.digest) throw new Error('Tool catalog changed before restoration');
    if (facts.children.values().length !== Object.values(facts.references).reduce((sum, values) => sum + values.length, 0)) throw new Error('Checkpoint omitted a child relation');
    for (let index = 0; index < facts.references.models.length; index++) {
      const child = facts.references.models[index];
      if (!equal(child.input, { exchanges: state.exchanges.slice(0, index) })) throw new Error('Model child input differs from fixed exchange prefix');
      if (index < state.exchanges.length) {
        const value = facts.children.accepted(child.ref, modelReception).reference;
        if (value.collection !== state.exchanges[index].collection || value.id !== state.exchanges[index].id) throw new Error('Exchange prefix differs from its accepted model');
      }
    }
    if (facts.references.models.length !== state.exchanges.length + 1 || facts.references.models.length > maxModelCalls) throw new Error('Model budget or exchange prefix changed');
    if (state.current) {
      const child = facts.references.models.at(-1);
      const current = facts.children.accepted(child.ref, modelReception).reference;
      if (state.current.collection !== current.collection || state.current.id !== current.id || child.returned?.status !== 'succeeded') throw new Error('Current exchange differs from its accepted model');
      const calls = child.returned.output.output.filter((item) => item.kind === 'tool-call');
      if (state.cursor > calls.length) throw new Error('Feedback cursor exceeds model requests');
      for (let index = 0; index < state.cursor; index++) {
        const call = calls[index];
        const selected = select(call);
        if (selected.kind === 'rejected') continue;
        const match = facts.references[selected.name].filter((fact) => fact.key === call.id && equal(fact.input, selected.input));
        // A call id is only local to a model exchange. Find its exact position
        // after this exchange's model relation, not an earlier matching id.
        const relation = match.find((fact) => fact.order > child.order);
        if (!relation) throw new Error('Processed tool has no exact child');
        const result = relation.reception.status === 'accepted' ? facts.children.accepted(relation.ref, toolReceptions[selected.name]) : facts.children.handled(relation.ref, toolReceptions[selected.name]);
        if (result.reference.collection !== current.collection || result.reference.id !== current.id) throw new Error('Tool reception belongs to another exchange');
      }
      if (state.active) {
        const call = calls[state.cursor];
        const relation = facts.references[state.active.name][state.active.index];
        const selected = call && select(call);
        if (!call || call.id !== state.active.callId || selected.kind !== 'accepted' || selected.name !== state.active.name || !relation || relation.order <= child.order || relation.key !== call.id || !equal(relation.input, selected.input)) throw new Error('Active tool does not match its fixed model request');
      }
    } else if (state.cursor !== 0 || state.active) throw new Error('A waiting model cannot have active tool progress');
  }
  const waiting = checkpointPoint()({ name: 'modelWaiting', state: stateCodec, references: slots, check, resume: { deps, uses, run: resumeModel } });
  const processing = checkpointPoint()({ name: 'tools', state: stateCodec, references: slots, check, resume: { deps, uses, run: resumeTools } });
  const done = checkpointPoint()({ name: 'completed', state: stateCodec, references: slots, check, resume: { deps, run: finish } });

  function accepted(work, ref, contract) {
    const fact = work.children.facts.get(ref);
    if (fact.reception.status === 'accepted') return work.children.facts.accepted(ref, contract);
    if (fact.reception.status === 'handled') return work.children.facts.handled(ref, contract);
    return undefined;
  }
  function save(work, point, state, refs) {
    write(work, { point, state, refs });
  }
  async function receiveModel(work, state, refs, child) {
    const current = await child.invoke({ reception: modelReception, result: { succeeded: (reply) => work.resources.exchanges.intake(reply) } });
    const next = { ...state, current: current.reference, cursor: 0, active: null };
    save(work, processing, next, refs);
    return processTools(work, next, refs);
  }
  function startModel(work, state, refs) {
    if (refs.models.length >= maxModelCalls) throw new Error('Tool loop model budget exhausted');
    work.resources.exchanges.closed(state.exchanges);
    const child = work.children.create(completion, { exchanges: state.exchanges }, { key: `model:${refs.models.length}` });
    const nextRefs = { ...refs, models: [...refs.models, child.ref] };
    save(work, waiting, state, nextRefs);
    return receiveModel(work, state, nextRefs, child);
  }
  function resumeModel(work, state, refs) {
    confirmExchanges(work, state, refs);
    const ref = refs.models.at(-1);
    const previous = accepted(work, ref, modelReception);
    if (previous) return processTools(work, { ...state, current: previous.reference, cursor: 0, active: null }, refs);
    return receiveModel(work, state, refs, work.children.resume(ref));
  }
  async function receiveTool(work, state, refs, child) {
    const entry = work.resources.exchanges.read(state.current);
    const call = entry.reply.output.filter((item) => item.kind === 'tool-call')[state.cursor];
    if (!call || state.active?.callId !== call.id) throw new Error('Tool call slot changed');
    const mapping = registered[state.active.name].result;
    const current = await child.invoke({
      reception: toolReceptions[state.active.name],
      result: {
        succeeded: async (value) => work.resources.exchanges.receive(state.current, call.id, await mapping.succeeded(value)),
        ...(mapping.failed ? { failed: async (failure) => work.resources.exchanges.receive(state.current, call.id, await mapping.failed(failure)) } : {}),
      },
    });
    const next = { ...state, current: current.reference, cursor: state.cursor + 1, active: null };
    save(work, processing, next, refs);
    return processTools(work, next, refs);
  }
  function resumeTools(work, state, refs) {
    confirmExchanges(work, state, refs);
    if (!state.active) return processTools(work, state, refs);
    const ref = refs[state.active.name][state.active.index];
    const previous = accepted(work, ref, toolReceptions[state.active.name]);
    if (previous) return processTools(work, { ...state, current: previous.reference, cursor: state.cursor + 1, active: null }, refs);
    return receiveTool(work, state, refs, work.children.resume(ref));
  }
  function confirmExchanges(work, state, refs) {
    work.resources.exchanges.closed(state.exchanges);
    const facts = work.children.facts;
    for (let index = 0; index < refs.models.length; index++) {
      const model = facts.get(refs.models[index]);
      if (model.reception.status !== 'accepted') continue;
      const receipt = facts.accepted(model.ref, modelReception);
      const entry = work.resources.exchanges.read(receipt.reference);
      if (model.returned?.status !== 'succeeded' || !equal(entry.reply, model.returned.output) || !equal(entry.operation, receipt.operation)) throw new Error('Exchange differs from its model return or intake provenance');
      const end = refs.models[index + 1] ? facts.get(refs.models[index + 1]).order : Infinity;
      for (const feedback of entry.feedback) {
        const call = entry.reply.output.find((item) => item.kind === 'tool-call' && item.id === feedback.toolCallId);
        const selected = select(call);
        if (selected.kind === 'rejected') {
          if (!equal(feedback, selected.feedback)) throw new Error('Precheck feedback differs from its fixed policy');
          continue;
        }
        const child = refs[selected.name].map((ref) => facts.get(ref)).find((fact) => fact.order > model.order && fact.order < end && fact.key === call.id && equal(fact.input, selected.input));
        if (!child) throw new Error('Feedback has no exact tool relation');
        const prior = accepted(work, child.ref, toolReceptions[selected.name]);
        if (!prior) continue; // A durable effect is not itself proof of parent reception.
        if (prior.reference.collection !== receipt.reference.collection || prior.reference.id !== receipt.reference.id || prior.feedbackDigest !== feedbackDigest(feedback) || !equal(prior.operation, entry.receptions.find((value) => value.callId === call.id)?.operation)) throw new Error('Feedback differs from its exact tool reception');
      }
    }
  }
  function finish(work, state, refs) {
    if (refs) confirmExchanges(work, state, refs);
    const entry = work.resources.exchanges.read(state.current);
    if (entry.reply.termination.kind !== 'completed' || entry.reply.output.some((item) => item.kind === 'tool-call')) throw new Error('Reply is not final text');
    const output = entry.reply.output.map((item) => item.text).join('');
    if (!output.trim()) throw new Error('Final reply is empty');
    return output;
  }
  async function processTools(work, initial, refs) {
    let state = initial;
    const entry = work.resources.exchanges.read(state.current);
    if (entry.reply.termination.kind !== 'completed') throw new Error('Incomplete model reply cannot execute tools');
    const calls = entry.reply.output.filter((item) => item.kind === 'tool-call');
    if (!calls.length) {
      const value = finish(work, state);
      save(work, done, state, refs);
      return value;
    }
    while (state.cursor < calls.length) {
      const call = calls[state.cursor];
      const checked = select(call);
      if (checked.kind === 'rejected') {
        const { status, content } = checked.feedback;
        const current = work.resources.exchanges.complete(state.current, call.id, { status, content });
        state = { ...state, current, cursor: state.cursor + 1 };
        save(work, processing, state, refs);
        continue;
      }
      const node = tools[checked.name];
      if (!node) throw new Error('Catalog member is not registered');
      const child = work.children.create(node, checked.input, { key: call.id });
      const active = { name: checked.name, index: refs[checked.name].length, callId: call.id };
      const nextRefs = { ...refs, [checked.name]: [...refs[checked.name], child.ref] };
      const next = { ...state, active };
      save(work, processing, next, nextRefs);
      return receiveTool(work, next, nextRefs, child);
    }
    const exchanges = [...state.exchanges, state.current];
    work.resources.exchanges.closed(exchanges);
    return startModel(work, { ...state, exchanges, current: null, cursor: 0, active: null }, refs);
  }

  const loop = new Group({ name: 'native-tools-loop', deps }).add({ completion, ...tools });
  loop.checkpoint = { key: 'example.native-tools.loop', version: 1, input: inputCodec, output: textCodec, receptions: [modelReception, ...Object.values(toolReceptions)], points: [waiting, processing, done] };
  loop.run = (work) => {
    inputCodec.encode(work.input);
    if (work.input.waitMs !== waitMs) throw new Error('Wait budget changed');
    if (work.input.maxModelCalls !== maxModelCalls) throw new Error('Model budget changed');
    if (work.input.catalog !== catalog.digest) throw new Error('Tool catalog changed');
    return startModel(work, { catalog: catalog.digest, exchanges: [], current: null, cursor: 0, active: null }, { models: [], ...Object.fromEntries(entries.map(({ name }) => [name, []])) });
  };
  const rootWaiting = checkpointPoint()({
    name: 'waiting',
    state: codec(z.strictObject({})),
    references: { loop: childReference(loop) },
    check: (_state, facts) => {
      if (facts.input.waitMs !== waitMs) throw new Error('Wait budget changed before restoration');
      if (facts.input.maxModelCalls !== maxModelCalls) throw new Error('Model budget changed before restoration');
      if (facts.input.catalog !== catalog.digest || !equal(facts.references.loop.input, facts.input)) throw new Error('Root catalog or original material changed');
    },
    resume: { uses: [loop], run: (work, _state, refs) => work.children.resume(refs.loop).invoke() },
  });
  const scene = new Scene({ name: 'native-tools-probe', checkpoint: { key: 'example.native-tools.scene', version: 1, input: inputCodec, output: textCodec, points: [rootWaiting] } }).add({ loop });
  scene.run = (work) => {
    const child = work.children.create(loop, work.input);
    write(work, { point: rootWaiting, state: {}, refs: { loop: child.ref } });
    return child.invoke();
  };
  return { scene, loop, catalog };
}
