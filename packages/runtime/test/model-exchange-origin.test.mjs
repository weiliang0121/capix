import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { ModelExchanges, ModelExchangeResource } from '@weiliang0121/capix-model-exchanges';
import { requireModelRequest, requireModelReply } from '@weiliang0121/capix-model-provider';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Scene, Group, Node, Resources, Runner, Interactions, reception, checkpointPoint, childReference } from '@weiliang0121/capix-runtime';

const codec = { encode: (value) => value, decode: (value) => value };
const tools = [{ name: 'lookup', description: 'Read a local source', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }];
const contract = { key: 'framework.origin-model.v1', request: requireModelRequest, reply: requireModelReply };
const reply = (id, output) => ({ formatVersion: 1, id, model: 'offline-fixture', output, termination: { kind: 'completed', reason: output.some((item) => item.kind === 'tool-call') ? 'tool_calls' : 'stop' }, usage: null, native: { format: 'chat-completions', version: 1 } });
const firstReply = reply('tool-reply', [{ kind: 'tool-call', id: 'lookup-1', name: 'lookup', arguments: { encoding: 'json-text', text: '{"key":"first-argument"}' } }]);
const finalReply = reply('final-reply', [{ kind: 'text', text: 'finished' }]);
const toolResult = { status: 'ok', content: [{ kind: 'text', text: 'source:first-argument' }] };

// The host persists interaction state; no real model or external service is called.
function interactionHost(states = new Map(), sent = []) {
  const interactions = new Interactions().register(contract, {
    send(request) {
      sent.push(structuredClone(request));
      return request.exchanges.length === 0 ? firstReply : finalReply;
    },
    persistence: {
      create(state) {
        states.set(state.id, structuredClone(state));
      },
      commit({ expectedRevision, state }) {
        assert.equal(states.get(state.id).revision, expectedRevision);
        states.set(state.id, structuredClone(state));
      },
      read: (id) => states.get(id),
    },
  });
  return { interactions, states, sent };
}

// Record physical saves before finish, then replay into a fresh store rather than
// sharing hot invocation facts or mutating a terminal checkpoint into a live one.
function checkpointJournal() {
  const memory = new MemoryCheckpointStore();
  const saves = [];
  let contextId;
  return {
    saves,
    get contextId() {
      return contextId;
    },
    store: {
      read: (id) => memory.read(id),
      save(commit, revision) {
        const receipt = memory.save(commit, revision);
        saves.push({ commit: structuredClone(commit), revision });
        contextId = receipt.contextId;
        return receipt;
      },
      finish: (...args) => memory.finish(...args),
    },
    replay() {
      const fresh = new MemoryCheckpointStore();
      for (const { commit, revision } of saves) fresh.save(commit, revision);
      return fresh;
    },
  };
}

function assembly(entity, host, store, { catalogDigest = 'lookup-schema-v1', source = (key) => `source:${key}` } = {}) {
  let modelRuns = 0;
  let toolRuns = 0;
  let sourceReads = 0;
  let acceptances = 0;
  const prefixes = [];
  const escaped = [];
  const channel = host.interactions.bind(contract);
  // Expansion belongs to the sending boundary. Child input contains only refs.
  const transport = new ResourceOffer({
    name: 'origin-model-transport',
    expose: (boundChannel, activity) => ({
      send(prefix) {
        return activity.runAsync('send', {}, async () => {
          prefixes.push(prefix);
          const interaction = boundChannel.start(entity.request(prefix));
          const result = await boundChannel.wait(interaction, { waitMs: 1000 });
          if (result.kind === 'unavailable') throw result.error;
          assert.equal(result.kind, 'received');
          return { interaction, reply: result.feedback.payload };
        });
      },
    }),
  });
  const sourceOffer = new ResourceOffer({
    name: 'local-source',
    methods: {
      read(origin, key) {
        sourceReads++;
        return origin(key);
      },
    },
  });
  const model = new Node({
    deps: { model: transport.request() },
    run(work) {
      modelRuns++;
      return work.resources.model.send(work.input);
    },
  });
  const lookup = new Node({
    deps: { source: sourceOffer.request() },
    async run(work) {
      toolRuns++;
      const content = await work.resources.source.read(work.input.key);
      assert.equal(content, toolResult.content[0].text);
      return { status: 'ok', content: [{ kind: 'text', text: content }] };
    },
  });
  const tool = new Group().add({ lookup });
  tool.run = (work) => work.children.lookup.invoke(work.input);
  const modelAccepted = reception(model, {
    ...codec,
    check(value) {
      assert.ok(value.receipt.operation.childContextId);
    },
  });
  const toolAccepted = reception(tool, {
    ...codec,
    check(value) {
      assert.ok(value.operation.childContextId);
    },
  });
  // This fixture supplies the host qualification policy explicitly: the kernel
  // authenticates child facts, while the host checks catalog and interaction evidence.
  const validate = (state, facts) => {
    const origin = entity.origin(state.origin);
    assert.equal(origin.catalog.digest, catalogDigest, 'saved catalog must match the executing structure');
    assert.equal(origin.catalog.policyVersion, 'fixture-policy-v1');
    const history = entity.closed(state.origin, state.exchanges);
    assert.equal(history.length, 2);
    for (const [index, name] of ['first', 'second'].entries()) {
      const fact = facts.references[name];
      const accepted = fact.reception.value;
      assert.deepEqual(entity.read(state.origin, accepted.receipt.reference, false).reply, fact.returned.output.reply);
      assert.deepEqual(history[index].operation, accepted.receipt.operation);
      assert.deepEqual(fact.input.origin, state.origin);
      assert.deepEqual(Object.keys(fact.input).sort(), ['exchanges', 'origin']);
      assert.equal(fact.input.exchanges.length, index);
      const interactionRef = fact.returned.output.interaction;
      const evidence = channel.read(interactionRef);
      assert.equal(evidence.kind, 'received', 'original interaction must have durable feedback');
      assert.deepEqual(evidence.feedback.payload, history[index].reply);
      assert.deepEqual(host.states.get(interactionRef.id).request, entity.request(fact.input));
    }
    assert.deepEqual(history[0].feedback, [{ toolCallId: 'lookup-1', ...toolResult }]);
    assert.deepEqual(history[0].receptions[0].operation, facts.references.tool.reception.value.operation);
  };
  const point = checkpointPoint()({
    name: 'model-completed',
    state: codec,
    references: { first: childReference(model), tool: childReference(tool), second: childReference(model) },
    check: validate,
    resume: {
      run(_work, state) {
        assert.equal(modelRuns, 0);
        assert.equal(toolRuns, 0);
        assert.equal(sourceReads, 0);
        assert.equal(acceptances, 0);
        return { origin: state.origin, exchanges: state.exchanges, text: 'finished' };
      },
    },
  });
  const scene = new Scene({
    deps: { exchanges: ModelExchangeResource.request() },
    checkpoint: { key: 'framework-origin-loop', version: 1, input: codec, output: codec, receptions: [modelAccepted, toolAccepted], points: [point] },
  }).add({ model, tool });
  scene.run = async (work) => {
    const endpoint = work.resources.exchanges;
    escaped.push(endpoint);
    const origin = endpoint.begin(randomUUID(), {
      request: {
        messages: [
          { role: 'system', content: 'fixed-system' },
          { role: 'user', content: work.input.text },
        ],
        temperature: 0,
      },
      catalog: { tools, digest: catalogDigest, policyVersion: 'fixture-policy-v1' },
    });
    const first = work.children.create(model, { origin, exchanges: [] });
    const intake = (value) => {
      acceptances++;
      return { receipt: endpoint.intake(origin, value.reply), interaction: value.interaction };
    };
    const initial = await first.invoke({ reception: modelAccepted, result: { succeeded: intake } });
    const call = endpoint.read(origin, initial.receipt.reference).reply.output[0];
    const toolCall = work.children.create(tool, JSON.parse(call.arguments.text));
    const feedback = await toolCall.invoke({
      reception: toolAccepted,
      result: {
        succeeded: (result) => {
          acceptances++;
          return endpoint.receive(origin, initial.receipt.reference, call.id, result);
        },
      },
    });
    const second = work.children.create(model, { origin, exchanges: [feedback.reference] });
    const final = await second.invoke({ reception: modelAccepted, result: { succeeded: intake } });
    const state = { origin, exchanges: [feedback.reference, final.receipt.reference] };
    work.checkpoint({ point, state, refs: { first: first.ref, tool: toolCall.ref, second: second.ref } });
    return { ...state, text: 'finished' };
  };
  const resources = new Resources().register(new Resource(entity), ModelExchangeResource).register(new Resource(source), sourceOffer).registerInteraction(transport, contract);
  const runner = new Runner(scene, resources, host.interactions, { checkpoints: { store } }).build();
  return { runner, prefixes, escaped, counts: () => ({ modelRuns, toolRuns, sourceReads, acceptances }) };
}

test('direct entity resources need no capture: build is inert and repeated runs keep origins and capabilities separate', async () => {
  const commits = [];
  const entity = new ModelExchanges({
    persistence: {
      commit(change) {
        commits.push(change);
      },
    },
  });
  const host = interactionHost();
  const fixture = assembly(entity, host, new MemoryCheckpointStore());
  assert.equal(entity.sequence, 0);
  assert.equal(commits.length, 0);
  assert.equal(host.sent.length, 0);
  assert.deepEqual(fixture.counts(), { modelRuns: 0, toolRuns: 0, sourceReads: 0, acceptances: 0 });
  const first = await fixture.runner.run({ text: 'initial-A' });
  const second = await fixture.runner.run({ text: 'initial-B' });
  assert.notEqual(first.origin.id, second.origin.id);
  assert.equal(host.sent.length, 4);
  for (const [offset, text] of [
    [0, 'initial-A'],
    [2, 'initial-B'],
  ]) {
    assert.deepEqual(host.sent[offset], {
      messages: [
        { role: 'system', content: 'fixed-system' },
        { role: 'user', content: text },
      ],
      temperature: 0,
      tools,
      exchanges: [],
    });
    assert.deepEqual(host.sent[offset + 1], { ...host.sent[offset], exchanges: [{ reply: firstReply, feedback: [{ toolCallId: 'lookup-1', ...toolResult }] }] });
  }
  for (const prefix of fixture.prefixes) assert.deepEqual(Object.keys(prefix).sort(), ['exchanges', 'origin']);
  assert.equal(entity.snapshot().formatVersion, 2);
  assert.equal(entity.snapshot().origins.length, 2);
  assert.equal(entity.snapshot().entries.length, 4);
  assert.throws(() => entity.closed(second.origin, first.exchanges), /origin|mismatch/i);
  assert.throws(() => fixture.escaped[0].origin(first.origin));
  assert.deepEqual(fixture.counts(), { modelRuns: 4, toolRuns: 2, sourceReads: 2, acceptances: 6 });
  await host.interactions.settled();
  host.interactions.close();
});

test('fresh Runner and checkpoint store resume a completed model child with saved origin and nonempty history without resend', async () => {
  const entity = new ModelExchanges();
  const host = interactionHost();
  const journal = checkpointJournal();
  const original = assembly(entity, host, journal.store);
  const expected = await original.runner.run({ text: 'restart-input' });
  await host.interactions.settled();
  host.interactions.close();
  const restored = ModelExchanges.restore(structuredClone(entity.snapshot()));
  const nextHost = interactionHost(new Map(host.states));
  const next = assembly(restored, nextHost, journal.replay());
  assert.deepEqual(await next.runner.resume(journal.contextId), expected);
  assert.deepEqual(nextHost.sent, []);
  assert.deepEqual(next.counts(), { modelRuns: 0, toolRuns: 0, sourceReads: 0, acceptances: 0 });
  assert.deepEqual(restored.snapshot(), entity.snapshot());
  nextHost.interactions.close();

  for (const variant of ['missing-origin', 'wrong-catalog', 'missing-interaction', 'wrong-interaction-feedback']) {
    const evidence = interactionHost(variant === 'missing-interaction' ? new Map() : new Map(host.states));
    if (variant === 'wrong-interaction-feedback') {
      for (const [id, state] of evidence.states) evidence.states.set(id, { ...state, feedback: { ...state.feedback, payload: finalReply } });
    }
    const restoredEntity = variant === 'missing-origin' ? new ModelExchanges() : ModelExchanges.restore(entity.snapshot());
    const candidate = assembly(restoredEntity, evidence, journal.replay(), { catalogDigest: variant === 'wrong-catalog' ? 'changed-schema' : 'lookup-schema-v1' });
    await assert.rejects(candidate.runner.resume(journal.contextId), variant === 'wrong-interaction-feedback' ? assert.AssertionError : /origin|catalog|interaction|unknown|not found/i, variant);
    assert.deepEqual(evidence.sent, [], `${variant} must not probe by sending`);
    assert.deepEqual(candidate.counts(), { modelRuns: 0, toolRuns: 0, sourceReads: 0, acceptances: 0 });
    evidence.interactions.close();
  }
});
